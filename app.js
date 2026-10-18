import { createGuestId } from './guest-id.js';
import { liveAudioTracks, prepareDisplayAudioStream } from './capture-tracks.js';
import {
  decodePcm16Frame,
  encodePcm16Frame,
  MEDIA_RELAY_CHANNELS,
  MEDIA_RELAY_SAMPLE_RATE,
} from './media-relay.mjs';
import {
  DEFAULT_REWARDED_ACCESS_CONFIG,
  clearRewardedAccess,
  formatRewardedAccessRemaining,
  grantRewardedAccess,
  hasRewardedAccess,
  initializeAdSlots,
  normalizeRewardedAccessConfig,
  readRewardedAccessExpiry,
  runRewardedAccess,
} from './ads.mjs';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const guestStorageKey = 'roomsound-guest-id';
const guestId = localStorage.getItem(guestStorageKey) || createGuestId();
localStorage.setItem(guestStorageKey, guestId);

const notificationServiceWorkerUrl = '/notifications-sw.js?v=20261018-1';
const notificationActionMessageType = 'roomsound-notification-action';
const notificationReadyMessageType = 'roomsound-notification-ready';
const DEFAULT_MEDIA_RELAY_CONFIG = {
  enabled: true,
  mode: 'pcm16',
  sampleRate: MEDIA_RELAY_SAMPLE_RATE,
  channels: MEDIA_RELAY_CHANNELS,
};
const RELAY_FRAME_SAMPLES = 960; // 20 ms at 48 kHz

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.9;
  return Math.min(1, Math.max(0, n));
}

const state = {
  ws: null,
  room: null,
  self: null,
  members: [],
  requests: [],
  messages: [],
  activity: [],
  captureStream: null,
  captureType: null,
  captureLabel: null,
  audioContext: null,
  testOscillator: null,
  audioElement: null,
  audioNeedsGesture: false,
  mediaRelay: { ...DEFAULT_MEDIA_RELAY_CONFIG },
  relayCaptureStream: null,
  relayCaptureSource: null,
  relayProcessor: null,
  relaySink: null,
  relayPacketizer: null,
  relayCaptureEpoch: null,
  relaySequence: 0,
  relayPlaybackContext: null,
  relayPlaybackGain: null,
  relayPlaybackEpoch: null,
  relayPlaybackNextTime: 0,
  relayPlaybackSources: new Set(),
  relayLastSequence: null,
  relayUnavailableNotified: false,
  muted: false,
  volume: clampVolume(localStorage.getItem('roomsound-volume') ?? 0.9),
  peers: new Map(),
  pendingIntent: null,
  lastSourceId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  explicitLeave: false,
  lastRoomCode: null,
  lastDisplayName: null,
  captureNonce: 0,
  telemetry: new Map(),
  telemetryTimer: null,
  telemetryGeneration: 0,
  telemetryPollPromise: null,
  notificationRegistration: null,
  notificationSetupPromise: null,
  pendingNotificationActions: [],
  sentNotificationActions: new Set(),
  notificationUnavailableNotified: false,
  rewardedAccessConfig: DEFAULT_REWARDED_ACCESS_CONFIG,
  rewardedAccessExpiry: readRewardedAccessExpiry(),
  rewardedBusy: false,
  rewardedAccessTimer: null,
};

let rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
let iceConfigLoaded = false;
const telemetryPollMs = 1000;

function normalizeMediaRelayConfig(value) {
  if (value === undefined || value === null) return { ...DEFAULT_MEDIA_RELAY_CONFIG };
  const enabled = value?.enabled !== false
    && value?.mode === DEFAULT_MEDIA_RELAY_CONFIG.mode
    && Number(value?.sampleRate) === DEFAULT_MEDIA_RELAY_CONFIG.sampleRate
    && Number(value?.channels) === DEFAULT_MEDIA_RELAY_CONFIG.channels;
  return {
    ...DEFAULT_MEDIA_RELAY_CONFIG,
    enabled,
    mode: String(value?.mode || DEFAULT_MEDIA_RELAY_CONFIG.mode),
    sampleRate: Number(value?.sampleRate) || DEFAULT_MEDIA_RELAY_CONFIG.sampleRate,
    channels: Number(value?.channels) || DEFAULT_MEDIA_RELAY_CONFIG.channels,
  };
}

function isMediaRelayEnabled() {
  return state.mediaRelay.enabled
    && state.mediaRelay.mode === DEFAULT_MEDIA_RELAY_CONFIG.mode
    && state.mediaRelay.sampleRate === DEFAULT_MEDIA_RELAY_CONFIG.sampleRate
    && state.mediaRelay.channels === DEFAULT_MEDIA_RELAY_CONFIG.channels;
}

async function loadClientConfig() {
  if (iceConfigLoaded) return;
  try {
    const r = await fetch('/config');
    if (!r.ok) throw new Error('config fetch failed');
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) rtcConfig = { iceServers: j.iceServers };
    const wasMediaRelayEnabled = isMediaRelayEnabled();
    state.mediaRelay = normalizeMediaRelayConfig(j.mediaRelay);
    if (j.rewardedAccess) state.rewardedAccessConfig = normalizeRewardedAccessConfig(j.rewardedAccess);
    iceConfigLoaded = true;
    if (wasMediaRelayEnabled !== isMediaRelayEnabled() && state.captureStream && isSelfSource()) {
      closePeerConnections();
      if (isMediaRelayEnabled()) ensureRelayPublisher();
      else {
        stopRelayCapture();
        ensurePublisherConnections();
      }
    }
    renderRewardedAccess();
  } catch {
    // Keep default STUN and the offline demo reward when config is unavailable.
  }
}
loadClientConfig();

function rewardedAccessActive() {
  state.rewardedAccessExpiry = readRewardedAccessExpiry();
  return hasRewardedAccess({ now: Date.now() });
}

function renderRewardedAccess() {
  const gate = $('#rewarded-access');
  const status = $('#rewarded-access-state');
  const copy = $('#rewarded-access-copy');
  const button = $('#complete-rewarded-access');
  const progress = $('#rewarded-access-progress');
  const progressLabel = $('#rewarded-access-progress-label');
  const createButton = $('#create-room');
  const joinButton = $('#join-room');
  if (!gate || !status || !button || !createButton || !joinButton) return;

  const active = rewardedAccessActive();
  const config = state.rewardedAccessConfig;
  const duration = config.rewardDurationSeconds;
  if (state.rewardedAccessTimer) {
    clearTimeout(state.rewardedAccessTimer);
    state.rewardedAccessTimer = null;
  }
  if (active && state.rewardedAccessExpiry > Date.now()) {
    state.rewardedAccessTimer = setTimeout(() => {
      state.rewardedAccessTimer = null;
      expireRewardedAccess();
    }, Math.max(0, state.rewardedAccessExpiry - Date.now()) + 50);
  }
  gate.classList.toggle('access-active', active);
  status.textContent = active
    ? `Access active · ${formatRewardedAccessRemaining(state.rewardedAccessExpiry)}`
    : state.rewardedBusy
      ? 'Demo reward in progress…'
      : 'Access required';
  if (copy) copy.textContent = active
    ? 'Your local access pass is active. You can enter rooms anonymously.'
    : `Complete the ${duration}-second demo/local rewarded preview to unlock ${config.accessDurationHours} hours of room access.`;
  button.disabled = state.rewardedBusy || active || config.enabled === false;
  button.textContent = state.rewardedBusy
    ? `Completing demo reward…`
    : active
      ? 'Room access active'
      : `Start ${duration}-second demo reward`;
  createButton.disabled = !active || state.rewardedBusy;
  joinButton.disabled = !active || state.rewardedBusy;
  createButton.setAttribute('aria-disabled', String(!active || state.rewardedBusy));
  joinButton.setAttribute('aria-disabled', String(!active || state.rewardedBusy));
  if (progress) {
    progress.hidden = !state.rewardedBusy;
    progress.max = duration;
    progress.value = state.rewardedBusy ? Number(progress.dataset.remaining || duration) : 0;
  }
  if (progressLabel) progressLabel.textContent = state.rewardedBusy
    ? `${Number(progress?.dataset.remaining || duration)} seconds remaining`
    : '';
}

function expireRewardedAccess() {
  const hadRoom = Boolean(state.room || state.ws);
  const expiryMessage = 'Your six-hour room access expired. Watch another rewarded ad to continue.';
  clearRewardedAccess();
  state.rewardedAccessExpiry = null;
  if (hadRoom) {
    state.explicitLeave = true;
    state.lastRoomCode = null;
    if (state.ws?.readyState === WebSocket.OPEN) send({ type: 'leave-room' });
    else state.ws?.close();
    window.setTimeout(() => {
      if (state.room || state.ws) resetToLanding(expiryMessage);
    }, 150);
    toast(expiryMessage, 'error');
  }
  renderRewardedAccess();
}

async function completeRewardedAccess() {
  if (state.rewardedBusy || rewardedAccessActive()) return;
  state.rewardedBusy = true;
  const duration = state.rewardedAccessConfig.rewardDurationSeconds;
  const progress = $('#rewarded-access-progress');
  if (progress) progress.dataset.remaining = String(duration);
  renderRewardedAccess();
  try {
    const result = await runRewardedAccess(state.rewardedAccessConfig, {
      onTick: (remaining) => {
        if (progress) progress.dataset.remaining = String(remaining);
        renderRewardedAccess();
      },
    });
    if (!result?.completed) throw new Error('The rewarded preview did not complete.');
    const expiresAt = grantRewardedAccess({ config: state.rewardedAccessConfig });
    if (!expiresAt) throw new Error('This browser could not store local room access.');
    state.rewardedAccessExpiry = expiresAt;
    toast(`Room access is active for ${state.rewardedAccessConfig.accessDurationHours} hours.`, 'success');
  } catch (error) {
    toast(error?.message || 'The rewarded preview could not be completed.', 'error');
  } finally {
    state.rewardedBusy = false;
    if (progress) delete progress.dataset.remaining;
    renderRewardedAccess();
  }
}

