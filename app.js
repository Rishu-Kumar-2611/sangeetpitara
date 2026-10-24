import { createGuestId } from './guest-id.js?v=20261025-redesign';
import { RelayPcmPacketizer } from './relay-pcm.js?v=20261025-redesign';
import {
  displayAudioCaptureConstraints,
  displayAudioCaptureGuidance,
  liveAudioTracks,
  mobileAudioCaptureGuidance,
  prepareDisplayAudioStream,
} from './capture-tracks.js?v=20261025-redesign';
import {
  decodePcm16Frame,
  encodePcm16Frame,
  MEDIA_RELAY_CHANNELS,
  MEDIA_RELAY_MAX_BACKLOG_BYTES,
  MEDIA_RELAY_SAMPLE_RATE,
} from './media-relay.mjs?v=20261025-redesign';
import {
  DEFAULT_REWARDED_ACCESS_CONFIG,
  clearRewardedAccess,
  formatRewardedAccessRemaining,
  grantRewardedAccess,
  hasRewardedAccess,
  initializeAdSlots,
  setAdConsent,
  normalizeRewardedAccessConfig,
  readRewardedAccessExpiry,
  runRewardedAccess,
} from './ads.mjs?v=20261025-redesign';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const guestStorageKey = 'roomsound-guest-id';
const guestId = localStorage.getItem(guestStorageKey) || createGuestId();
localStorage.setItem(guestStorageKey, guestId);

const reconnectSecretStorageKey = 'roomsound-reconnect-secret';
const reconnectSecret = localStorage.getItem(reconnectSecretStorageKey) || createGuestId();
localStorage.setItem(reconnectSecretStorageKey, reconnectSecret);

const notificationServiceWorkerUrl = '/notifications-sw.js?v=20261018-1';
const notificationActionMessageType = 'roomsound-notification-action';
const notificationReadyMessageType = 'roomsound-notification-ready';
const DEFAULT_MEDIA_RELAY_CONFIG = {
  enabled: true,
  mode: 'pcm16',
  sampleRate: MEDIA_RELAY_SAMPLE_RATE,
  channels: MEDIA_RELAY_CHANNELS,
};
const RELAY_PROCESSOR_BUFFER_SAMPLES = 2048; // Compatibility only; primary capture uses the audio rendering thread.
const SYNC_OFFSET_MAX_MS = 1000; // Matches the #sync-offset slider max and the worklet's target ceiling.
// Fallback playahead cap: the largest initial cushion plus the worklet's 400 ms
// excess headroom. It must stay above SYNC_OFFSET_MAX_MS, or the first frame
// scheduled at the cushion would trip a reset on every following frame.
const RELAY_MAX_PLAYAHEAD_SECONDS = SYNC_OFFSET_MAX_MS / 1000 + 0.4;
const RELAY_CAPTURE_MAX_AGE_SECONDS = 1.0; // Drop captured frames older than this instead of sending stale audio.

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.9;
  return Math.min(1, Math.max(0, n));
}

function clampSyncOffsetMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 150;
  return Math.min(SYNC_OFFSET_MAX_MS, Math.max(60, Math.round(n / 20) * 20));
}

function enhanceOpusSdpForMusic(sdp) {
  if (typeof sdp !== 'string') return sdp;
  return sdp.replace(/a=fmtp:(\d+) (.*)/g, (match, pt, params) => {
    if (!sdp.includes(`a=rtpmap:${pt} opus/48000`)) return match;
    const cleaned = params
      .split(';')
      .filter((part) => !/^(stereo|sprop-stereo|maxaveragebitrate|cbr|useinbandfec|usedtx)=/i.test(part.trim()))
      .join(';');
    const musicParams = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;cbr=1;useinbandfec=1;usedtx=0';
    return `a=fmtp:${pt} ${cleaned ? `${cleaned};${musicParams}` : musicParams}`;
  });
}

// Server-enforced reaction set; /config replaces this with the live list.
const DEFAULT_CHAT_REACTIONS = ['❤️', '🔥', '😂', '👏', '🙏', '🎵'];
// Free emoji the composer can insert into a message.
const CHAT_COMPOSER_EMOJI = ['😀', '😂', '😍', '🥹', '😎', '🙌', '👏', '🙏', '❤️', '🔥', '🎵', '🎶', '🪔', '💃', '🕺', '✨'];

const state = {
  chatReactions: [...DEFAULT_CHAT_REACTIONS],
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
  fileAudioElement: null,
  fileAudioObjectUrl: null,
  audioContext: null,
  audioElement: null,
  audioNeedsGesture: false,
  mediaRelay: { ...DEFAULT_MEDIA_RELAY_CONFIG },
  relayCaptureStream: null,
  relayCaptureSource: null,
  relayProcessor: null,
  relaySink: null,
  relayPacketizer: null,
  relayCaptureEpoch: null,
  relayPublisherAnalyser: null,
  relayPublisherGeneration: 0,
  relayPublisherStarting: null,
  relaySequence: 0,
  relaySentFrames: 0,
  relayReceivedFrames: 0,
  relayDroppedSequenceFrames: 0,
  relayWorkletBufferedMs: 0,
  relayWorkletUnderruns: 0,
  relayPlaybackContext: null,
  relayPlaybackGain: null,
  relayPlaybackAnalyser: null,
  relayPlaybackWorklet: null,
  relayPlaybackWorkletReady: false,
  relayPlaybackWorkletLoading: null,
  relayPlaybackAudio: null,
  relayPlaybackDestination: null,
  relayPlaybackEpoch: null,
  relayPlaybackNextTime: 0,
  relayPlaybackSources: new Set(),
  relayLastSequence: null,
  relayUnavailableNotified: false,
  visualizerRaf: null,
  liveAudioLevel: 0,
  muted: false,
  volume: clampVolume(localStorage.getItem('roomsound-volume') ?? 0.9),
  syncOffsetMs: clampSyncOffsetMs(localStorage.getItem('roomsound-sync-offset-ms') ?? 150),
  peers: new Map(),
  pendingIntent: null,
  lastSourceId: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  explicitLeave: false,
  pendingRoomEnd: false,
  lastRoomCode: null,
  lastDisplayName: null,
  captureNonce: 0,
  captureRecoveryPending: false,
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

function applyAdSenseConfig(config) {
  const providerMeta = document.querySelector('meta[name="roomsound-ad-provider"]');
  const clientMeta = document.querySelector('meta[name="roomsound-ad-client"]');
  const enabledMeta = document.querySelector('meta[name="roomsound-ad-enabled"]');
  const landingSlot = $('#landing-ad-slot');
  const roomSlot = $('#room-ad-slot');
  const enabled = config?.enabled === true && config?.provider === 'adsense';
  if (providerMeta) providerMeta.content = enabled ? 'adsense' : '';
  if (clientMeta) clientMeta.content = enabled ? String(config.client || '') : '';
  if (enabledMeta) enabledMeta.content = String(enabled);
  if (landingSlot) landingSlot.dataset.adSlot = enabled ? String(config.landingSlot || '') : '';
  if (roomSlot) roomSlot.dataset.adSlot = enabled ? String(config.roomSlot || '') : '';
  initializeAdSlots();
  wireGlobalCookieBanner();
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
    if (Array.isArray(j.chatReactions)) {
      const reactions = j.chatReactions.filter((emoji) => typeof emoji === 'string' && emoji.length <= 16).slice(0, 12);
      if (reactions.length) state.chatReactions = reactions;
    }
    if (j.rewardedAccess) state.rewardedAccessConfig = normalizeRewardedAccessConfig(j.rewardedAccess);
    applyAdSenseConfig(j.adsense);
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
  return true;
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

  gate.hidden = true;
  gate.classList.remove('access-active');
  status.textContent = 'Free access — no timer';
  if (copy) copy.textContent = 'Room creation and joining are free and unrestricted.';
  button.disabled = true;
  button.textContent = 'Free access active';
  button.hidden = true;
  if (progress) progress.hidden = true;
  if (progressLabel) progressLabel.textContent = '';
  createButton.disabled = false;
  joinButton.disabled = false;
  createButton.removeAttribute('aria-disabled');
  joinButton.removeAttribute('aria-disabled');
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
  if (state.rewardedAccessConfig?.enabled === false) return;
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
    IOS_REPLAYKIT: 'device audio',
  };
  return labels[type] || 'audio';
}