function hasTurnServer(config) {
  return config?.iceServers?.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls ?? server.url];
    return urls.some((url) => /^turns?:/i.test(String(url || '').trim()));
  }) ?? false;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function initials(name) {
  return String(name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function sourceLabel(type) {
  const labels = {
    DEVICE_AUDIO: 'device audio',
    ANDROID_DEVICE_AUDIO: 'device audio',
    WEB_TAB_AUDIO: 'browser-tab audio',
    TEST_TONE: 'test audio',
    IOS_REPLAYKIT: 'device audio',
  };
  return labels[type] || 'audio';
}

function isModerator() {
  return state.self?.role === 'HOST' || state.self?.role === 'CO_HOST';
}

function isSelfSource() {
  return Boolean(state.self && state.room?.activeSourceId === state.self.id);
}

function notificationSupportAvailable() {
  return typeof Notification !== 'undefined'
    && typeof window !== 'undefined'
    && window.isSecureContext !== false
    && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof navigator.serviceWorker.register === 'function';
}

function notificationPermissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function roomUrlForCode(roomCode) {
  const url = new URL('/', location.origin);
  const code = String(roomCode || '').trim().toUpperCase();
  if (code) url.searchParams.set('room', code);
  return url.href;
}

function notificationRoomCodeFromLocation() {
  try {
    return new URLSearchParams(location.search).get('room')?.trim().toUpperCase() || null;
  } catch {
    return null;
  }
}

function postNotificationReady() {
  if (!notificationSupportAvailable()) return;
  const worker = navigator.serviceWorker.controller
    || state.notificationRegistration?.active
    || state.notificationRegistration?.waiting
    || state.notificationRegistration?.installing;
  if (!worker) return;
  try {
    worker.postMessage({
      type: notificationReadyMessageType,
      roomCode: state.room?.code || notificationRoomCodeFromLocation(),
    });
  } catch {
    // The worker may be replaced between lookup and postMessage.
  }
}

function registerNotificationServiceWorker() {
  if (!notificationSupportAvailable()) return Promise.resolve(null);
  if (state.notificationSetupPromise) return state.notificationSetupPromise;
  state.notificationSetupPromise = navigator.serviceWorker.register(notificationServiceWorkerUrl, { scope: '/' })
    .then(async (registration) => {
      state.notificationRegistration = registration;
      try { await navigator.serviceWorker.ready; } catch {}
      postNotificationReady();
      return registration;
    })
    .catch((error) => {
      state.notificationSetupPromise = null;
      console.warn('[RoomSound] notification service worker unavailable', error);
      return null;
    });
  return state.notificationSetupPromise;
}

function normalizeNotificationAction(data) {
  const action = data?.action === 'approve' || data?.action === 'reject' ? data.action : '';
  const requestId = String(data?.requestId || '').trim();
  let roomCode = String(data?.roomCode || '').trim().toUpperCase();
  if (!roomCode && data?.roomUrl) {
    try { roomCode = new URL(data.roomUrl, location.origin).searchParams.get('room')?.trim().toUpperCase() || ''; } catch {}
  }
  if (!action || !requestId || !roomCode) return null;
  return { type: notificationActionMessageType, action, requestId, roomCode };
}

function notificationActionKey(action) {
  return `${action.roomCode}:${action.action}:${action.requestId}`;
}

function prepareRoomForNotificationAction(action) {
  if (state.room || state.ws || !action?.roomCode) return;
  $('#room-code').value = action.roomCode;
  $$('.entry-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.entryTab === 'join'));
  $$('.entry-panel').forEach((panel) => panel.classList.toggle('active-panel', panel.id === 'join-panel'));
  connectAnd({ type: 'join', code: action.roomCode });
}

function flushNotificationActions() {
  if (!state.room || !isModerator() || state.ws?.readyState !== WebSocket.OPEN) return;
  const remaining = [];
  for (const action of state.pendingNotificationActions) {
    if (action.roomCode !== String(state.room.code || '').toUpperCase()) {
      remaining.push(action);
      continue;
    }
    const key = notificationActionKey(action);
    if (state.sentNotificationActions.has(key)) continue;
    send({
      type: action.action === 'approve' ? 'approve-request' : 'reject-request',
      requestId: action.requestId,
    });
    state.sentNotificationActions.add(key);
  }
  state.pendingNotificationActions = remaining;
}

function queueNotificationAction(data) {
  const action = normalizeNotificationAction(data);
  if (!action) return;
  const key = notificationActionKey(action);
  if (state.sentNotificationActions.has(key) || state.pendingNotificationActions.some((item) => notificationActionKey(item) === key)) return;
  state.pendingNotificationActions.push(action);
  prepareRoomForNotificationAction(action);
  flushNotificationActions();
}

function handleNotificationMessage(event) {
  if (event.data?.type !== notificationActionMessageType) return;
  queueNotificationAction(event.data);
}

async function requestNotificationPermission() {
  if (!notificationSupportAvailable()) {
    toast('System notifications are not available in this browser.', 'error');
    return 'unsupported';
  }

  let permission = notificationPermissionState();
  if (permission === 'denied') {
    toast('Notifications are blocked for this site. Allow them in the browser site settings.', 'error');
    return permission;
  }
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = 'denied';
    }
  }
  if (permission !== 'granted') {
    toast('Request notifications were not enabled.', 'error');
    return permission;
  }

  const registration = await registerNotificationServiceWorker();
  if (!registration?.showNotification) {
    toast('This browser cannot show RoomSound action notifications.', 'error');
    return 'unsupported';
  }
  state.notificationUnavailableNotified = false;
  toast('Control request notifications are enabled.', 'success');
  return permission;
}

async function showControlRequestNotification(request) {
  if (!isModerator() || !request?.id) return;
  const permission = notificationPermissionState();
  if (permission !== 'granted') {
    if (!state.notificationUnavailableNotified) {
      state.notificationUnavailableNotified = true;
      toast(permission === 'denied'
        ? 'Request notifications are blocked. Check browser site settings.'
        : 'Enable request notifications from Room settings for Approve/Reject alerts.');
    }
    return;
  }

  const registration = await registerNotificationServiceWorker();
  if (!registration?.showNotification || !state.room?.code) {
    if (!state.notificationUnavailableNotified) {
      state.notificationUnavailableNotified = true;
      toast('RoomSound could not enable system request notifications.', 'error');
    }
    return;
  }

  try {
    await registration.showNotification(`${request.requesterName} wants to share audio`, {
      body: `${state.room.name} · Approve or reject this control request.`,
      tag: `roomsound-control-${request.id}`,
      renotify: true,
      data: {
        type: 'control-request',
        requestId: request.id,
        roomCode: state.room.code,
        roomUrl: roomUrlForCode(state.room.code),
      },
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'reject', title: 'Reject' },
      ],
    });
  } catch (error) {
    console.warn('[RoomSound] could not show request notification', error);
    if (!state.notificationUnavailableNotified) {
      state.notificationUnavailableNotified = true;
      toast('System request notifications are unavailable in this browser.', 'error');
    }
  }
}

function notificationSettingsMarkup() {
  const permission = notificationPermissionState();
  if (permission === 'unsupported') {
    return '<div class="settings-note"><strong>Control request notifications</strong><br>System notifications are not supported in this browser.</div>';
  }
  if (permission === 'granted') {
    return '<div class="settings-note"><strong>Control request notifications</strong><br>Enabled. Approve or reject requests from your system notifications.</div>';
  }
  if (permission === 'denied') {
    return '<div class="settings-note"><strong>Control request notifications</strong><br>Blocked by the browser. Allow notifications for this site in browser site settings, then reopen this room.</div>';
  }
  return '<div class="settings-note"><strong>Control request notifications</strong><br>Get Approve and Reject buttons when someone asks to share audio.<br><button class="secondary-button" type="button" data-enable-notifications="true" style="margin-top:10px">Enable notifications</button></div>';
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

class RelayPcmPacketizer {
  constructor() {
    this.pending = [];
  }

  reset() {
    this.pending.length = 0;
  }

  push(input, inputSampleRate, onFrame) {
    const sourceRate = Number(inputSampleRate) || MEDIA_RELAY_SAMPLE_RATE;
    if (sourceRate === MEDIA_RELAY_SAMPLE_RATE) {
      for (const sample of input) this.pending.push(sample);
    } else {
      // AudioContext is usually 48 kHz on the target devices, but some
      // browsers choose 44.1 kHz. Resample each callback so the wire format
      // remains the strict 48 kHz protocol required by the server.
      const outputLength = Math.max(1, Math.floor(input.length * MEDIA_RELAY_SAMPLE_RATE / sourceRate));
      const ratio = sourceRate / MEDIA_RELAY_SAMPLE_RATE;
      for (let index = 0; index < outputLength; index += 1) {
        const sourceIndex = index * ratio;
        const lower = Math.min(input.length - 1, Math.floor(sourceIndex));
        const upper = Math.min(input.length - 1, lower + 1);
        const fraction = sourceIndex - lower;
        this.pending.push(input[lower] + (input[upper] - input[lower]) * fraction);
      }
    }

    while (this.pending.length >= RELAY_FRAME_SAMPLES) {
      const samples = new Int16Array(RELAY_FRAME_SAMPLES);
      for (let index = 0; index < RELAY_FRAME_SAMPLES; index += 1) {
        const sample = Math.max(-1, Math.min(1, this.pending[index]));
        samples[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7FFF);
      }
      this.pending.splice(0, RELAY_FRAME_SAMPLES);
      onFrame(samples);
    }
  }
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function createRoomAudioContext() {
  const Constructor = audioContextConstructor();
  if (!Constructor) throw new Error('This browser does not support Web Audio for the PCM16 media relay.');
  try {
    return new Constructor({ latencyHint: 'interactive', sampleRate: MEDIA_RELAY_SAMPLE_RATE });
  } catch {
    return new Constructor({ latencyHint: 'interactive' });
  }
}

function applyOutputVolume() {
  if (state.audioElement) state.audioElement.volume = state.muted ? 0 : state.volume;
  if (state.relayPlaybackGain) state.relayPlaybackGain.gain.value = state.muted ? 0 : state.volume;
}

function sendRelayPcmFrame(samples, sourceEpoch) {
  if (!isMediaRelayEnabled() || !isSelfSource() || state.room?.sourceEpoch !== sourceEpoch) return;
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  try {
    const frame = encodePcm16Frame({
      sourceEpoch,
      sequence: state.relaySequence,
      samples,
    });
    state.relaySequence = (state.relaySequence + 1) >>> 0;
    state.ws.send(frame);
  } catch (error) {
    console.warn('[RoomSound] PCM16 relay frame was not sent', error);
  }
}

function stopRelayCapture() {
  if (state.relayProcessor) {
    state.relayProcessor.onaudioprocess = null;
    try { state.relayProcessor.disconnect(); } catch {}
  }
  try { state.relayCaptureSource?.disconnect(); } catch {}
  try { state.relaySink?.disconnect(); } catch {}
  state.relayCaptureStream = null;
  state.relayCaptureSource = null;
  state.relayProcessor = null;
  state.relaySink = null;
  state.relayPacketizer?.reset();
  state.relayPacketizer = null;
  state.relayCaptureEpoch = null;
  state.relaySequence = 0;
}

function ensureRelayPublisher() {
  if (!isMediaRelayEnabled() || !state.captureStream) return false;
  if (state.relayCaptureStream === state.captureStream && state.relayProcessor) return true;

  stopRelayCapture();
  try {
    const context = state.audioContext && state.audioContext.state !== 'closed'
      ? state.audioContext
      : createRoomAudioContext();
    const source = context.createMediaStreamSource(state.captureStream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    // A muted sink keeps ScriptProcessorNode alive without playing the local
    // capture back through the laptop speakers.
    processor.connect(sink);
    sink.connect(context.destination);
    const stream = state.captureStream;
    const packetizer = new RelayPcmPacketizer();
    processor.onaudioprocess = (event) => {
      if (state.relayProcessor !== processor || state.captureStream !== stream || !isMediaRelayEnabled() || !isSelfSource()) {
        packetizer.reset();
        return;
      }
      const sourceEpoch = state.room?.sourceEpoch;
      if (!Number.isInteger(sourceEpoch)) {
        packetizer.reset();
        return;
      }
      if (state.relayCaptureEpoch !== sourceEpoch) {
        packetizer.reset();
        state.relayCaptureEpoch = sourceEpoch;
        state.relaySequence = 0;
      }
      packetizer.push(event.inputBuffer.getChannelData(0), context.sampleRate, (samples) => {
        sendRelayPcmFrame(samples, sourceEpoch);
      });
    };
    state.audioContext = context;
    state.relayCaptureStream = stream;
    state.relayCaptureSource = source;
    state.relayProcessor = processor;
    state.relaySink = sink;
    state.relayPacketizer = packetizer;
    if (context.state !== 'running') void context.resume().catch(() => {});
    return true;
  } catch (error) {
    stopRelayCapture();
    if (!state.relayUnavailableNotified) {
      state.relayUnavailableNotified = true;
      toast(error?.message || 'This browser could not start PCM16 audio relay.', 'error');
    }
    return false;
  }
}

function ensureRelayPlaybackContext() {
  if (state.relayPlaybackContext && state.relayPlaybackContext.state !== 'closed') return state.relayPlaybackContext;
  try {
    const context = createRoomAudioContext();
    const gain = context.createGain();
    gain.connect(context.destination);
    state.relayPlaybackContext = context;
    state.relayPlaybackGain = gain;
    applyOutputVolume();
    return context;
  } catch (error) {
    if (!state.relayUnavailableNotified) {
      state.relayUnavailableNotified = true;
      toast(error?.message || 'This browser could not play PCM16 room audio.', 'error');
    }
    return null;
  }
}

function resetRelayPlaybackQueue(nextEpoch = null) {
  for (const source of state.relayPlaybackSources) {
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  state.relayPlaybackSources.clear();
  state.relayPlaybackNextTime = 0;
  state.relayPlaybackEpoch = nextEpoch;
  state.relayLastSequence = null;
}

function closeRelayPlayback() {
  resetRelayPlaybackQueue();
  try { state.relayPlaybackGain?.disconnect(); } catch {}
  const context = state.relayPlaybackContext;
  state.relayPlaybackGain = null;
  state.relayPlaybackContext = null;
  if (context && context.state !== 'closed') void context.close().catch(() => {});
}

function handleRelayFrame(data) {
  if (!isMediaRelayEnabled()) return;
  let frame;
  try {
    frame = decodePcm16Frame(data);
  } catch (error) {
    console.warn('[RoomSound] ignored invalid PCM16 relay frame', error);
    return;
  }
  const room = state.room;
  if (!room?.activeSourceId || room.activeSourceId === state.self?.id || frame.sourceEpoch !== room.sourceEpoch) return;
  if (state.relayPlaybackEpoch !== frame.sourceEpoch) resetRelayPlaybackQueue(frame.sourceEpoch);
  if (state.relayLastSequence !== null) {
    const distance = (frame.sequence - state.relayLastSequence) >>> 0;
    if (distance === 0 || distance > 0x80000000) return;
  }

  const context = ensureRelayPlaybackContext();
  if (!context || !state.relayPlaybackGain) return;
  const now = context.currentTime;
  if (state.relayPlaybackNextTime > now + 1.5) resetRelayPlaybackQueue(frame.sourceEpoch);
  const startAt = Math.max(now + 0.02, state.relayPlaybackNextTime || 0);
  const buffer = context.createBuffer(1, frame.sampleCount, frame.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < frame.samples.length; index += 1) channel[index] = frame.samples[index] / 0x8000;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(state.relayPlaybackGain);
  state.relayPlaybackSources.add(source);
  source.addEventListener('ended', () => {
    state.relayPlaybackSources.delete(source);
    try { source.disconnect(); } catch {}
  }, { once: true });
  try {
    source.start(startAt);
    state.relayPlaybackNextTime = startAt + frame.sampleCount / frame.sampleRate;
    state.relayLastSequence = frame.sequence;
  } catch (error) {
    state.relayPlaybackSources.delete(source);
    try { source.disconnect(); } catch {}
    console.warn('[RoomSound] PCM16 relay playback scheduling failed', error);
    return;
  }
  if (context.state !== 'running') {
    state.audioNeedsGesture = true;
    renderControls();
  } else if (state.audioNeedsGesture) {
    state.audioNeedsGesture = false;
    renderControls();
  }
}

function toast(message, kind = '') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  $('#toast-stack').append(item);
  setTimeout(() => item.remove(), 4300);
}

function setConnection(label, good = true) {
  $('#connection-label').textContent = label;
  $('#connection-chip').classList.toggle('bad', !good);
}

function addActivity(text, force = false) {
  const key = `${text}-${Date.now()}`;
  if (!force && state.activity.some((item) => item.text === text)) return;
  state.activity.unshift({ id: key, text, createdAt: Date.now() });
  state.activity = state.activity.slice(0, 30);
  renderActivity();
}

function addMessages(messages) {
  const known = new Set(state.messages.map((message) => message.id));
  for (const message of messages || []) if (!known.has(message.id)) state.messages.push(message);
  state.messages.sort((a, b) => a.createdAt - b.createdAt);
  state.messages = state.messages.slice(-80);
  renderChat();
  renderActivity();
}

function showLanding(error = '') {
  $('#landing-view').classList.remove('hidden');
  $('#room-view').classList.add('hidden');
  $('#entry-error').textContent = error;
  $('#entry-error').classList.toggle('hidden', !error);
}

function showRoom() {
  $('#landing-view').classList.add('hidden');
  $('#room-view').classList.remove('hidden');
}

function resetToLanding(reason = '') {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnectAttempts = 0;
  closePeerConnections();
  stopLocalCapture(false);
  closeRelayPlayback();
  // Preserve ws close handling: caller may have already closed
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
  state.ws = null;
  state.room = null;
  state.self = null;
  state.members = [];
  state.requests = [];
  state.messages = [];
  state.activity = [];
  $('#room-banner').classList.add('hidden');
  showLanding(reason);
}

function scheduleReconnect() {
  if (state.explicitLeave) return;
  if (!state.lastRoomCode || !state.lastDisplayName) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = Math.min(1000 * Math.pow(1.7, state.reconnectAttempts), 30_000);
  state.reconnectAttempts += 1;
  state.reconnectTimer = setTimeout(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
    setConnection(`Reconnecting (${state.reconnectAttempts})`, false);
    connectAnd({ type: 'join', code: state.lastRoomCode }, true);
  }, delay);
}

function connectAnd(action, isReconnect = false) {
  if (!rewardedAccessActive()) {
    renderRewardedAccess();
    showLanding('Complete the demo reward before entering a room.');
    $('#complete-rewarded-access')?.focus();
    return;
  }
  const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isDeviceLocalhost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  if (!isReconnect && isMobileDevice && isDeviceLocalhost) {
    const message = 'This phone is opening localhost on itself. Open RoomSound from the laptop LAN address, for example http://192.168.1.20:4173.';
    setConnection('Use LAN address', false);
    showLanding(message);
    return;
  }

  const displayName = isReconnect ? state.lastDisplayName : ($('#display-name').value.trim() || 'Guest');
  state.pendingIntent = { ...action, displayName };
  if (!isReconnect) {
    state.explicitLeave = false;
    if (action.type === 'create') state.lastDisplayName = displayName;
    else { state.lastDisplayName = displayName; state.lastRoomCode = action.code?.toUpperCase() || state.lastRoomCode; }
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }
  $('#entry-error').classList.add('hidden');
  setConnection(isReconnect ? 'Reconnecting' : 'Connecting', true);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
  if (state.reconnectTimer && !isReconnect) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  const socket = new WebSocket(`${protocol}//${location.host}`);
  socket.binaryType = 'arraybuffer';
  state.ws = socket;
  socket.addEventListener('open', () => {
    setConnection('Live', true);
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    const intent = state.pendingIntent;
    if (intent.type === 'create') {
      send({ type: 'create-room', name: intent.roomName, displayName: intent.displayName, guestId });
    } else {
      send({ type: 'join-room', code: intent.code, displayName: intent.displayName, guestId });
    }
  });
  socket.addEventListener('close', (event) => {
    const code = event.code;
    const reason = event.reason || '';
    // Explicit leaves / removals should NOT reconnect
    if (code === 4003) {
      state.lastRoomCode = null;
      state.explicitLeave = true;
      resetToLanding(reason || 'You were removed from the room.');
      toast(reason || 'You were removed from the room.', 'bad');
      return;
    }
    if (code === 1000 && reason === 'Left room') {
      state.lastRoomCode = null;
      state.explicitLeave = false;
      resetToLanding();
      return;
    }
    if (code === 1000 && reason === 'Room ended') {
      state.lastRoomCode = null;
      resetToLanding();
      toast('The host ended the room.', 'bad');
      return;
    }
    setConnection('Offline', false);
    if (state.room) {
      closePeerConnections();
      resetRelayPlaybackQueue();
      if (state.room.activeSourceId === state.self?.id) stopLocalCapture(false);
      $('#room-banner').textContent = 'Connection lost — reconnecting…';
      $('#room-banner').classList.remove('hidden');
      addActivity('Connection lost — reconnecting…', true);
      scheduleReconnect();
      toast('Connection lost. Reconnecting…', 'bad');
    } else {
      // Not yet in a room; allow reconnect to re-attempt join
      if (state.lastRoomCode && !state.explicitLeave) scheduleReconnect();
    }
  });
  socket.addEventListener('error', () => {
    setConnection('Offline', false);
    if (!state.room) showLanding('Could not connect to the RoomSound server. Is it running?');
    else if (!state.explicitLeave) scheduleReconnect();
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        void event.data.arrayBuffer().then(handleRelayFrame).catch((error) => {
          console.warn('[RoomSound] could not read PCM16 relay frame', error);
        });
      } else {
        handleRelayFrame(event.data);
      }
      return;
    }
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (error) {
      setConnection('Protocol error', false);
      showLanding(`The RoomSound server sent an invalid message: ${error.message || 'invalid JSON'}`);
    }
  });
}