function currentMobileAudioGuidance() {
  return typeof navigator === 'undefined' ? null : mobileAudioCaptureGuidance(navigator.userAgent);
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

function normalizeRoomCodeInput(value) {
  return String(value || '').replace(/[\s-]+/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function roomUrlForCode(roomCode) {
  const url = new URL('/', location.origin);
  const code = normalizeRoomCodeInput(roomCode);
  if (code) url.searchParams.set('room', code);
  return url.href;
}

function notificationRoomCodeFromLocation() {
  try {
    return normalizeRoomCodeInput(new URLSearchParams(location.search).get('room')) || null;
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
      console.warn('[SangeetPitara] notification service worker unavailable', error);
      return null;
    });
  return state.notificationSetupPromise;
}

function normalizeNotificationAction(data) {
  const action = data?.action === 'approve' || data?.action === 'reject' ? data.action : '';
  const requestId = String(data?.requestId || '').trim();
  let roomCode = normalizeRoomCodeInput(data?.roomCode);
  if (!roomCode && data?.roomUrl) {
    try { roomCode = normalizeRoomCodeInput(new URL(data.roomUrl, location.origin).searchParams.get('room')); } catch {}
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
  selectEntryTab('join');
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
    toast('This browser cannot show SangeetPitara action notifications.', 'error');
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
      toast('SangeetPitara could not enable system request notifications.', 'error');
    }
    return;
  }

  try {
    await registration.showNotification(`${request.requesterName} wants to share audio`, {
      body: `${state.room.name} · Approve or reject this control request.`,
      icon: '/branding/sangeetpitara/05-diya-eighth-note.svg?v=20261020-sangeetpitara-2',
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
    console.warn('[SangeetPitara] could not show request notification', error);
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

const WAVEFORM_BARS = 48;
const SILENT_SHARE_LEVEL = 0.01;
const SILENT_SHARE_WARNING_MS = 10_000;

function audioLevel(analyser, samples) {
  analyser.getByteTimeDomainData(samples);
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.min(1, Math.sqrt(sumSquares / samples.length) * 2.4);
}

/** Mirrored frequency bars on the source card; flat when nothing is playing. */
function drawSourceWaveform(analyser) {
  const canvas = $('#source-waveform');
  const context = canvas?.getContext?.('2d');
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  if (bins) analyser.getByteFrequencyData(bins);
  const color = getComputedStyle(canvas).color || '#ebc979';
  context.fillStyle = color;
  const slot = width / WAVEFORM_BARS;
  const barWidth = Math.max(1, slot * 0.56);
  const middle = height / 2;
  // Use the lower ~70% of the spectrum, where music actually has energy.
  const usable = bins ? Math.floor(bins.length * 0.7) : 0;
  for (let bar = 0; bar < WAVEFORM_BARS; bar += 1) {
    let value = 0;
    if (bins && usable) {
      const from = Math.floor((bar / WAVEFORM_BARS) * usable);
      const to = Math.max(from + 1, Math.floor(((bar + 1) / WAVEFORM_BARS) * usable));
      for (let i = from; i < to; i += 1) value = Math.max(value, bins[i]);
      value /= 255;
    }
    const half = Math.max(ratio, value * middle * 0.94);
    const x = bar * slot + (slot - barWidth) / 2;
    context.globalAlpha = 0.35 + value * 0.65;
    context.beginPath();
    if (context.roundRect) context.roundRect(x, middle - half, barWidth, half * 2, barWidth / 2);
    else context.rect(x, middle - half, barWidth, half * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

/** Warns the sharer once per share when their capture stays silent. */
function checkSilentShare(level) {
  if (!isSelfSource() || state.room?.sourceStatus !== 'LIVE' || !state.captureStream) {
    state.silentShareSince = null;
    return;
  }
  if (level > SILENT_SHARE_LEVEL) {
    state.silentShareSince = null;
    return;
  }
  const now = performance.now();
  state.silentShareSince ??= now;
  if (now - state.silentShareSince < SILENT_SHARE_WARNING_MS || state.silentShareWarnedFor === state.captureStream) return;
  state.silentShareWarnedFor = state.captureStream;
  toast('No sound is reaching the room. If you shared a tab or screen, stop and share again with "Share tab audio" (or "Share system audio") turned on.', 'bad');
}

function updateSourceOrbVisualizer() {
  const orb = $('#source-orb');
  const analyser = state.relayPlaybackAnalyser || state.relayPublisherAnalyser;
  if (!analyser || !state.room?.activeSourceId || state.room?.sourceStatus !== 'LIVE') {
    if (orb) orb.style.transform = '';
    drawSourceWaveform(null);
    state.liveAudioLevel = 0;
    state.silentShareSince = null;
    state.visualizerRaf = null;
    return;
  }
  const samples = new Uint8Array(analyser.fftSize);
  state.liveAudioLevel = audioLevel(analyser, samples);
  if (orb) orb.style.transform = `scale(${(1 + state.liveAudioLevel * 0.16).toFixed(3)})`;
  drawSourceWaveform(analyser);
  // The sharer's own playback analyser is absent, so this reads their capture.
  if (state.relayPublisherAnalyser) {
    const published = analyser === state.relayPublisherAnalyser
      ? state.liveAudioLevel
      : audioLevel(state.relayPublisherAnalyser, new Uint8Array(state.relayPublisherAnalyser.fftSize));
    checkSilentShare(published);
  }
  state.visualizerRaf = requestAnimationFrame(updateSourceOrbVisualizer);
}

function ensureVisualizerLoop() {
  if (state.visualizerRaf || typeof requestAnimationFrame !== 'function') return;
  state.visualizerRaf = requestAnimationFrame(updateSourceOrbVisualizer);
}

function sendRelayPcmFrame(samples, sourceEpoch, capturedSequence = null) {
  if (!isMediaRelayEnabled() || !isSelfSource() || state.room?.sourceEpoch !== sourceEpoch || state.room?.sourceStatus !== 'LIVE') return;
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const sequence = capturedSequence ?? state.relaySequence;
  state.relaySequence = (sequence + 1) >>> 0;
  const frameBytes = 20 + samples.byteLength;
  if ((Number(state.ws.bufferedAmount) || 0) + frameBytes > MEDIA_RELAY_MAX_BACKLOG_BYTES) return;
  try {
    const frame = encodePcm16Frame({
      sourceEpoch,
      sequence,
      samples,
    });
    state.ws.send(frame);
    state.relaySentFrames += 1;
  } catch (error) {
    console.warn('[SangeetPitara] PCM16 relay frame was not sent', error);
  }
}

function stopRelayCapture() {
  state.relayPublisherGeneration += 1;
  state.relayPublisherStarting = null;
  if (state.relayProcessor) {
    if (state.relayProcessor.port) {
      state.relayProcessor.port.postMessage({ type: 'stop' });
      state.relayProcessor.port.onmessage = null;
      state.relayProcessor.port.close();
    }
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

function syncRelayCaptureLease() {
  const epoch = isSelfSource() && state.room?.sourceStatus === 'LIVE' ? state.room.sourceEpoch : null;
  if (state.relayCaptureEpoch === epoch) return;
  state.relayCaptureEpoch = epoch;
  state.relaySequence = 0;
  state.relayPacketizer?.reset();
  state.relayProcessor?.port?.postMessage({ type: 'lease', epoch });
}

async function ensureRelayPublisher() {
  if (!isMediaRelayEnabled() || !state.captureStream) return false;
  if (state.relayCaptureStream === state.captureStream && state.relayProcessor) {
    syncRelayCaptureLease();
    return true;
  }
  if (state.relayPublisherStarting === state.captureStream) return false;

  stopRelayCapture();
  const generation = state.relayPublisherGeneration;
  const stream = state.captureStream;
  state.relayPublisherStarting = stream;
  let source;
  let processor;
  let sink;
  try {
    const context = state.audioContext && state.audioContext.state !== 'closed'
      ? state.audioContext
      : createRoomAudioContext();
    state.audioContext = context;
    // Resume before awaiting module loading so the user gesture is not lost.
    if (context.state !== 'running') void context.resume().catch(() => {});
    const current = () => state.relayPublisherGeneration === generation && state.captureStream === stream && isMediaRelayEnabled();
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await context.audioWorklet.addModule('/relay-capture-worklet.js?v=20261025-redesign');
        if (!current()) return false;
        processor = new AudioWorkletNode(context, 'roomsound-relay-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers',
        });
        processor.port.postMessage({ type: 'config', maxInFlight: 64 });
        const node = processor;
        node.port.onmessage = ({ data }) => {
          if (!current() || state.relayProcessor !== node) return;
          node.port.postMessage({ type: 'ack' });
          if (!(data?.samples instanceof Int16Array)) return;
          // Allow up to 1 s for background-tab message delivery before dropping.
          if (context.currentTime - data.capturedAt > RELAY_CAPTURE_MAX_AGE_SECONDS) return;
          sendRelayPcmFrame(data.samples, data.sourceEpoch, data.sequence);
        };
      } catch (error) {
        if (!current()) return false;
        console.warn('[SangeetPitara] AudioWorklet unavailable; using compatible capture.', error);
      }
    }
    if (!current()) return false;
    if (!processor) {
      processor = context.createScriptProcessor(RELAY_PROCESSOR_BUFFER_SAMPLES, 1, 1);
      const packetizer = new RelayPcmPacketizer();
      const node = processor;
      node.onaudioprocess = (event) => {
        if (!current() || state.relayProcessor !== node) return;
        syncRelayCaptureLease();
        const epoch = state.relayCaptureEpoch;
        if (epoch === null) { packetizer.reset(); return; }
        packetizer.push(event.inputBuffer.getChannelData(0), context.sampleRate, (samples) => sendRelayPcmFrame(samples, epoch));
      };
      state.relayPacketizer = packetizer;
    }
    source = context.createMediaStreamSource(stream);
    if (context.createAnalyser) {
      const pubAnalyser = context.createAnalyser();
      pubAnalyser.fftSize = 512; // Enough bins for the waveform; RMS reads the same data.
      source.connect(pubAnalyser);
      state.relayPublisherAnalyser = pubAnalyser;
      ensureVisualizerLoop();
    }
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    // A muted sink keeps capture processing pulled without local echo.
    processor.connect(sink);
    sink.connect(context.destination);
    state.relayCaptureStream = stream;
    state.relayCaptureSource = source;
    state.relayProcessor = processor;
    state.relaySink = sink;
    state.relayCaptureEpoch = null;
    syncRelayCaptureLease();
    return true;
  } catch (error) {
    try { source?.disconnect(); } catch {}
    try { processor?.disconnect(); processor?.port?.close(); } catch {}
    try { sink?.disconnect(); } catch {}
    if (generation !== state.relayPublisherGeneration) return false;
    stopRelayCapture();
    if (!state.relayUnavailableNotified) {
      state.relayUnavailableNotified = true;
      toast(error?.message || 'This browser could not start PCM16 audio relay.', 'error');
    }
    return false;
  } finally {
    if (generation === state.relayPublisherGeneration) state.relayPublisherStarting = null;
  }
}

function setupRelayPlaybackWorklet(context, gain) {
  if (!context?.audioWorklet || typeof AudioWorkletNode === 'undefined' || state.relayPlaybackWorkletLoading) return;
  state.relayPlaybackWorkletLoading = context.audioWorklet.addModule('/relay-playout-worklet.js?v=20261025-redesign')
    .then(() => {
      if (state.relayPlaybackContext !== context || state.relayPlaybackGain !== gain) return;
      const worklet = new AudioWorkletNode(context, 'roomsound-relay-playout', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      worklet.port.postMessage({ type: 'config', targetDelayMs: state.syncOffsetMs });
      worklet.port.onmessage = ({ data }) => {
        if (data?.type === 'stats') {
          state.relayWorkletBufferedMs = data.bufferedMs ?? 0;
          state.relayWorkletTargetMs = data.targetMs ?? state.syncOffsetMs;
          state.relayWorkletJitterMs = data.jitterMs ?? 0;
          state.relayWorkletUnderruns = data.underruns ?? 0;
          renderTelemetry();
        }
      };
      worklet.connect(gain);
      state.relayPlaybackWorklet = worklet;
      state.relayPlaybackWorkletReady = true;
    })
    .catch((error) => {
      console.warn('[SangeetPitara] RelayPlayoutProcessor unavailable; using buffered fallback scheduler.', error);
    });
}

function ensureRelayPlaybackContext() {
  if (state.relayPlaybackContext && state.relayPlaybackContext.state !== 'closed') return state.relayPlaybackContext;
  try {
    const context = createRoomAudioContext();
    const gain = context.createGain();
    const analyser = context.createAnalyser ? context.createAnalyser() : null;
    if (analyser) {
      analyser.fftSize = 512;
      gain.connect(analyser);
    }
    // Route PCM through a real media element for Android background media-session
    // persistence, while also connecting directly to context.destination on desktop
    // browsers so desktop audio avoids extra MediaStream loopback buffering.
    const destination = context.createMediaStreamDestination();
    gain.connect(destination);
    const isAndroidBrowser = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    if (!isAndroidBrowser) {
      gain.connect(context.destination);
    }
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    audio.volume = 1;
    audio.muted = !isAndroidBrowser;
    audio.srcObject = destination.stream;
    audio.setAttribute('aria-label', 'Room audio — use Your listening controls to adjust volume');
    audio.style.position = 'fixed';
    audio.style.width = '1px';
    audio.style.height = '1px';
    audio.style.opacity = '0';
    audio.style.pointerEvents = 'none';
    document.body.append(audio);
    state.relayPlaybackContext = context;
    state.relayPlaybackGain = gain;
    state.relayPlaybackAnalyser = analyser;
    state.relayPlaybackDestination = destination;
    state.relayPlaybackAudio = audio;
    applyOutputVolume();
    setupRelayPlaybackWorklet(context, gain);
    ensureVisualizerLoop();
    if (typeof navigator !== 'undefined' && navigator.mediaSession && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Room audio',
        artist: state.room?.name || 'SangeetPitara',
      });
    }
    const relayAudio = audio;
    void relayAudio.play().catch(() => {
      if (isAndroidBrowser) {
        state.audioNeedsGesture = true;
        renderControls();
      }
    });
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
  if (state.relayPlaybackWorklet?.port) {
    try { state.relayPlaybackWorklet.port.postMessage({ type: 'reset' }); } catch {}
  }
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
  if (state.visualizerRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(state.visualizerRaf);
    state.visualizerRaf = null;
  }
  try { state.relayPlaybackWorklet?.disconnect(); } catch {}
  const audio = state.relayPlaybackAudio;
  if (audio) {
    try { audio.pause(); } catch {}
    audio.srcObject = null;
    audio.remove();
  }
  try { state.relayPlaybackGain?.disconnect(); } catch {}
  const context = state.relayPlaybackContext;
  state.relayPlaybackWorklet = null;
  state.relayPlaybackWorkletReady = false;
  state.relayPlaybackWorkletLoading = null;
  state.relayPlaybackAnalyser = null;
  state.relayPlaybackGain = null;
  state.relayPlaybackDestination = null;
  state.relayPlaybackAudio = null;
  state.relayPlaybackContext = null;
  if (context && context.state !== 'closed') void context.close().catch(() => {});
}

function handleRelayFrame(data) {
  if (!isMediaRelayEnabled()) return;
  let frame;
  try {
    frame = decodePcm16Frame(data);
  } catch (error) {
    console.warn('[SangeetPitara] ignored invalid PCM16 relay frame', error);
    return;
  }
  const room = state.room;
  if (!room?.activeSourceId || room.activeSourceId === state.self?.id || frame.sourceEpoch !== room.sourceEpoch) return;
  if (state.relayPlaybackEpoch !== frame.sourceEpoch) resetRelayPlaybackQueue(frame.sourceEpoch);
  if (state.relayLastSequence !== null) {
    const distance = (frame.sequence - state.relayLastSequence) >>> 0;
    if (distance === 0 || distance > 0x80000000) return;
    if (distance > 1) state.relayDroppedSequenceFrames += (distance - 1);
  }
  state.relayReceivedFrames += 1;

  const context = ensureRelayPlaybackContext();
  if (!context || !state.relayPlaybackGain) return;
  ensureVisualizerLoop();

  // Primary Studio-Grade Playout Path: AudioWorklet ring buffer with PI clock-drift control
  if (state.relayPlaybackWorkletReady && state.relayPlaybackWorklet?.port) {
    state.relayPlaybackWorklet.port.postMessage({
      type: 'pcm',
      samples: frame.samples,
      channels: frame.channels || 1,
    });
    state.relayLastSequence = frame.sequence;
    if (context.state !== 'running') {
      state.audioNeedsGesture = true;
      renderControls();
    } else if (state.audioNeedsGesture) {
      state.audioNeedsGesture = false;
      renderControls();
    }
    return;
  }

  // Compatibility Fallback Path (with initial prefill cushion & expanded 650 ms window)
  const now = context.currentTime;
  if (state.relayPlaybackNextTime > now + RELAY_MAX_PLAYAHEAD_SECONDS) resetRelayPlaybackQueue(frame.sourceEpoch);
  const initialCushion = Math.max(0.04, state.syncOffsetMs / 1000);
  const targetNext = state.relayPlaybackNextTime || (now + initialCushion);
  const startAt = Math.max(Math.max(now + 0.01, state.relayPlaybackNextTime || 0), targetNext);
  const channels = frame.channels === 2 ? 2 : 1;
  const buffer = context.createBuffer(channels, frame.sampleCount, frame.sampleRate);
  if (channels === 2) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let index = 0; index < frame.sampleCount; index += 1) {
      left[index] = frame.samples[index * 2] / 0x8000;
      right[index] = frame.samples[index * 2 + 1] / 0x8000;
    }
  } else {
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frame.samples.length; index += 1) channel[index] = frame.samples[index] / 0x8000;
  }
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
    console.warn('[SangeetPitara] PCM16 relay playback scheduling failed', error);
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

function openMobileAudioGuide() {
  const guidance = currentMobileAudioGuidance();
  if (!guidance) return false;
  const roomCode = state.room?.code ? ` Room code: <strong>${escapeHtml(state.room.code)}</strong>.` : '';
  const download = guidance.downloadHref
    ? `<a class="primary-button mobile-audio-download" href="${escapeHtml(guidance.downloadHref)}" download>${escapeHtml(guidance.downloadLabel)}</a>`
    : '';
  const steps = guidance.downloadHref
    ? '<ol class="mobile-audio-steps"><li>Open or install the SangeetPitara Android app (or tap <strong>Share audio file</strong> in the room to stream a local MP3/WAV file directly from this browser).</li><li>Join this same room with the displayed code.</li><li>Request device audio, approve it on the laptop, then tap <strong>Share device audio</strong> in the app.</li></ol>'
    : '<p class="mobile-audio-followup">Tip: You can tap <strong>Share audio file</strong> right here in your browser to stream any local audio file, or return to a desktop browser for tab audio sharing.</p>';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="mobile-audio-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-audio-guide-title"><div class="modal-eyebrow">PHONE AUDIO SHARING</div><h2 id="mobile-audio-guide-title">${escapeHtml(guidance.title)}</h2><p>${escapeHtml(guidance.message)}${roomCode}</p>${steps}<div class="mobile-audio-actions">${download}<button class="modal-close" type="button">Close</button></div></div>`;
  $('#modal-root').replaceChildren(modal);
  const dismiss = () => modal.remove();
  modal.addEventListener('click', (event) => {
    if (event.target === modal) dismiss();
  });
  modal.querySelector('.modal-close').addEventListener('click', dismiss);
  (modal.querySelector('.mobile-audio-download') || modal.querySelector('.modal-close')).focus();
  return true;
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
  const known = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of messages || []) {
    const existing = known.get(message.id);
    // A rejoin resends history; keep its newer reaction counts.
    if (existing) existing.reactions = message.reactions;
    else state.messages.push(message);
  }
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

function selectEntryTab(entryType) {
  const selectedType = entryType === 'join' ? 'join' : 'create';
  $$('.entry-tab').forEach((tab) => {
    const selected = tab.dataset.entryTab === selectedType;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  $$('.entry-panel').forEach((panel) => {
    const selected = panel.id === `${selectedType}-panel`;
    panel.classList.toggle('active-panel', selected);
    panel.hidden = !selected;
    panel.setAttribute('aria-hidden', String(!selected));
  });
}

function resetToLanding(reason = '') {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnectAttempts = 0;
  state.explicitLeave = true;
  state.pendingRoomEnd = false;
  state.pendingIntent = null;
  state.lastRoomCode = null;
  closeRoomMenu();
  $('#modal-root')?.replaceChildren();
  closePeerConnections();
  stopLocalCapture(false);
  closeRelayPlayback();
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
    const message = 'This phone is opening localhost on itself. Open SangeetPitara from the laptop LAN address, for example http://192.168.1.20:4173.';
    setConnection('Use LAN address', false);
    showLanding(message);
    return;
  }

  const displayName = isReconnect ? state.lastDisplayName : $('#display-name').value.trim();
  if (!isReconnect && !displayName) {
    showLanding('Enter your name before entering a room.');
    $('#display-name')?.focus();
    return;
  }
  if (!isReconnect && action.type === 'create' && !action.roomName?.trim()) {
    showLanding('Enter a room name before creating a room.');
    $('#room-name')?.focus();
    return;
  }
  const normalizedAction = action.type === 'join'
    ? { ...action, code: normalizeRoomCodeInput(action.code) }
    : action;
  state.pendingIntent = { ...normalizedAction, displayName };
  if (!isReconnect) {
    state.explicitLeave = false;
    if (action.type === 'create') state.lastDisplayName = displayName;
    else { state.lastDisplayName = displayName; state.lastRoomCode = normalizedAction.code || state.lastRoomCode; }
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }
  $('#entry-error').classList.add('hidden');
  setConnection(isReconnect ? 'Reconnecting' : 'Connecting', true);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) state.ws.close();
  if (state.reconnectTimer && !isReconnect) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  const socket = new WebSocket(`${protocol}//${location.host}`);
  socket.binaryType = 'arraybuffer';
  state.ws = socket;
  const isCurrentSocket = () => state.ws === socket;
  socket.addEventListener('open', () => {
    if (!isCurrentSocket()) return;
    setConnection('Live', true);
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    const intent = { ...state.pendingIntent };
    const sendOnSocket = (payload) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    if (intent.type === 'create') {
      sendOnSocket({ type: 'create-room', name: intent.roomName, displayName: intent.displayName, guestId, reconnectSecret });
    } else {
      sendOnSocket({ type: 'join-room', code: intent.code, displayName: intent.displayName, guestId, reconnectSecret });
    }
  });
  socket.addEventListener('close', (event) => {
    if (!isCurrentSocket()) return;
    const code = event.code;
    const reason = event.reason || '';
    if (state.pendingRoomEnd) {
      resetToLanding();
      toast('The host ended the room.', 'bad');
      return;
    }
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
      if (state.room.activeSourceId === state.self?.id && state.captureStream) state.captureRecoveryPending = true;
      $('#room-banner').textContent = 'Connection lost — reconnecting…';
      $('#room-banner').classList.remove('hidden');
      addActivity('Connection lost — reconnecting…', true);
      scheduleReconnect();
      toast('Connection lost. Reconnecting…', 'bad');
    } else {
      if (state.lastRoomCode && !state.explicitLeave) scheduleReconnect();
    }
  });
  socket.addEventListener('error', () => {
    if (!isCurrentSocket()) return;
    setConnection('Offline', false);
    if (!state.room) showLanding('Could not connect to the SangeetPitara server. Is it running?');
    else if (!state.explicitLeave) scheduleReconnect();
  });
  socket.addEventListener('message', (event) => {
    if (!isCurrentSocket()) return;
    if (typeof event.data !== 'string') {
      if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        void event.data.arrayBuffer().then(handleRelayFrame).catch((error) => {
          console.warn('[SangeetPitara] could not read PCM16 relay frame', error);
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
      showLanding(`The SangeetPitara server sent an invalid message: ${error.message || 'invalid JSON'}`);
    }
  });
}

function handleServerMessage(message) {
  if (message.type === 'error') {
    state.pendingRoomEnd = false;
    toast(message.message, 'error');
    if (!state.room) showLanding(message.message);
    if (message.message.includes('full') || message.message.includes('unavailable') || message.message.includes('ended')) {
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    }
    return;
  }
  if (message.type === 'joined') {
    state.pendingRoomEnd = false;
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
    if (message.state?.room?.code) state.lastRoomCode = message.state.room.code;
    return;
  }
  if (message.type === 'chat') {
    addMessages([message.message]);
    if (message.message.kind === 'system') toast(message.message.text, 'success');
    return;
  }
  if (message.type === 'reaction') {
    const target = state.messages.find((item) => item.id === message.messageId);
    if (target) {
      target.reactions = message.reactions;
      renderChat();
    }
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
      toast(currentMobileAudioGuidance()
        ? 'Your request was approved. Use the Android app to share phone audio.'
        : 'Your request was approved. Tap Share audio to open the browser picker.', 'success');
      addActivity('You were approved to share audio.', true);
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
    resetRelayPlaybackQueue(state.room?.sourceEpoch ?? null);
  }
  syncRelayCaptureLease();
  const wasHostSource = wasSelfSource && state.self?.role === 'HOST';
  if (wasSelfSource && state.room.activeSourceId !== state.self?.id && !wasHostSource) stopLocalCapture(false);
  if (state.captureRecoveryPending && wasHostSource && state.captureStream && !state.room.activeSourceId && state.room.sourceStatus === 'NONE') {
    send({ type: 'start-source', sourceType: state.captureType || 'DEVICE_AUDIO', sourceLabel: state.captureLabel || 'Browser device audio' });
    state.captureRecoveryPending = false;
  }
  {
    const onlineNow = new Set(state.members.filter((m) => m.online).map((m) => m.id));
    for (const pm of prevMembers) {
      if (pm.online && !onlineNow.has(pm.id) && state.peers.has(pm.id)) {
        const entry = state.peers.get(pm.id);
        removePeerConnection(pm.id, entry);
      }
    }
    if (previousSource && !onlineNow.has(previousSource) && state.peers.has(previousSource)) {
      const entry = state.peers.get(previousSource);
      removePeerConnection(previousSource, entry);
    }
  }
  renderAll();
  if (state.room.activeSourceId && state.room.activeSourceId !== state.self?.id && isMediaRelayEnabled()) {
    ensureRelayPlaybackContext();
  }
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
  $('#member-count').textContent = state.members.filter((m) => m.online).length;
  $('#end-room')?.classList.toggle('hidden', state.self?.role !== 'HOST');
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
  $('#source-kicker').textContent = live ? (starting ? 'Connecting…' : `Now playing · ${sourceLabel(state.room.activeSourceType)}`) : 'Nothing playing';
  $('#source-title').textContent = live ? `${sourceMember.name} is sharing` : 'The room is quiet';
  $('#source-detail').textContent = live
    ? (starting ? 'Waiting for the source device…' : 'Everyone in the room can listen.')
    : 'Choose an audio source to start sharing with the room.';
  $('#source-status-label').textContent = live ? (starting ? 'Starting' : 'Live') : 'Waiting';
  // Draw resting bars once the card has a size; the live loop takes over while audio plays.
  if (!state.visualizerRaf && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (!state.visualizerRaf) drawSourceWaveform(null); });
}

function renderControls() {
  const moderator = isModerator();
  const mobileAudio = currentMobileAudioGuidance();
  const activeOther = Boolean(state.room?.activeSourceId && state.room.activeSourceId !== state.self?.id);
  const sourceIsParticipant = activeOther && state.members.find((member) => member.id === state.room.activeSourceId)?.role === 'PARTICIPANT';
  $('#host-controls').classList.toggle('hidden', !moderator);
  $('#participant-controls').classList.toggle('hidden', moderator);

  if (moderator) {
    $('#share-audio').classList.toggle('hidden', isSelfSource());
    $('#share-file-audio')?.classList.toggle('hidden', isSelfSource());
    if (mobileAudio) $('#share-audio').textContent = 'Use Android app';
    else $('#share-audio').innerHTML = '<span class="button-icon">◉</span> Share audio';
    $('#stop-audio').classList.toggle('hidden', !isSelfSource());
    $('#takeover-audio').classList.toggle('hidden', !activeOther);
    $('#enable-audio').classList.toggle('hidden', !state.audioNeedsGesture || isSelfSource());
  } else {
    const myRequest = state.requests.find((request) => request.requesterId === state.self?.id && request.status === 'PENDING');
    const selfIsSource = isSelfSource();
    const requestTitle = $('#request-controls-title');
    const requestStatus = $('#request-control-status');
    $('#request-audio').classList.toggle('hidden', Boolean(myRequest || selfIsSource));
    $('#share-file-audio-participant')?.classList.toggle('hidden', !selfIsSource || Boolean(state.captureStream));
    $('#cancel-request').classList.toggle('hidden', !myRequest);
    $('#cancel-request').dataset.requestId = myRequest?.id || '';
    $('#ask-takeover').classList.toggle('hidden', !sourceIsParticipant);
    $('#request-audio').innerHTML = '<span>↗</span> Request to play';
    if (selfIsSource) {
      $('#request-audio').classList.remove('hidden');
      if (state.captureStream) $('#request-audio').textContent = 'Stop sharing';
      else $('#request-audio').textContent = 'Share audio';
    }
    $('#enable-audio-participant').classList.toggle('hidden', !state.audioNeedsGesture || selfIsSource);
    if (requestTitle && requestStatus) {
      if (selfIsSource) {
        requestTitle.textContent = 'You are sharing audio';
        requestStatus.textContent = state.captureStream
          ? 'Your room audio is live. Stop sharing when you are done.'
          : mobileAudio
            ? 'You were approved. Mobile browsers cannot capture playback from another phone app; use the Android app to share phone audio.'
            : 'You were approved. Tap Share audio to open the browser picker.';
      } else if (myRequest) {
        requestTitle.textContent = 'Waiting for host approval';
        requestStatus.textContent = 'Your request is in the queue. You can cancel it here if you change your mind.';
      } else if (sourceIsParticipant) {
        requestTitle.textContent = 'Request your turn to share audio';
        requestStatus.textContent = 'Another listener is sharing now, but you can still ask the host to review your request. Approval will hand control to you and preserve the current source for resumption.';
      } else {
        requestTitle.textContent = 'Ask to share audio';
        requestStatus.textContent = mobileAudio
          ? 'Request host approval here. Mobile browsers cannot capture playback from another phone app; use the Android app for phone audio after approval.'
          : 'Request host approval when you want to play something for the room.';
      }
      if (state.audioNeedsGesture && !selfIsSource) requestStatus.textContent += ' Tap Enable room audio to start playback.';
    }
  }
}

function renderMembers() {
  const host = state.room.hostId;
  const cohost = state.room.cohostId;
  const sortedMembers = [...state.members].sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)));
  $('#member-list').innerHTML = sortedMembers.map((member) => {
    const isHost = member.id === host;
    const isCohost = member.id === cohost;
    const isSource = member.id === state.room.activeSourceId && state.room.sourceStatus !== 'NONE';
    const baseRole = isHost ? 'Host' : isCohost ? 'Co-host' : isSource ? 'Sharing now' : 'Listener';
    const role = member.online ? baseRole : `${baseRole} · Offline`;
    const roleClass = !member.online ? '' : (isHost || isSource ? 'green-role' : isCohost ? 'orange-role' : '');
    const canManage = isModerator() && member.id !== state.self?.id && !isHost;
    let actions = '';
    if (canManage) {
      const grantBtn = member.online && !isSource
        ? `<button class="tiny-button primary-tiny" data-action="grant-source" data-member-id="${member.id}">Allow to play</button>`
        : isSource
          ? `<button class="tiny-button" data-action="stop-member-source" data-member-id="${member.id}">Stop audio</button>`
          : '';
      const cohostBtn = state.self?.role === 'HOST' && member.online
        ? `<button class="tiny-button" data-action="cohost" data-member-id="${member.id}">${isCohost ? 'Remove co-host' : 'Make co-host'}</button>`
        : '';
      const removeBtn = `<button class="tiny-button danger-tiny" data-action="remove" data-member-id="${member.id}">${member.online ? 'Remove' : 'Clear'}</button>`;
      actions = `<div class="member-actions">${grantBtn}${cohostBtn}${removeBtn}</div>`;
    }
    return `<div class="member-item ${member.online ? '' : 'member-offline'}"><div class="member-avatar">${escapeHtml(initials(member.name))}</div><div class="member-info"><div class="member-name-row"><span class="member-name">${escapeHtml(member.name)}</span>${member.id === state.self?.id ? '<span class="member-you">YOU</span>' : ''}</div><div class="member-role"><span class="role-badge ${roleClass}">${role}</span></div>${actions}</div><span class="member-state ${member.online ? 'online' : ''} ${isSource ? 'source' : ''}" title="${member.online ? 'Online' : 'Offline'}"></span></div>`;
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

function chatReactionsHtml(message) {
  const selfId = state.self?.id;
  const reactions = message.reactions && typeof message.reactions === 'object' ? message.reactions : {};
  const chips = state.chatReactions.map((emoji) => {
    const members = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const mine = selfId && members.includes(selfId);
    const label = `${mine ? 'Remove' : 'React with'} ${emoji}${members.length ? ` (${members.length})` : ''}`;
    return `<button type="button" class="reaction-chip${members.length ? ' has-count' : ''}${mine ? ' mine' : ''}" data-react-id="${escapeHtml(message.id)}" data-emoji="${escapeHtml(emoji)}" aria-pressed="${mine ? 'true' : 'false'}" aria-label="${escapeHtml(label)}">${escapeHtml(emoji)}${members.length ? `<span class="reaction-count">${members.length}</span>` : ''}</button>`;
  }).join('');
  return `<div class="chat-reactions">${chips}</div>`;
}

function insertComposerEmoji(emoji) {
  const input = $('#chat-input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const next = input.value.slice(0, start) + emoji + input.value.slice(end);
  if (next.length > Number(input.maxLength || 280)) return;
  input.value = next;
  const caret = start + emoji.length;
  input.focus();
  input.setSelectionRange(caret, caret);
}

function renderChat() {
  const feed = $('#chat-feed');
  if (!feed) return;
  const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
  const chat = state.messages.filter((message) => message.kind === 'chat');
  $('#chat-count').textContent = chat.length;
  feed.innerHTML = chat.length ? chat.map((message) => `<div class="chat-message"><div class="avatar">${escapeHtml(initials(message.senderName))}</div><div class="chat-body"><div class="chat-meta"><span class="chat-name">${escapeHtml(message.senderName)}</span><span class="chat-time">${timeLabel(message.createdAt)}</span></div><div class="chat-text">${escapeHtml(message.text)}</div>${chatReactionsHtml(message)}</div></div>`).join('') : '<div class="request-empty">Start the conversation with the room.</div>';
  if (wasNearBottom) feed.scrollTop = feed.scrollHeight;
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
    summary.textContent = `${sourceName} · epoch ${epoch} · PCM16 WebSocket relay (48 kHz)`;
    status.textContent = 'Relay';
    status.className = 'telemetry-state good';
    const isSender = isSelfSource();
    const frameCount = isSender ? state.relaySentFrames : state.relayReceivedFrames;
    const bufferLabel = isSender
      ? `${Math.round((Number(state.ws?.bufferedAmount) || 0) / 1024)} KB socket`
      : state.relayPlaybackWorkletReady
        ? `${state.relayWorkletBufferedMs} ms (${state.relayWorkletTargetMs || state.syncOffsetMs} ms auto)`
        : `${state.syncOffsetMs} ms cushion`;
    const engineLabel = isSender
      ? (state.relayProcessor && typeof AudioWorkletNode !== 'undefined' && state.relayProcessor instanceof AudioWorkletNode ? 'AudioWorklet capture' : 'Web Audio capture')
      : (state.relayPlaybackWorkletReady ? 'AudioWorklet PI ring' : 'Web Audio scheduler');
    list.innerHTML = `<article class="telemetry-peer">
      <div class="telemetry-peer-heading">
        <div><span class="telemetry-direction">${isSender ? 'PUBLISHING RELAY' : 'LISTENING RELAY'}</span><strong>${escapeHtml(sourceName)}</strong></div>
        <span class="telemetry-connection good"><i></i>48 kHz Hi-Fi</span>
      </div>
      <div class="telemetry-peer-states"><span>Engine <strong>${escapeHtml(engineLabel)}</strong></span><span>Epoch <strong>${escapeHtml(epoch)}</strong></span></div>
      <div class="telemetry-stats">
        <span><small>Frames</small><strong>${formatTelemetryCount(frameCount)}</strong><em>20 ms packets</em></span>
        <span><small>Buffer</small><strong>${escapeHtml(bufferLabel)}</strong><em>${state.relayWorkletUnderruns} underruns</em></span>
        <span><small>Level</small><strong>${formatAudioLevel(state.liveAudioLevel)}</strong><em>live RMS</em></span>
      </div>
    </article>`;
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

async function startLocalFileCapture(file) {
  if (!file) return;
  stopLocalCapture(false);
  const nonce = ++state.captureNonce;
  try {
    const context = createRoomAudioContext();
    state.audioContext = context;
    if (context.state !== 'running') await context.resume().catch(() => {});
    const objectUrl = URL.createObjectURL(file);
    const player = document.createElement('audio');
    player.src = objectUrl;
    player.loop = false;
    player.preload = 'auto';
    player.crossOrigin = 'anonymous';
    const elementSource = context.createMediaElementSource(player);
    const streamDest = context.createMediaStreamDestination();
    // Connect to both local speakers and the capture MediaStream so the host
    // hears the music track while streaming bit-perfect PCM to the room.
    elementSource.connect(context.destination);
    elementSource.connect(streamDest);
    await player.play();
    if (nonce !== state.captureNonce) {
      player.pause();
      URL.revokeObjectURL(objectUrl);
      return;
    }
    state.fileAudioElement = player;
    state.fileAudioObjectUrl = objectUrl;
    state.captureStream = streamDest.stream;
    state.captureType = 'DEVICE_AUDIO';
    state.captureLabel = file.name ? `file: ${file.name.slice(0, 48)}` : 'local audio file';
    player.addEventListener('ended', () => {
      if (state.fileAudioElement === player) {
        stopLocalCapture(true);
        toast('Audio file playback finished.', 'success');
      }
    }, { once: true });
    if (isMediaRelayEnabled() && !(await ensureRelayPublisher())) {
      if (nonce !== state.captureNonce) return;
      throw new Error('Audio file relay could not initialize.');
    }
    if (!isSelfSource() && isModerator()) {
      send({ type: 'takeover', sourceType: 'DEVICE_AUDIO' });
    }
    send({ type: 'start-source', sourceType: 'DEVICE_AUDIO', sourceLabel: state.captureLabel });
    toast(`Sharing ${state.captureLabel}.`, 'success');
    addActivity(`You started sharing ${state.captureLabel}.`, true);
  } catch (error) {
    if (nonce !== state.captureNonce) return;
    stopLocalCapture(false);
    toast(error?.message || 'Could not play the selected audio file.', 'error');
  }
}

async function startLocalCapture(sourceType, intent = 'host') {
  stopLocalCapture(false);
  const nonce = ++state.captureNonce;
  const mobileAudio = currentMobileAudioGuidance();
  try {
    let stream;
    let label;
    if (!window.isSecureContext) {
      const expected = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? ' Use the native Android app for device-audio, or serve this site over https so getDisplayMedia is allowed on LAN IPs.'
        : ' On this browser, http LAN URLs like http://10.x or http://192.168.x cannot capture device audio by design (Secure Context). Open the same site on the LAPTOP at http://localhost:4173, use the native Android app, or serve the page over https.';
      throw new Error(`Audio capture blocked: this page is not a secure context (${location.protocol}//${location.host}).${expected}`);
    }
    if (sourceType === 'DEVICE_AUDIO') {
      if (mobileAudio) throw new Error(mobileAudio.message);
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser does not expose display-audio capture. Try a current desktop browser or the Android app.');
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(displayAudioCaptureConstraints());
      } catch (e) {
        const n2 = e?.name || '';
        if (n2 === 'NotAllowedError' || n2 === 'PermissionDeniedError') throw new Error('Display capture was denied. Allow access and tick Share audio, then try again.');
        if (n2 === 'InvalidStateError') throw new Error('Display capture is already in use. Close the other picker and try again.');
        throw e;
      }
      try { prepareDisplayAudioStream(stream); } catch (e) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        const hint = e?.message ? ` ${e.message}` : ' The source did not provide audio.';
        throw new Error(`System audio was not captured.${hint} ${displayAudioCaptureGuidance(navigator.userAgent)}`);
      }
      label = 'device or browser audio';
    } else {
      throw new Error('Only device or browser playback audio is supported. SangeetPitara never streams a microphone.');
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
    if (isMediaRelayEnabled() && !(await ensureRelayPublisher())) {
      if (nonce !== state.captureNonce) return;
      throw new Error('Audio capture could not initialize. Please try sharing again.');
    }
    if (nonce !== state.captureNonce) return;
    if (intent === 'takeover') send({ type: 'takeover', sourceType });
    send({ type: 'start-source', sourceType, sourceLabel: label });
    toast(`Sharing ${label}.`, 'success');
    addActivity(`You started sharing ${label}.`, true);
  } catch (error) {
    if (nonce !== state.captureNonce) return;
    stopLocalCapture(false);
    if (intent === 'participant') send({ type: 'stop-source' });
    const openedMobileGuide = mobileAudio && openMobileAudioGuide();
    if (!openedMobileGuide) toast(error.message || 'Audio capture was not available.', 'error');
    addActivity(openedMobileGuide ? 'Use the Android app to share phone audio.' : 'Audio sharing could not start.', true);
  }
}

function stopLocalCapture(stopServer = true) {
  state.captureNonce += 1;
  state.captureRecoveryPending = false;
  if (state.peers.size) closePeerConnections();
  stopRelayCapture();
  if (state.fileAudioElement) {
    try { state.fileAudioElement.pause(); state.fileAudioElement.src = ''; } catch {}
    state.fileAudioElement = null;
  }
  if (state.fileAudioObjectUrl) {
    try { URL.revokeObjectURL(state.fileAudioObjectUrl); } catch {}
    state.fileAudioObjectUrl = null;
  }
  if (state.captureStream) state.captureStream.getTracks().forEach((track) => track.stop());
  state.captureStream = null;
  state.captureType = null;
  state.captureLabel = null;
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
  if (!audioTracks.length) { console.warn("[SangeetPitara] no live tracks for "+targetId); return; }
  await loadClientConfig();
  if (state.captureStream !== captureStream || !isSelfSource() || state.room?.sourceEpoch !== sourceEpoch || state.peers.has(targetId)) return;
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, role: 'publisher', sourceEpoch, captureStream, pendingCandidates: [], remoteDescSet: false };
  state.peers.set(targetId, entry);
  audioTracks.forEach((track) => pc.addTrack(track, captureStream));
  pc.onicecandidate = (event) => {
    if (event.candidate && isCurrentPeerEntry(targetId, entry)) send({ type: 'rtc', to: targetId, signal: { type: 'candidate', candidate: event.candidate }, sourceEpoch: entry.sourceEpoch });
  };
  pc.onicegatheringstatechange = () => {
    updatePeerTelemetryState(targetId, entry);
    renderTelemetry();
    console.log("[SangeetPitara][pub->"+targetId+"] gathering="+pc.iceGatheringState);
  };
  pc.oniceconnectionstatechange = () => {
    updatePeerTelemetryState(targetId, entry);
    renderTelemetry();
    console.log("[SangeetPitara][pub->"+targetId+"] iceConn="+pc.iceConnectionState);
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
    console.log("[SangeetPitara][pub->"+targetId+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
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
    if (offer?.sdp) offer.sdp = enhanceOpusSdpForMusic(offer.sdp);
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
    console.log("[SangeetPitara] sent offer to "+targetId+" epoch="+entry.sourceEpoch);
  } catch (error) {
    if (state.peers.get(targetId) === entry) removePeerConnection(targetId, entry);
    console.warn("[SangeetPitara] createOffer failed", error);
  }
}

async function handleRtcSignal(message) {
  const { from, signal } = message;
  if (!signal) return;
  const sourceEpoch = Number.isInteger(message.sourceEpoch) ? message.sourceEpoch : state.room?.sourceEpoch;
  if (Number.isInteger(message.sourceEpoch) && Number.isInteger(state.room?.sourceEpoch) && message.sourceEpoch !== state.room.sourceEpoch) {
    console.warn("[SangeetPitara] ignored RTC signal for stale source epoch", message.sourceEpoch);
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
      console.log("[SangeetPitara][lis<-"+from+"] gathering="+pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => {
      updatePeerTelemetryState(from, entry);
      renderTelemetry();
      console.log("[SangeetPitara][lis<-"+from+"] iceConn="+pc.iceConnectionState);
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
      console.log("[SangeetPitara][lis<-"+from+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
      if (pc.connectionState === 'failed') {
       toast('Audio connection failed. Direct peer connections need reachable networks; try the same Wi-Fi.', 'error');
        try { pc.restartIce(); } catch {}
        state.audioNeedsGesture = true;
        renderControls();
        setTimeout(() => {
          if (isCurrentPeerEntry(from, entry) && pc.connectionState === 'failed') console.warn("[SangeetPitara] listener still failed, waiting for publisher renegotiation");
        }, 2500);
      }
      // A transient `disconnected` state is not terminal. ICE may recover
      // without a new offer, so only discard a listener peer once it is closed.
      if (pc.connectionState === 'closed') removePeerConnection(from, entry);
      if (pc.connectionState === 'connected' && isCurrentPeerEntry(from, entry)) addActivity("Audio connected to "+from, true);
    };
    pc.ontrack = (event) => {
      if (!isCurrentPeerEntry(from, entry)) return;
      console.log("[SangeetPitara] ontrack from "+from+" kind="+(event.track?.kind||"audio")+" streams="+(event.streams?.length||0));
      const audio = ensureAudioElement();
      const inbound = event.streams?.[0] || new MediaStream([event.track]);
      audio.srcObject = inbound;
      audio.volume = state.muted ? 0 : state.volume;
      audio.muted = false;
      audio.play().then(() => {
        if (!isCurrentPeerEntry(from, entry)) return;
        state.audioNeedsGesture = false;
        renderControls();
        console.log("[SangeetPitara] remote audio playing from "+from);
      }).catch((err) => {
        if (!isCurrentPeerEntry(from, entry)) return;
        console.warn("[SangeetPitara] autoplay blocked", err);
        state.audioNeedsGesture = true;
        renderControls();
        toast('Tap “Enable room audio” to start playback.', 'error');
      });
    };
    registerPeerTelemetry(from, entry);
    try {
      const remoteOffer = signal.description?.sdp
        ? { type: signal.description.type, sdp: enhanceOpusSdpForMusic(signal.description.sdp) }
        : signal.description;
      await pc.setRemoteDescription(remoteOffer);
      if (!isCurrentPeerEntry(from, entry)) {
        removePeerConnection(from, entry);
        return;
      }
      entry.remoteDescSet = true;
      for (const c of entry.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch (e) { console.warn("[SangeetPitara] late candidate flush failed", e); } }
    } catch (e) {
      console.error("[SangeetPitara] setRemoteDescription(offer) failed", e);
      removePeerConnection(from, entry);
      return;
    }
    try {
      const answer = await pc.createAnswer();
      if (answer?.sdp) answer.sdp = enhanceOpusSdpForMusic(answer.sdp);
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
      console.log("[SangeetPitara] sent answer to "+from+" epoch="+entry.sourceEpoch);
    } catch (e) {
      if (state.peers.get(from) === entry) removePeerConnection(from, entry);
      console.error("[SangeetPitara] createAnswer failed", e);
    }
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
      console.log("[SangeetPitara] buffered early candidate from "+from+" before offer");
    }
    return;
  }
  if (!isCurrentPeerEntry(from, peer)) return;
  if (signal.type === 'answer') {
    try {
      const remoteAnswer = signal.description?.sdp
        ? { type: signal.description.type, sdp: enhanceOpusSdpForMusic(signal.description.sdp) }
        : signal.description;
      await peer.pc.setRemoteDescription(remoteAnswer);
      if (!isCurrentPeerEntry(from, peer)) {
        removePeerConnection(from, peer);
        return;
      }
      peer.remoteDescSet = true;
      console.log("[SangeetPitara][pub->"+from+"] remote answer set");
      for (const c of (peer.pendingCandidates||[]).splice(0)) { try { await peer.pc.addIceCandidate(c); } catch (e) { console.warn("[SangeetPitara] flush queued candidate failed", e); } }
    } catch (e) {
      if (state.peers.get(from) === peer) removePeerConnection(from, peer);
      console.error("[SangeetPitara] setRemoteDescription(answer) failed", e);
    }
  } else if (signal.type === 'candidate') {
    if (!peer.remoteDescSet) {
      peer.pendingCandidates = peer.pendingCandidates || [];
      peer.pendingCandidates.push(signal.candidate);
      console.log("[SangeetPitara] queued candidate from "+from+" until remoteDescSet");
    } else {
      try { await peer.pc.addIceCandidate(signal.candidate); } catch (e) { console.warn("[SangeetPitara] addIceCandidate failed", e); }
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
  const relayAudio = state.relayPlaybackAudio;
  const playbackContext = state.relayPlaybackContext;
  const tasks = [];
  if (audio) {
    audio.muted = false;
    applyOutputVolume();
    tasks.push(audio.play());
  }
  if (relayAudio) {
    const isAndroidBrowser = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    relayAudio.muted = !isAndroidBrowser;
    applyOutputVolume();
    tasks.push(relayAudio.play());
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

async function resumeRoomMediaAfterVisibility() {
  if (state.explicitLeave || !state.room) return;
  const tasks = [];
  for (const context of [state.audioContext, state.relayPlaybackContext]) {
    if (context?.state === 'suspended') tasks.push(context.resume());
  }
  if (state.audioElement?.srcObject && state.audioElement.paused) tasks.push(state.audioElement.play());
  if (state.relayPlaybackAudio?.srcObject && state.relayPlaybackAudio.paused) tasks.push(state.relayPlaybackAudio.play());
  if (state.captureStream && isMediaRelayEnabled()) tasks.push(ensureRelayPublisher());
  await Promise.allSettled(tasks);
}

function closeRoomMenu() {
  const menu = $('#room-actions-menu');
  const button = $('#settings-button');
  if (!menu || !button) return;
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

function toggleRoomMenu() {
  const menu = $('#room-actions-menu');
  const button = $('#settings-button');
  if (!menu || !button) return;
  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) menu.querySelector('[role="menuitem"]')?.focus();
}

function openShare() {
  const link = `${location.origin}/?room=${state.room.code}`;
  if (navigator.share) navigator.share({ title: `Join ${state.room.name}`, text: `Join my SangeetPitara room with code ${state.room.code}.`, url: link }).catch(() => {});
  else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => toast('Invite link copied.', 'success')).catch(() => toast(`Room code: ${state.room.code}`, 'success'));
  else toast(`Room code: ${state.room.code}`, 'success');
  closeRoomMenu();
}

function openRoomConfirmation(action) {
  const ending = action === 'end';
  closeRoomMenu();
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.setAttribute('role', 'presentation');
  modal.innerHTML = `<div class="source-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="room-confirm-title" aria-describedby="room-confirm-copy"><div class="modal-eyebrow">${ending ? 'END ROOM' : 'LEAVE ROOM'}</div><h2 id="room-confirm-title">${ending ? 'End this room?' : 'Leave this room?'}</h2><p id="room-confirm-copy">${ending ? 'Everyone will be disconnected and this invite will stop working. Ending a room cannot be undone.' : 'You will stop listening on this device. The room stays open for everyone else.'}</p><div class="confirmation-actions"><button class="confirm-cancel" data-confirm-cancel="true" type="button">${ending ? 'Keep room' : 'Stay in room'}</button><button class="confirm-action" data-confirm-action="true" type="button">${ending ? 'End room' : 'Leave room'}</button></div></div>`;
  $('#modal-root').append(modal);

  const dismiss = () => {
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') dismiss();
  };
  document.addEventListener('keydown', onKeyDown);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) dismiss();
  });
  modal.querySelector('[data-confirm-cancel]').addEventListener('click', dismiss);
  modal.querySelector('[data-confirm-action]').addEventListener('click', () => {
    if (ending) {
      state.pendingRoomEnd = true;
      send({ type: 'end-room' });
    } else {
      state.explicitLeave = true;
      state.lastRoomCode = null;
      if (state.ws?.readyState === WebSocket.OPEN) send({ type: 'leave-room' });
      resetToLanding();
    }
    dismiss();
  });
  modal.querySelector('[data-confirm-cancel]').focus();
}

function openRoomSettings() {
  closeRoomMenu();
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="source-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="room-settings-title"><div class="modal-eyebrow">ROOM SETTINGS</div><h2 id="room-settings-title">${escapeHtml(state.room.name)}</h2><p>Private room · up to 10 people · audio is not recorded. Share, leave, and end actions are in the Room menu.</p><div class="settings-summary"><div><span>Room code</span><strong>${escapeHtml(state.room.code)}</strong></div><div><span>Current source</span><strong>${escapeHtml(state.room.activeSourceId ? sourceLabel(state.room.activeSourceType) : 'None')}</strong></div></div>${notificationSettingsMarkup()}<button class="modal-close" type="button">Close</button></div>`;
  $('#modal-root').append(modal);
  const dismiss = () => {
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') dismiss();
  };
  document.addEventListener('keydown', onKeyDown);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) dismiss();
  });
  modal.querySelector('.modal-close').addEventListener('click', dismiss);
  modal.querySelector('[data-enable-notifications]')?.addEventListener('click', async () => {
    await requestNotificationPermission();
    dismiss();
    openRoomSettings();
  });
  modal.querySelector('.modal-close').focus();
}

function sendRequest() {
  if (isSelfSource()) {
    if (!state.captureStream) {
      // getDisplayMedia must be launched from a user gesture. A participant
      // becomes the authorized source when the host approves the request, so
      // this same button opens the native picker without another app modal.
      void startLocalCapture('DEVICE_AUDIO', 'participant');
      return;
    }
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
  $$('.entry-tab').forEach((tab) => tab.addEventListener('click', () => selectEntryTab(tab.dataset.entryTab)));

  $('#create-room').addEventListener('click', () => connectAnd({ type: 'create', roomName: $('#room-name').value.trim() }));
  $('#join-room').addEventListener('click', () => {
    const code = normalizeRoomCodeInput($('#room-code').value);
    $('#room-code').value = code;
    if (code.length !== 6) return showLanding('Enter the six-character room code your host shared with you.');
    connectAnd({ type: 'join', code });
  });
  $('#room-code').addEventListener('input', (event) => { event.target.value = normalizeRoomCodeInput(event.target.value); });
  $('#share-audio').addEventListener('click', () => { void startLocalCapture('DEVICE_AUDIO', 'host'); });
  $('#share-file-audio')?.addEventListener('click', () => { $('#audio-file-input')?.click(); });
  $('#share-file-audio-participant')?.addEventListener('click', () => { $('#audio-file-input')?.click(); });
  $('#audio-file-input')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void startLocalFileCapture(file);
  });
  $('#takeover-audio').addEventListener('click', () => {
    if (state.captureStream) {
      send({ type: 'takeover', sourceType: state.captureType || 'DEVICE_AUDIO' });
      setTimeout(() => send({ type: 'start-source', sourceType: state.captureType, sourceLabel: state.captureLabel }), 100);
    } else {
      void startLocalCapture('DEVICE_AUDIO', 'takeover');
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
  if ($('#sync-offset')) {
    $('#sync-offset').value = String(state.syncOffsetMs);
    if ($('#sync-offset-label')) $('#sync-offset-label').textContent = `${state.syncOffsetMs}ms`;
    $('#sync-offset').addEventListener('input', (event) => {
      state.syncOffsetMs = clampSyncOffsetMs(event.target.value);
      localStorage.setItem('roomsound-sync-offset-ms', String(state.syncOffsetMs));
      if ($('#sync-offset-label')) $('#sync-offset-label').textContent = `${state.syncOffsetMs}ms`;
      state.relayPlaybackWorklet?.port?.postMessage({ type: 'config', targetDelayMs: state.syncOffsetMs });
      renderTelemetry();
    });
  }
  $('#share-room').addEventListener('click', openShare);
  $('#settings-button').addEventListener('click', toggleRoomMenu);
  $('#room-settings').addEventListener('click', openRoomSettings);
  $('#leave-room').addEventListener('click', () => openRoomConfirmation('leave'));
  $('#end-room').addEventListener('click', () => openRoomConfirmation('end'));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.room-actions')) closeRoomMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeRoomMenu();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void resumeRoomMediaAfterVisibility();
  });
  document.addEventListener('resume', () => { void resumeRoomMediaAfterVisibility(); });
  window.addEventListener('pageshow', () => { void resumeRoomMediaAfterVisibility(); });
  $('#chat-feed').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-react-id]');
    if (!chip) return;
    send({ type: 'react', messageId: chip.dataset.reactId, emoji: chip.dataset.emoji });
  });
  const emojiBar = $('#emoji-bar');
  if (emojiBar) {
    emojiBar.innerHTML = CHAT_COMPOSER_EMOJI.map((emoji) => `<button type="button" class="emoji-pick" data-emoji="${escapeHtml(emoji)}" aria-label="Insert ${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`).join('');
    emojiBar.addEventListener('click', (event) => {
      const pick = event.target.closest('[data-emoji]');
      if (pick) insertComposerEmoji(pick.dataset.emoji);
    });
  }
  $('#emoji-toggle')?.addEventListener('click', () => {
    const bar = $('#emoji-bar');
    const open = bar.classList.toggle('open');
    $('#emoji-toggle').setAttribute('aria-expanded', String(open));
  });
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
    const target = state.members.find((member) => member.id === memberId);
    if (button.dataset.action === 'grant-source') {
      send({ type: 'grant-source', memberId, sourceType: 'DEVICE_AUDIO' });
      if (target) toast(`Granted audio control to ${target.name}.`, 'success');
    } else if (button.dataset.action === 'stop-member-source') {
      send({ type: 'stop-source' });
      if (target) toast(`Stopped ${target.name}'s audio.`, 'success');
    } else if (button.dataset.action === 'cohost') {
      send({ type: 'assign-cohost', memberId: target?.role === 'CO_HOST' ? null : memberId });
      if (target?.role === 'CO_HOST') toast('Co-host role removed.');
    } else if (button.dataset.action === 'remove') {
      send({ type: 'remove-member', memberId });
      if (target) toast(`Removed ${target.name} from the room.`);
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
  queueNotificationAction(initialNotificationAction);
} else {
  const queryRoom = locationParams.get('room');
  if (queryRoom) {
    selectEntryTab('join');
    $('#room-code').value = normalizeRoomCodeInput(queryRoom);
  }
}

/* Global cookie banner wiring — complements the provider-neutral ad-consent flow.
   Shows the bottom banner once until a choice is persisted as roomsound-ad-consent.
   Allow delegates to ads.mjs setAdConsent(true) which then enables AdSense if configured. */
function wireGlobalCookieBanner(){
  try {
    const banner = document.getElementById('cookie-banner');
    const allow = document.getElementById('cookie-allow');
    const deny  = document.getElementById('cookie-deny');
    const footerPrefs = document.getElementById('footer-cookie-prefs');
    if (!banner || banner.dataset.wired) return;
    banner.dataset.wired = 'true';
    const KEY = 'roomsound-ad-consent';
    const hasChoice = (()=>{ try{ const v=localStorage.getItem(KEY); return v==='granted'||v==='denied'; }catch{ return false; }})();
    // Show once if no choice yet (even before AdSense is enabled — teaches consent UX for reviewer)
    if (!hasChoice) banner.hidden = false;
    // Also respect the provider-gated ad-consent-banner visibility managed by ads.mjs/initializeAdSlots
    const persist = (granted)=>{
      try{ localStorage.setItem(KEY, granted?'granted':'denied'); }catch(e){}
      const meta = document.querySelector('meta[name="roomsound-ad-consent"]');
      if (meta) meta.content = granted?'granted':'denied';
      banner.hidden = true;
      try{ if (typeof setAdConsent === 'function') setAdConsent(granted); }catch(e){}
      // Re-run slot init so placeholders/ad script toggle promptly
      try{ if (typeof initializeAdSlots === 'function') initializeAdSlots(); }catch(e){}
    };
    allow?.addEventListener('click', ()=> persist(true));
    deny?.addEventListener('click',  ()=> persist(false));
    footerPrefs?.addEventListener('click', (e)=>{
      e.preventDefault();
      banner.hidden = false;
      banner.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  } catch {}
}
try{ wireGlobalCookieBanner(); }catch(e){}