function handleServerMessage(message) {
  if (message.type === 'error') {
    toast(message.message, 'error');
    if (!state.room) showLanding(message.message);
    // Don't auto-reconnect on explicit room errors like "full" — clear lastRoomCode so scheduleReconnect bails
    if (message.message.includes('full') || message.message.includes('unavailable') || message.message.includes('ended')) {
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    }
    return;
  }
  if (message.type === 'joined') {
    state.lastRoomCode = message.state.room.code;
    $('#room-banner').classList.add('hidden');
    applyRoomState(message.state);
    window.history.replaceState(window.history.state, '', roomUrlForCode(message.state.room.code));
    showRoom();
    toast(`Room ${message.state.room.code} is ready.`, 'success');
    return;
  }
  if (message.type === 'state') {
    applyRoomState(message.state);
    // Keep lastRoomCode fresh even on state broadcasts
    if (message.state?.room?.code) state.lastRoomCode = message.state.room.code;
    return;
  }
  if (message.type === 'chat') {
    addMessages([message.message]);
    if (message.message.kind === 'system') toast(message.message.text, 'success');
    return;
  }
  if (message.type === 'control-requested') {
    addActivity(`${message.request.requesterName} requested audio control.`, true);
    if (isModerator()) {
      toast(`${message.request.requesterName} requested audio control.`, 'success');
      void showControlRequestNotification(message.request);
    }
    return;
  }
  if (message.type === 'request-result') {
    if (message.status === 'APPROVED') {
      toast('Your request was approved. Choose an audio source to begin.', 'success');
      addActivity('You were approved to share audio.', true);
      openSourceModal('participant');
    } else if (message.status === 'EXPIRED') {
      toast('Your request expired because the host did not respond.', 'error');
      addActivity('Your audio request expired.', true);
    } else {
      toast('The host rejected your request.', 'error');
      addActivity('Your audio request was rejected.', true);
    }
    return;
  }
  if (message.type === 'source-disconnected') {
    toast('The active audio source has disconnected.', 'error');
    addActivity('The active audio source has disconnected.', true);
    return;
  }
  if (message.type === 'host-disconnected') {
    $('#room-banner').textContent = 'The host connection was lost. Waiting for the co-host to take over.';
    $('#room-banner').classList.remove('hidden');
    addActivity('The host connection was lost.', true);
    return;
  }
  if (message.type === 'host-promoted') {
    $('#room-banner').classList.add('hidden');
    toast('The co-host is now the host.', 'success');
    return;
  }
  if (message.type === 'takeover') {
    closePeerConnections();
    resetRelayPlaybackQueue(state.room?.sourceEpoch ?? null);
    addActivity('The host took control of the room.', true);
    toast('The host has taken control.', 'success');
    return;
  }
  if (message.type === 'removed') {
    toast(message.message, 'error');
    resetToLanding();
    return;
  }
  if (message.type === 'room-ended') {
    toast(message.message, 'success');
    resetToLanding();
    return;
  }
  if (message.type === 'rtc') {
    if (!isMediaRelayEnabled()) handleRtcSignal(message);
  }
}

function applyRoomState(next) {
  const previousSource = state.room?.activeSourceId;
  const previousSourceEpoch = state.room?.sourceEpoch;
  const previousSelfId = state.self?.id;
  const prevMembers = state.members.slice();
  const wasSelfSource = Boolean(previousSource && previousSource === previousSelfId);
  state.room = next.room;
  state.self = next.self;
  state.members = next.members || [];
  state.requests = next.requests || [];
  addMessages(next.messages || []);

  const sourceChanged = previousSource && previousSource !== state.room.activeSourceId;
  const sourceEpochChanged = Number.isInteger(previousSourceEpoch)
    && Number.isInteger(state.room?.sourceEpoch)
    && previousSourceEpoch !== state.room.sourceEpoch;
  if (sourceChanged || sourceEpochChanged) {
    closePeerConnections();
    state.relayPacketizer?.reset();
    state.relayCaptureEpoch = null;
    state.relaySequence = 0;
    resetRelayPlaybackQueue(state.room?.sourceEpoch ?? null);
  }
  // Keep the host's capture alive while a participant temporarily broadcasts so
  // the server can return control without asking the host to grant capture again.
  // A participant/co-host source is released when control moves away from it.
  const wasHostSource = wasSelfSource && state.self?.role === 'HOST';
  if (wasSelfSource && state.room.activeSourceId !== state.self?.id && !wasHostSource) stopLocalCapture(false);
  // Peer cleanup: if a listener just went offline, drop its peer to free RTC resources
  {
    const onlineNow = new Set(state.members.filter((m) => m.online).map((m) => m.id));
    for (const pm of prevMembers) {
      if (pm.online && !onlineNow.has(pm.id) && state.peers.has(pm.id)) {
        const entry = state.peers.get(pm.id);
        removePeerConnection(pm.id, entry);
      }
    }
    // If active source went offline, drop it too
    if (previousSource && !onlineNow.has(previousSource) && state.peers.has(previousSource)) {
      const entry = state.peers.get(previousSource);
      removePeerConnection(previousSource, entry);
    }
  }
  renderAll();
  if (state.room.activeSourceId === state.self?.id && state.captureStream) {
    if (isMediaRelayEnabled()) ensureRelayPublisher();
    else ensurePublisherConnections();
  }
  if (state.room.activeSourceId !== state.self?.id && state.audioElement?.srcObject && state.room.sourceStatus === 'NONE') {
    state.audioElement.srcObject = null;
  }
  postNotificationReady();
  flushNotificationActions();
}

function renderAll() {
  if (!state.room) return;
  const room = state.room;
  $('#top-room-name').textContent = room.name;
  $('#top-room-code').textContent = room.code;
  $('#room-title').textContent = room.name;
  $('#room-code-display').textContent = room.code;
  $('#member-count').textContent = state.members.length;
  renderSource();
  renderControls();
  renderTelemetry();
  renderMembers();
  renderRequests();
  renderChat();
  renderActivity();
}

function renderSource() {
  const sourceMember = state.members.find((member) => member.id === state.room.activeSourceId);
  const live = Boolean(sourceMember && state.room.sourceStatus !== 'NONE');
  const starting = state.room.sourceStatus === 'STARTING';
  const card = $('#source-card');
  card.classList.toggle('live', live);
  $('#source-kicker').textContent = live ? (starting ? 'CONNECTING SOURCE' : 'ACTIVE AUDIO SOURCE') : 'NO ACTIVE SOURCE';
  $('#source-title').textContent = live ? `${sourceMember.name} is sharing` : 'The room is quiet';
  $('#source-detail').textContent = live
    ? `${sourceLabel(state.room.activeSourceType)} · ${starting ? 'waiting for the source device' : 'everyone can listen now'}`
    : 'Choose an audio source to start sharing with the room.';
  $('#source-status-label').textContent = live ? (starting ? 'Starting' : 'Live now') : 'Waiting';
}

function renderControls() {
  const moderator = isModerator();
  const activeOther = Boolean(state.room?.activeSourceId && state.room.activeSourceId !== state.self?.id);
  const sourceIsParticipant = activeOther && state.members.find((member) => member.id === state.room.activeSourceId)?.role === 'PARTICIPANT';
  $('#host-controls').classList.toggle('hidden', !moderator);
  $('#participant-controls').classList.toggle('hidden', moderator);

  if (moderator) {
    $('#share-audio').classList.toggle('hidden', isSelfSource());
    $('#stop-audio').classList.toggle('hidden', !isSelfSource());
    $('#takeover-audio').classList.toggle('hidden', !activeOther);
    $('#enable-audio').classList.toggle('hidden', !state.audioNeedsGesture || isSelfSource());
  } else {
    const myRequest = state.requests.find((request) => request.requesterId === state.self?.id && request.status === 'PENDING');
    const selfIsSource = isSelfSource();
    $('#request-audio').classList.toggle('hidden', Boolean(myRequest || selfIsSource || sourceIsParticipant));
    $('#cancel-request').classList.toggle('hidden', !myRequest);
    $('#cancel-request').dataset.requestId = myRequest?.id || '';
    $('#ask-takeover').classList.toggle('hidden', !sourceIsParticipant);
    $('#request-audio').textContent = '↗  Request to play';
    if (selfIsSource) {
      $('#request-audio').classList.remove('hidden');
      $('#request-audio').textContent = 'Stop sharing';
    }
    $('#enable-audio-participant').classList.toggle('hidden', !state.audioNeedsGesture || selfIsSource);
  }
}

function renderMembers() {
  const host = state.room.hostId;
  const cohost = state.room.cohostId;
  $('#member-list').innerHTML = state.members.map((member) => {
    const isHost = member.id === host;
    const isCohost = member.id === cohost;
    const isSource = member.id === state.room.activeSourceId;
    const role = isHost ? 'Host' : isCohost ? 'Co-host' : isSource ? 'Sharing now' : 'Listener';
    const roleClass = isHost || isSource ? 'green-role' : isCohost ? 'orange-role' : '';
    const actions = isModerator() && member.id !== state.self?.id && !isHost
      ? `<div class="member-actions">${state.self?.role === 'HOST' ? `<button class="tiny-button" data-action="cohost" data-member-id="${member.id}">${isCohost ? 'Remove co-host' : 'Make co-host'}</button>` : ''}<button class="tiny-button" data-action="remove" data-member-id="${member.id}">Remove</button></div>`
      : '';
    return `<div class="member-item"><div class="member-avatar">${escapeHtml(initials(member.name))}</div><div class="member-info"><div class="member-name-row"><span class="member-name">${escapeHtml(member.name)}</span>${member.id === state.self?.id ? '<span class="member-you">YOU</span>' : ''}</div><div class="member-role"><span class="role-badge ${roleClass}">${role}</span></div></div><span class="member-state ${member.online ? 'online' : ''} ${isSource ? 'source' : ''}"></span>${actions}</div>`;
  }).join('') || '<div class="request-empty">No one is here yet.</div>';
}

function renderRequests() {
  const canModerate = isModerator();
  $('#request-panel').classList.toggle('hidden', !canModerate && !state.requests.some((request) => request.requesterId === state.self?.id));
  const requests = canModerate ? state.requests : state.requests.filter((request) => request.requesterId === state.self?.id);
  $('#request-count').textContent = requests.length;
  if (!requests.length) {
    $('#request-list').innerHTML = `<div class="request-empty">${canModerate ? 'No pending requests. The room is under control.' : 'Your requests will appear here.'}</div>`;
    return;
  }
  $('#request-list').innerHTML = requests.map((request) => `<div class="request-item"><div class="request-top"><span>${escapeHtml(request.requesterName)} wants to play</span><span>${timeLabel(request.createdAt)}</span></div><div class="request-note">${escapeHtml(request.note || `${sourceLabel(request.sourceType)} request`)}</div>${canModerate ? `<div class="request-actions"><button class="approve-request" data-request-action="approve" data-request-id="${request.id}">Approve</button><button class="reject-request" data-request-action="reject" data-request-id="${request.id}">Reject</button></div>` : '<div class="request-note">Waiting for host approval…</div>'}</div>`).join('');
}

function renderChat() {
  const chat = state.messages.filter((message) => message.kind === 'chat');
  $('#chat-count').textContent = chat.length;
  $('#chat-feed').innerHTML = chat.length ? chat.map((message) => `<div class="chat-message"><div class="avatar">${escapeHtml(initials(message.senderName))}</div><div class="chat-body"><div class="chat-meta"><span class="chat-name">${escapeHtml(message.senderName)}</span><span class="chat-time">${timeLabel(message.createdAt)}</span></div><div class="chat-text">${escapeHtml(message.text)}</div></div></div>`).join('') : '<div class="request-empty">Start the conversation with the room.</div>';
  $('#chat-feed').scrollTop = $('#chat-feed').scrollHeight;
}

function renderActivity() {
  const systemMessages = state.messages.filter((message) => message.kind === 'system').map((message) => ({ id: message.id, text: message.text, createdAt: message.createdAt }));
  const items = [...systemMessages, ...state.activity].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  $('#activity-feed').innerHTML = items.length ? items.map((item) => `<div class="activity-item"><span class="activity-time">${timeLabel(item.createdAt)}</span><span class="activity-text">${escapeHtml(item.text)}</span></div>`).join('') : '<div class="request-empty">Room events will appear here.</div>';
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatTelemetryBytes(value) {
  const bytes = finiteNumber(value);
  if (bytes === null) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024 || candidate === units[units.length - 1]) break;
  }
  const rounded = amount >= 100 ? Math.round(amount) : Number(amount.toFixed(1));
  return `${rounded} ${unit}`;
}

function formatTelemetryCount(value) {
  const count = finiteNumber(value);
  return count === null ? '—' : Math.round(count).toLocaleString();
}

function formatAudioLevel(value) {
  const level = finiteNumber(value);
  if (level === null) return '—';
  return `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
}

function telemetryStateClass(value) {
  const normalized = String(value || 'new').toLowerCase();
  if (['connected', 'completed'].includes(normalized)) return 'good';
  if (['failed', 'closed', 'disconnected'].includes(normalized)) return 'bad';
  return 'pending';
}

function isAudioStat(stat) {
  const kind = stat?.kind || stat?.mediaType;
  return kind === 'audio';
}

function addTelemetryTotal(target, key, value) {
  const number = finiteNumber(value);
  if (number === null) return;
  target[key] = (target[key] ?? 0) + number;
}

function collectTelemetryStats(report) {
  const result = {
    bytesSent: null,
    bytesReceived: null,
    packetsSent: null,
    packetsReceived: null,
    packetsLost: null,
    audioLevel: null,
    hasRtpStats: false,
  };
  const stats = report && typeof report.values === 'function'
    ? [...report.values()]
    : report && typeof report[Symbol.iterator] === 'function'
      ? [...report]
      : [];

  for (const stat of stats) {
    if (!isAudioStat(stat)) continue;
    if (stat.type === 'outbound-rtp' && !stat.isRemote) {
      result.hasRtpStats = true;
      addTelemetryTotal(result, 'bytesSent', stat.bytesSent);
      addTelemetryTotal(result, 'packetsSent', stat.packetsSent);
      if (result.audioLevel === null) result.audioLevel = finiteNumber(stat.audioLevel);
    } else if (stat.type === 'inbound-rtp' && !stat.isRemote) {
      result.hasRtpStats = true;
      addTelemetryTotal(result, 'bytesReceived', stat.bytesReceived);
      addTelemetryTotal(result, 'packetsReceived', stat.packetsReceived);
      addTelemetryTotal(result, 'packetsLost', stat.packetsLost);
      if (result.audioLevel === null) result.audioLevel = finiteNumber(stat.audioLevel);
    } else if (['media-source', 'track'].includes(stat.type) && result.audioLevel === null) {
      result.audioLevel = finiteNumber(stat.audioLevel);
    }
  }
  return result;
}

function isCurrentPeerEntry(peerId, entry) {
  if (!entry?.pc || state.peers.get(peerId) !== entry || !state.room?.activeSourceId) return false;
  if (entry.sourceEpoch !== undefined && entry.sourceEpoch !== state.room.sourceEpoch) return false;
  if (entry.role === 'publisher') return isSelfSource() && state.captureStream === entry.captureStream && peerId !== state.self?.id;
  return state.room.activeSourceId === peerId && state.room.activeSourceId !== state.self?.id;
}

function updatePeerTelemetryState(peerId, entry) {
  const telemetry = state.telemetry.get(peerId);
  if (!telemetry || telemetry.entry !== entry) return;
  telemetry.connectionState = entry.pc?.connectionState || 'new';
  telemetry.iceConnectionState = entry.pc?.iceConnectionState || 'new';
  telemetry.iceGatheringState = entry.pc?.iceGatheringState || 'new';
}

function ensureTelemetryPolling() {
  if (state.telemetryTimer) return;
  state.telemetryTimer = setInterval(() => { void pollPeerTelemetry(); }, telemetryPollMs);
  void pollPeerTelemetry();
}

function stopTelemetryPolling() {
  if (state.telemetryTimer) clearInterval(state.telemetryTimer);
  state.telemetryTimer = null;
  state.telemetryGeneration += 1;
}

function registerPeerTelemetry(peerId, entry) {
  const previous = state.telemetry.get(peerId);
  if (!previous || previous.entry !== entry) {
    state.telemetry.set(peerId, {
      peerId,
      entry,
      role: entry.role,
      sourceEpoch: entry.sourceEpoch,
      connectionState: entry.pc?.connectionState || 'new',
      iceConnectionState: entry.pc?.iceConnectionState || 'new',
      iceGatheringState: entry.pc?.iceGatheringState || 'new',
      bytesSent: null,
      bytesReceived: null,
      packetsSent: null,
      packetsReceived: null,
      packetsLost: null,
      audioLevel: null,
      hasRtpStats: false,
      updatedAt: null,
      error: null,
    });
  }
  updatePeerTelemetryState(peerId, entry);
  ensureTelemetryPolling();
  renderTelemetry();
}

function removePeerTelemetry(peerId, entry) {
  const telemetry = state.telemetry.get(peerId);
  if (telemetry && (!entry || telemetry.entry === entry)) state.telemetry.delete(peerId);
  const hasRtcPeer = [...state.peers.values()].some((candidate) => candidate?.pc);
  if (!hasRtcPeer) stopTelemetryPolling();
}

function renderTelemetry() {
  const panel = $('#telemetry-panel');
  // Telemetry is an optional diagnostics surface; RTC behavior must not depend on it.
  if (!panel) return;
  if (!state.room) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const sourceId = state.room.activeSourceId;
  const sourceMember = state.members.find((member) => member.id === sourceId);
  const sourceName = sourceMember?.name || 'Unknown source';
  const epoch = Number.isInteger(state.room.sourceEpoch) ? state.room.sourceEpoch : '—';
  const telemetryEntries = [];
  for (const [peerId, telemetry] of state.telemetry) {
    const entry = telemetry.entry;
    if (!isCurrentPeerEntry(peerId, entry)) continue;
    updatePeerTelemetryState(peerId, entry);
    telemetryEntries.push(telemetry);
  }

  const summary = $('#telemetry-summary');
  const status = $('#telemetry-state');
  const list = $('#telemetry-list');
  if (!sourceId || state.room.sourceStatus === 'NONE') {
    summary.textContent = 'No active source · diagnostics will appear when audio starts.';
    status.textContent = 'Waiting';
    status.className = 'telemetry-state pending';
    list.innerHTML = '<div class="telemetry-empty">Start playback sharing to inspect the current source and listeners.</div>';
    return;
  }

  if (isMediaRelayEnabled()) {
    summary.textContent = `${sourceName} · epoch ${epoch} · PCM16 WebSocket relay`;
    status.textContent = 'Relay';
    status.className = 'telemetry-state good';
    list.innerHTML = '<div class="telemetry-empty">Audio is transported through the RoomSound server relay. Relay bandwidth grows with the number of listeners.</div>';
    return;
  }

  const listenerCount = telemetryEntries.length;
  summary.textContent = `${sourceName} · epoch ${epoch} · ${listenerCount} peer${listenerCount === 1 ? '' : 's'}`;
  const hasFreshStats = telemetryEntries.some((telemetry) => telemetry.updatedAt);
  status.textContent = hasFreshStats ? 'Live' : 'Connecting';
  status.className = `telemetry-state ${hasFreshStats ? 'good' : 'pending'}`;

  if (!telemetryEntries.length) {
    list.innerHTML = '<div class="telemetry-empty">Waiting for the current source/listener peer connection…</div>';
    return;
  }

  list.innerHTML = telemetryEntries.map((telemetry) => {
    const entry = telemetry.entry;
    const peerMember = entry.role === 'publisher'
      ? state.members.find((member) => member.id === telemetry.peerId)
      : sourceMember;
    const relationship = entry.role === 'publisher'
      ? `${sourceName} → ${peerMember?.name || 'listener'}`
      : `${sourceName} → ${state.self?.name || 'you'}`;
    const statsLabel = telemetry.error
      ? 'RTP stats unavailable'
      : telemetry.hasRtpStats
        ? 'RTP audio'
        : 'Waiting for RTP';
    const connectionState = String(telemetry.connectionState || 'new');
    const iceConnectionState = String(telemetry.iceConnectionState || 'new');
    const iceGatheringState = String(telemetry.iceGatheringState || 'new');
    const packetLoss = telemetry.packetsLost === null ? '' : ` · ${formatTelemetryCount(telemetry.packetsLost)} lost`;
    return `<article class="telemetry-peer">
      <div class="telemetry-peer-heading">
        <div><span class="telemetry-direction">${entry.role === 'publisher' ? 'TO LISTENER' : 'FROM SOURCE'}</span><strong>${escapeHtml(relationship)}</strong></div>
        <span class="telemetry-connection ${telemetryStateClass(connectionState)}"><i></i>${escapeHtml(connectionState)}</span>
      </div>
      <div class="telemetry-peer-states"><span>ICE <strong class="${telemetryStateClass(iceConnectionState)}">${escapeHtml(iceConnectionState)}</strong></span><span>Gather <strong>${escapeHtml(iceGatheringState)}</strong></span><span>Epoch <strong>${escapeHtml(telemetry.sourceEpoch ?? '—')}</strong></span></div>
      <div class="telemetry-stats"><span><small>Sent</small><strong>${formatTelemetryBytes(telemetry.bytesSent)}</strong><em>${formatTelemetryCount(telemetry.packetsSent)} pkts</em></span><span><small>Received</small><strong>${formatTelemetryBytes(telemetry.bytesReceived)}</strong><em>${formatTelemetryCount(telemetry.packetsReceived)} pkts${packetLoss}</em></span><span><small>Audio level</small><strong>${formatAudioLevel(telemetry.audioLevel)}</strong><em>${statsLabel}</em></span></div>
    </article>`;
  }).join('');
}

function pollPeerTelemetry() {
  if (state.telemetryPollPromise) return state.telemetryPollPromise;
  const generation = state.telemetryGeneration;
  const peers = [...state.peers.entries()].filter(([peerId, entry]) => isCurrentPeerEntry(peerId, entry));
  if (!peers.length) {
    if (state.telemetryTimer) stopTelemetryPolling();
    renderTelemetry();
    return Promise.resolve();
  }

  const task = Promise.all(peers.map(async ([peerId, entry]) => {
    if (typeof entry.pc?.getStats !== 'function') return;
    try {
      const report = await entry.pc.getStats();
      if (generation !== state.telemetryGeneration || !isCurrentPeerEntry(peerId, entry)) return;
      const telemetry = state.telemetry.get(peerId);
      if (!telemetry || telemetry.entry !== entry) return;
      const stats = collectTelemetryStats(report);
      Object.assign(telemetry, stats, {
        updatedAt: Date.now(),
        error: null,
      });
      updatePeerTelemetryState(peerId, entry);
    } catch (error) {
      if (generation !== state.telemetryGeneration || !isCurrentPeerEntry(peerId, entry)) return;
      const telemetry = state.telemetry.get(peerId);
      if (!telemetry || telemetry.entry !== entry) return;
      telemetry.updatedAt = Date.now();
      telemetry.error = error?.name || 'unavailable';
      updatePeerTelemetryState(peerId, entry);
    }
  })).then(() => {
    if (generation === state.telemetryGeneration) renderTelemetry();
  });
  state.telemetryPollPromise = task;
  task.then(
    () => { if (state.telemetryPollPromise === task) state.telemetryPollPromise = null; },
    () => { if (state.telemetryPollPromise === task) state.telemetryPollPromise = null; },
  );
  return task;
}

function openSourceModal(intent) {
  const isParticipantApproval = intent === 'participant';
  const insecure = typeof window !== 'undefined' && !window.isSecureContext;
  const insecureBanner = insecure
    ? `<div class="settings-note" style="margin:0 0 14px;border-color:rgba(255,127,145,0.32);color:#ffb6c0;text-align:left;line-height:1.5"><strong style="color:#ff9aa8">\u26A0 Insecure origin \u2014 device-audio capture blocked</strong><br>Chrome blocks <code>getDisplayMedia</code> on <code>http://10.x</code> LAN URLs. <br>\u2022 <strong>Laptop:</strong> open <code>http://localhost:4173</code> instead of the 10.x IP \u2014 localhost <em>is</em> a secure context and device/browser audio capture will work.<br>\u2022 <strong>Phone browser:</strong> use the native Android app for device playback capture, or serve this page over <code>https</code>.<br><span style="color:#c8d1ec">Test Tone proves the whole WebRTC path even when the OS/browser blocks capture.</span></div>`
    : '';
  const hostNote = !insecure && /Mobi|Android/i.test(navigator.userAgent)
    ? `<div class="settings-note" style="margin:0 0 14px;text-align:left;line-height:1.5">\uD83D\uDCF1 You're on a phone browser. Chrome/Firefox on Android do not expose system-audio capture to the web. Use the <strong>Android app</strong> for device playback capture.</div>`
    : '';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="source-modal"><div class="modal-eyebrow">AUDIO SOURCE</div><h2>${intent === 'participant' ? 'You were approved to play' : 'Choose what to share'}</h2><p>RoomSound publishes supported device or browser playback only. It never opens or streams a microphone.</p>${insecureBanner}${hostNote}<div class="source-options"><button class="source-option" data-source="DEVICE_AUDIO" ${insecure ? 'disabled title="Blocked \u2014 insecure origin (open localhost or use the Android app)"' : ''}><span class="option-icon">◉</span><span><strong>Device / browser audio</strong><small>${insecure ? 'Blocked on http LAN \u2014 use localhost / Android app' : 'Android playback capture or browser tab audio'}</small></span><span>›</span></button><button class="source-option" data-source="TEST_TONE"><span class="option-icon">∿</span><span><strong>Test audio</strong><small>Generate a private room-safe diagnostic signal \u2014 always works</small></span><span>›</span></button></div><button class="modal-close" type="button">Not now</button></div>`;
  $('#modal-root').append(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => {
    modal.remove();
    if (isParticipantApproval) send({ type: 'stop-source' });
  });
  modal.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', async () => {
    modal.remove();
    await startLocalCapture(button.dataset.source, intent);
  }));
}

async function startLocalCapture(sourceType, intent = 'host') {
  stopLocalCapture(false);
  const nonce = ++state.captureNonce;
  try {
    let stream;
    let label;
    // getDisplayMedia requires a secure context. http://localhost is secure,
    // but http://10.x LAN IPs are NOT secure, so browser device-audio capture
    // on an http LAN page will always throw.
    if (sourceType !== 'TEST_TONE' && !window.isSecureContext) {
      const expected = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? ' Use Test Tone to confirm the room in one click, or use the native Android app for device-audio, or serve this site over https so getDisplayMedia is allowed on LAN IPs.'
        : ' On this browser, http LAN URLs like http://10.x or http://192.168.x cannot capture device audio by design (Secure Context). Use Test Tone here to verify the room, open the same site on the LAPTOP at http://localhost:4173, use the native Android app, or serve the page over https.';
      throw new Error(`Audio capture blocked: this page is not a secure context (${location.protocol}//${location.host}).${expected}`);
    }
    if (sourceType === 'DEVICE_AUDIO') {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser does not expose display-audio capture. Try a current desktop browser or the Android app.');
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (e) {
        const n2 = e?.name || '';
        if (n2 === 'NotAllowedError' || n2 === 'PermissionDeniedError') throw new Error('Display capture was denied. Allow access and tick Share audio, or use Test Tone.');
        if (n2 === 'InvalidStateError') throw new Error('Display capture is already in use. Close the other picker and try again.');
        throw e;
      }
      try { prepareDisplayAudioStream(stream); } catch (e) {
        // Ticking "Share audio" can yield a stream with zero live audio tracks.
        // Never crash: stop the display stream, wrap the technical message in guidance.
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        const hint = e?.message ? ` ${e.message}` : ' The source did not provide audio.';
        throw new Error(`System audio was not captured.${hint} When the browser picker shows Entire Screen, tick Share audio (Chrome 116+) and pick a tab/window that is currently playing sound. To test without capture, choose Test Tone.`);
      }
      label = 'device or browser audio';
    } else if (sourceType === 'TEST_TONE') {
      const context = createRoomAudioContext();
      if (context.state !== 'running') await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 330;
      gain.gain.value = 0.12;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      state.audioContext = context;
      state.testOscillator = oscillator;
      stream = destination.stream;
      label = 'test audio';
    } else {
      throw new Error('Only device or browser playback audio is supported. RoomSound never streams a microphone.');
    }
    if (nonce !== state.captureNonce) { stream.getTracks().forEach((t) => t.stop()); return; }
    state.captureStream = stream;
    state.captureType = sourceType;
    state.captureLabel = label;
    stream.getTracks().forEach((track) => track.addEventListener('ended', () => {
      if (state.captureStream === stream) {
        stopRelayCapture();
        state.captureStream = null;
        send({ type: 'stop-source' });
        toast('The audio capture session ended.', 'error');
      }
    }));
    if (isMediaRelayEnabled()) ensureRelayPublisher();
    if (intent === 'takeover') send({ type: 'takeover', sourceType });
    send({ type: 'start-source', sourceType, sourceLabel: label });
    toast(`Sharing ${label}.`, 'success');
    addActivity(`You started sharing ${label}.`, true);
  } catch (error) {
    if (intent === 'participant') send({ type: 'stop-source' });
    toast(error.message || 'Audio capture was not available.', 'error');
    addActivity('Audio sharing could not start.', true);
  }
}

function stopLocalCapture(stopServer = true) {
  state.captureNonce += 1;
  if (state.peers.size) closePeerConnections();
  stopRelayCapture();
  if (state.captureStream) state.captureStream.getTracks().forEach((track) => track.stop());
  state.captureStream = null;
  state.captureType = null;
  state.captureLabel = null;
  if (state.testOscillator) {
    try { state.testOscillator.stop(); } catch {}
    state.testOscillator = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  if (stopServer) send({ type: 'stop-source' });
}

function removePeerConnection(peerId, expectedEntry = null) {
  const entry = state.peers.get(peerId);
  if (!entry || (expectedEntry && entry !== expectedEntry)) return false;
  state.peers.delete(peerId);
  removePeerTelemetry(peerId, entry);
  try { entry.pc?.close(); } catch {}
  renderTelemetry();
  return true;
}

function closePeerConnections() {
  const entries = [...state.peers.values()];
  state.peers.clear();
  stopTelemetryPolling();
  state.telemetry.clear();
  for (const entry of entries) {
    try { entry.pc?.close(); } catch {}
  }
  renderTelemetry();
  if (state.audioElement) {
    try { state.audioElement.pause(); } catch {}
    state.audioElement.srcObject = null;
    state.audioElement.removeAttribute('src');
    try { state.audioElement.load(); } catch {}
  }
}

function ensureAudioElement() {
  if (state.audioElement) return state.audioElement;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.controls = false;
  applyOutputVolume();
  audio.setAttribute('aria-label', 'Room audio — use Your listening controls to adjust volume');
  audio.setAttribute('aria-live', 'off');
  // Visually hidden but still accessible to screen readers via aria-label above;
  // we keep controls off but expose via the visible Mute/Volume panel.
  audio.style.position = 'fixed';
  audio.style.width = '1px';
  audio.style.height = '1px';
  audio.style.opacity = '0';
  audio.style.pointerEvents = 'none';
  document.body.append(audio);
  state.audioElement = audio;
  applyOutputVolume();
  return audio;
}

function ensurePublisherConnections() {
  if (isMediaRelayEnabled() || !state.captureStream || !isSelfSource()) return;
  for (const member of state.members) {
    if (member.id !== state.self.id && member.online && !state.peers.has(member.id)) createPublisherPeer(member.id);
  }
}

async function createPublisherPeer(targetId) {
  if (isMediaRelayEnabled() || !state.captureStream || state.peers.has(targetId) || !isSelfSource()) return;
  const captureStream = state.captureStream;
  const sourceEpoch = state.room?.sourceEpoch;
  const audioTracks = liveAudioTracks(captureStream);
  if (!audioTracks.length) { console.warn("[RoomSound] no live tracks for "+targetId); return; }
  await loadClientConfig();
  if (state.captureStream !== captureStream || !isSelfSource() || state.room?.sourceEpoch !== sourceEpoch || state.peers.has(targetId)) return;
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, role: 'publisher', sourceEpoch, captureStream, pendingCandidates: [], remoteDescSet: false };
  state.peers.set(targetId, entry);
  // Display capture uses a live video track to keep Chrome's audio session
  // alive, but the room protocol is audio-only. Never send an ended/disabled
  // display video track to native listeners.
  audioTracks.forEach((track) => pc.addTrack(track, captureStream));
  pc.onicecandidate = (event) => {
    if (event.candidate && isCurrentPeerEntry(targetId, entry)) send({ type: 'rtc', to: targetId, signal: { type: 'candidate', candidate: event.candidate }, sourceEpoch: entry.sourceEpoch });
  };
  pc.onicegatheringstatechange = () => {
    updatePeerTelemetryState(targetId, entry);
    renderTelemetry();
    console.log("[RoomSound][pub->"+targetId+"] gathering="+pc.iceGatheringState);
  };
  pc.oniceconnectionstatechange = () => {
    updatePeerTelemetryState(targetId, entry);
    renderTelemetry();
    console.log("[RoomSound][pub->"+targetId+"] iceConn="+pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch {}
      const msg = hasTurnServer(rtcConfig)
        ? 'Audio relay failed — retrying ICE…'
        : 'Direct audio connection failed — retrying ICE. Try the same Wi-Fi or another reachable network.';
      toast(msg, 'error');
      setTimeout(() => {
        if (isCurrentPeerEntry(targetId, entry) && entry.pc.iceConnectionState === 'failed') {
          removePeerConnection(targetId, entry);
          if (state.captureStream === captureStream) createPublisherPeer(targetId).catch(() => {});
        }
      }, 1500);
    }
  };
  pc.onconnectionstatechange = () => {
    updatePeerTelemetryState(targetId, entry);
    renderTelemetry();
    console.log("[RoomSound][pub->"+targetId+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
    if (pc.connectionState === 'failed') {
      toast('Audio connection failed — trying to reconnect…', 'error');
      try { pc.restartIce(); } catch {}
      setTimeout(() => {
        if (isCurrentPeerEntry(targetId, entry) && entry.pc.connectionState === 'failed') {
          removePeerConnection(targetId, entry);
          if (state.captureStream === captureStream) createPublisherPeer(targetId).catch(() => {});
        }
      }, 1000);
    }
    // `disconnected` is recoverable while ICE is still checking/restarting.
    // Keep the peer alive so a STUN-only connection can recover instead of
    // silently losing the only publisher path before the retry guard runs.
    if (pc.connectionState === 'closed') removePeerConnection(targetId, entry);
    if (pc.connectionState === 'connected' && isCurrentPeerEntry(targetId, entry)) addActivity("Audio peer connected to "+targetId, true);
  };
  registerPeerTelemetry(targetId, entry);
  try {
    const offer = await pc.createOffer();
    if (!isCurrentPeerEntry(targetId, entry)) {
      removePeerConnection(targetId, entry);
      return;
    }
    await pc.setLocalDescription(offer);
    if (!isCurrentPeerEntry(targetId, entry)) {
      removePeerConnection(targetId, entry);
      return;
    }
    send({ type: 'rtc', to: targetId, signal: { type: 'offer', description: pc.localDescription }, sourceEpoch: entry.sourceEpoch });
    console.log("[RoomSound] sent offer to "+targetId+" epoch="+entry.sourceEpoch);
  } catch (error) {
    if (state.peers.get(targetId) === entry) removePeerConnection(targetId, entry);
    console.warn("[RoomSound] createOffer failed", error);
  }
}

async function handleRtcSignal(message) {
  const { from, signal } = message;
  if (!signal) return;
  const sourceEpoch = Number.isInteger(message.sourceEpoch) ? message.sourceEpoch : state.room?.sourceEpoch;
  if (Number.isInteger(message.sourceEpoch) && Number.isInteger(state.room?.sourceEpoch) && message.sourceEpoch !== state.room.sourceEpoch) {
    console.warn("[RoomSound] ignored RTC signal for stale source epoch", message.sourceEpoch);
    return;
  }
  if (signal.type === 'offer') {
    if (isSelfSource()) return;
    await loadClientConfig();
    if (!state.room?.activeSourceId || state.room.activeSourceId !== from || state.room.sourceEpoch !== sourceEpoch || isSelfSource()) return;
    const existing = state.peers.get(from);
    if (existing) removePeerConnection(from, existing);
    const pc = new RTCPeerConnection(rtcConfig);
    const entry = { pc, role: 'listener', sourceEpoch, pendingCandidates: [], remoteDescSet: false, localDescSet: false };
    state.peers.set(from, entry);
    pc.onicecandidate = (event) => {
      if (event.candidate && isCurrentPeerEntry(from, entry)) send({ type: 'rtc', to: from, signal: { type: 'candidate', candidate: event.candidate }, sourceEpoch: entry.sourceEpoch });
    };
    pc.onicegatheringstatechange = () => {
      updatePeerTelemetryState(from, entry);
      renderTelemetry();
      console.log("[RoomSound][lis<-"+from+"] gathering="+pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => {
      updatePeerTelemetryState(from, entry);
      renderTelemetry();
      console.log("[RoomSound][lis<-"+from+"] iceConn="+pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
        setTimeout(() => {
          if (isCurrentPeerEntry(from, entry) && pc.iceConnectionState === 'failed') {
            toast(
              hasTurnServer(rtcConfig)
                ? 'Audio relay failed — retrying ICE…'
                : 'Direct audio connection failed. Try the same Wi-Fi or another reachable network.',
              'error',
            );
          }
        }, 2000);
      }
    };
    pc.onconnectionstatechange = () => {
      updatePeerTelemetryState(from, entry);
      renderTelemetry();
      console.log("[RoomSound][lis<-"+from+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
      if (pc.connectionState === 'failed') {
       toast('Audio connection failed. Direct peer connections need reachable networks; try the same Wi-Fi.', 'error');
        try { pc.restartIce(); } catch {}
        state.audioNeedsGesture = true;
        renderControls();
        setTimeout(() => {
          if (isCurrentPeerEntry(from, entry) && pc.connectionState === 'failed') console.warn("[RoomSound] listener still failed, waiting for publisher renegotiation");
        }, 2500);
      }
      // A transient `disconnected` state is not terminal. ICE may recover
      // without a new offer, so only discard a listener peer once it is closed.
      if (pc.connectionState === 'closed') removePeerConnection(from, entry);
      if (pc.connectionState === 'connected' && isCurrentPeerEntry(from, entry)) addActivity("Audio connected to "+from, true);
    };
    pc.ontrack = (event) => {
      if (!isCurrentPeerEntry(from, entry)) return;
      console.log("[RoomSound] ontrack from "+from+" kind="+(event.track?.kind||"audio")+" streams="+(event.streams?.length||0));
      const audio = ensureAudioElement();
      const inbound = event.streams?.[0] || new MediaStream([event.track]);
      audio.srcObject = inbound;
      audio.volume = state.muted ? 0 : state.volume;
      audio.muted = false;
      audio.play().then(() => {
        if (!isCurrentPeerEntry(from, entry)) return;
        state.audioNeedsGesture = false;
        renderControls();
        console.log("[RoomSound] remote audio playing from "+from);
      }).catch((err) => {
        if (!isCurrentPeerEntry(from, entry)) return;
        console.warn("[RoomSound] autoplay blocked", err);
        state.audioNeedsGesture = true;
        renderControls();
        toast('Tap “Enable room audio” to start playback.', 'error');
      });
    };
    registerPeerTelemetry(from, entry);
    try {
      await pc.setRemoteDescription(signal.description);
      if (!isCurrentPeerEntry(from, entry)) {
        removePeerConnection(from, entry);
        return;
      }
      entry.remoteDescSet = true;
      for (const c of entry.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch (e) { console.warn("[RoomSound] late candidate flush failed", e); } }
    } catch (e) {
      console.error("[RoomSound] setRemoteDescription(offer) failed", e);
      removePeerConnection(from, entry);
      return;
    }
    try {
      const answer = await pc.createAnswer();
      if (!isCurrentPeerEntry(from, entry)) {
        removePeerConnection(from, entry);
        return;
      }
      await pc.setLocalDescription(answer);
      if (!isCurrentPeerEntry(from, entry)) {
        removePeerConnection(from, entry);
        return;
      }
      entry.localDescSet = true;
      send({ type: 'rtc', to: from, signal: { type: 'answer', description: pc.localDescription }, sourceEpoch: entry.sourceEpoch });
      console.log("[RoomSound] sent answer to "+from+" epoch="+entry.sourceEpoch);
    } catch (e) {
      if (state.peers.get(from) === entry) removePeerConnection(from, entry);
      console.error("[RoomSound] createAnswer failed", e);
    }
    // flush early trickled candidates that arrived before offer was processed
    const pkEarly = "__pending_"+from;
    if (state.peers.has(pkEarly) && isCurrentPeerEntry(from, entry)) {
      const pend = state.peers.get(pkEarly);
      state.peers.delete(pkEarly);
      for (const c of (pend.pendingCandidates||[])) { try { await pc.addIceCandidate(c); } catch {} }
    }
    return;
  }
  const peer = state.peers.get(from);
  if (!peer?.pc) {
    if (signal.type === 'candidate' && signal.candidate && !isSelfSource() && state.room?.activeSourceId === from && state.room?.sourceEpoch === sourceEpoch) {
      let pend = state.peers.get("__pending_"+from);
      if (!pend || pend.sourceEpoch !== sourceEpoch) {
        pend = { sourceEpoch, pendingCandidates: [] };
        state.peers.set("__pending_"+from, pend);
      }
      pend.pendingCandidates.push(signal.candidate);
      console.log("[RoomSound] buffered early candidate from "+from+" before offer");
    }
    return;
  }
  if (!isCurrentPeerEntry(from, peer)) return;
  if (signal.type === 'answer') {
    try {
      await peer.pc.setRemoteDescription(signal.description);
      if (!isCurrentPeerEntry(from, peer)) {
        removePeerConnection(from, peer);
        return;
      }
      peer.remoteDescSet = true;
      console.log("[RoomSound][pub->"+from+"] remote answer set");
      for (const c of (peer.pendingCandidates||[]).splice(0)) { try { await peer.pc.addIceCandidate(c); } catch (e) { console.warn("[RoomSound] flush queued candidate failed", e); } }
    } catch (e) {
      if (state.peers.get(from) === peer) removePeerConnection(from, peer);
      console.error("[RoomSound] setRemoteDescription(answer) failed", e);
    }
  } else if (signal.type === 'candidate') {
    if (!peer.remoteDescSet) {
      peer.pendingCandidates = peer.pendingCandidates || [];
      peer.pendingCandidates.push(signal.candidate);
      console.log("[RoomSound] queued candidate from "+from+" until remoteDescSet");
    } else {
      try { await peer.pc.addIceCandidate(signal.candidate); } catch (e) { console.warn("[RoomSound] addIceCandidate failed", e); }
    }
  }
  const pk = "__pending_"+from;
  if (state.peers.has(pk) && peer.remoteDescSet && isCurrentPeerEntry(from, peer)) {
    const pend = state.peers.get(pk);
    state.peers.delete(pk);
    for (const c of (pend.pendingCandidates||[])) { try { await peer.pc.addIceCandidate(c); } catch {} }
  }
}

function enableRoomAudio() {
  const audio = state.audioElement ? ensureAudioElement() : null;
  const playbackContext = state.relayPlaybackContext;
  const tasks = [];
  if (audio) {
    audio.muted = false;
    applyOutputVolume();
    tasks.push(audio.play());
  }
  if (playbackContext?.state === 'suspended') tasks.push(playbackContext.resume());
  if (!tasks.length) {
    state.audioNeedsGesture = false;
    renderControls();
    return;
  }
  Promise.all(tasks).then(() => {
    state.audioNeedsGesture = false;
    renderControls();
  }).catch(() => toast('Room audio is not ready yet.', 'error'));
}

function openShare() {
  const link = `${location.origin}/?room=${state.room.code}`;
  if (navigator.share) navigator.share({ title: `Join ${state.room.name}`, text: `Join my RoomSound room with code ${state.room.code}.`, url: link }).catch(() => {});
  else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => toast('Invite link copied.', 'success')).catch(() => toast(`Room code: ${state.room.code}`, 'success'));
  else toast(`Room code: ${state.room.code}`, 'success');
}

function openRoomSettings() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  const hostControls = state.self?.role === 'HOST'
    ? '<button class="danger-modal-button" type="button" data-end-room="true">End room for everyone</button>'
    : '<p class="settings-note">Only the host can end this room. Ask the host to take control or update the room.</p>';
  modal.innerHTML = `<div class="source-modal settings-modal"><div class="modal-eyebrow">ROOM SETTINGS</div><h2>${escapeHtml(state.room.name)}</h2><p>Private room · up to 10 people · audio is not recorded.</p><div class="settings-summary"><div><span>Room code</span><strong>${escapeHtml(state.room.code)}</strong></div><div><span>Current source</span><strong>${escapeHtml(state.room.activeSourceId ? sourceLabel(state.room.activeSourceType) : 'None')}</strong></div></div>${notificationSettingsMarkup()}${hostControls}<button class="modal-close" type="button">Close</button></div>`;
  $('#modal-root').append(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('[data-enable-notifications]')?.addEventListener('click', async () => {
    await requestNotificationPermission();
    modal.remove();
    openRoomSettings();
  });
  modal.querySelector('[data-end-room]')?.addEventListener('click', () => {
    if (!window.confirm('End this room for everyone?')) return;
    send({ type: 'end-room' });
    modal.remove();
  });
}

function sendRequest() {
  if (isSelfSource()) {
    stopLocalCapture(false);
    send({ type: 'stop-source' });
    addActivity('You stopped sharing audio.', true);
    return;
  }
  send({ type: 'request-control', sourceType: 'DEVICE_AUDIO', note: 'I want to share device audio.' });
  toast('Waiting for host approval…');
  addActivity('You requested audio control.', true);
}

function wireEvents() {
  $$('.entry-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.entry-tab').forEach((item) => item.classList.toggle('active', item === tab));
    $$('.entry-panel').forEach((panel) => panel.classList.toggle('active-panel', panel.id === `${tab.dataset.entryTab}-panel`));
  }));

  $('#create-room').addEventListener('click', () => connectAnd({ type: 'create', roomName: $('#room-name').value.trim() || 'Listening room' }));
  $('#join-room').addEventListener('click', () => {
    const code = $('#room-code').value.trim().toUpperCase();
    if (code.length < 4) return showLanding('Enter the room code your host shared with you.');
    connectAnd({ type: 'join', code });
  });
  $('#room-code').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#share-audio').addEventListener('click', () => openSourceModal('host'));
  $('#takeover-audio').addEventListener('click', () => {
    if (state.captureStream) {
      send({ type: 'takeover', sourceType: state.captureType || 'DEVICE_AUDIO' });
      setTimeout(() => send({ type: 'start-source', sourceType: state.captureType, sourceLabel: state.captureLabel }), 100);
    } else {
      openSourceModal('takeover');
    }
  });
  $('#stop-audio').addEventListener('click', () => { stopLocalCapture(false); send({ type: 'stop-source' }); addActivity('You stopped sharing audio.', true); });
  $('#request-audio').addEventListener('click', sendRequest);
  $('#cancel-request').addEventListener('click', () => send({ type: 'cancel-request', requestId: $('#cancel-request').dataset.requestId }));
  $('#ask-takeover').addEventListener('click', () => { send({ type: 'chat', text: 'Could the host take control back, please?' }); toast('The host was notified in chat.'); });
  $('#enable-audio').addEventListener('click', enableRoomAudio);
  $('#enable-audio-participant').addEventListener('click', enableRoomAudio);
  $('#local-mute').addEventListener('click', () => {
    state.muted = !state.muted;
    applyOutputVolume();
    $('#local-mute').classList.toggle('muted', state.muted);
    $('#mute-label').textContent = state.muted ? 'Unmute' : 'Mute';
    $('#mute-icon').textContent = state.muted ? '⊘' : '◒';
  });
  $('#local-volume').value = String(state.volume);
  $('#volume-label').textContent = `${Math.round(state.volume * 100)}%`;
  $('#local-volume').addEventListener('input', (event) => {
    state.volume = clampVolume(event.target.value);
    localStorage.setItem('roomsound-volume', String(state.volume));
    $('#volume-label').textContent = `${Math.round(state.volume * 100)}%`;
    event.target.value = String(state.volume);
    applyOutputVolume();
  });
  $('#share-room').addEventListener('click', openShare);
  $('#settings-button').addEventListener('click', openRoomSettings);
  $('#leave-room').addEventListener('click', () => { state.explicitLeave = true; state.lastRoomCode = null; send({ type: 'leave-room' }); /* server will close ws, close handler resets landing */ });
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    $('#chat-input').value = '';
  });
  $('#member-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const memberId = button.dataset.memberId;
    if (button.dataset.action === 'cohost') {
      const target = state.members.find((member) => member.id === memberId);
      send({ type: 'assign-cohost', memberId: target?.role === 'CO_HOST' ? null : memberId });
      if (target?.role === 'CO_HOST') toast('Co-host role removed.');
    } else if (button.dataset.action === 'remove') {
      send({ type: 'remove-member', memberId });
    }
  });
  $('#request-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-request-action]');
    if (!button) return;
    send({ type: button.dataset.requestAction === 'approve' ? 'approve-request' : 'reject-request', requestId: button.dataset.requestId });
  });
  $('#complete-rewarded-access')?.addEventListener('click', () => { void completeRewardedAccess(); });
}

wireEvents();
if (notificationSupportAvailable()) {
  navigator.serviceWorker.addEventListener('message', handleNotificationMessage);
  navigator.serviceWorker.addEventListener('controllerchange', postNotificationReady);
}
void registerNotificationServiceWorker();
initializeAdSlots();
renderRewardedAccess();

const locationParams = new URLSearchParams(location.search);
const initialNotificationAction = normalizeNotificationAction({
  action: locationParams.get('notificationAction'),
  requestId: locationParams.get('requestId'),
  roomCode: locationParams.get('room'),
});
if (initialNotificationAction) {
  // Keep the action in the URL until the room joins. That gives a reload a
  // durable retry path if the worker or WebSocket is interrupted mid-join.
  queueNotificationAction(initialNotificationAction);
} else {
  const queryRoom = locationParams.get('room');
  if (queryRoom) {
    $$('.entry-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.entryTab === 'join'));
    $$('.entry-panel').forEach((panel) => panel.classList.toggle('active-panel', panel.id === 'join-panel'));
    $('#room-code').value = queryRoom.toUpperCase();
  }
}
