import { createGuestId } from './guest-id.js';
import { liveAudioTracks, prepareDisplayAudioStream } from './capture-tracks.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const guestStorageKey = 'roomsound-guest-id';
const guestId = localStorage.getItem(guestStorageKey) || createGuestId();
localStorage.setItem(guestStorageKey, guestId);

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
};

let rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
let iceConfigLoaded = false;

async function loadIceConfig() {
  if (iceConfigLoaded) return;
  try {
    const r = await fetch('/config');
    if (!r.ok) throw new Error('config fetch failed');
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) rtcConfig = { iceServers: j.iceServers };
    iceConfigLoaded = true;
  } catch {
    // keep default STUN
  }
}
loadIceConfig();

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

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
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
    if (isModerator()) toast(`${message.request.requesterName} requested audio control.`, 'success');
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
    handleRtcSignal(message);
  }
}

function applyRoomState(next) {
  const previousSource = state.room?.activeSourceId;
  const previousSelfId = state.self?.id;
  const prevMembers = state.members.slice();
  const wasSelfSource = Boolean(previousSource && previousSource === previousSelfId);
  state.room = next.room;
  state.self = next.self;
  state.members = next.members || [];
  state.requests = next.requests || [];
  addMessages(next.messages || []);

  if (previousSource && previousSource !== state.room.activeSourceId) closePeerConnections();
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
        try { entry.pc.close(); } catch {}
        state.peers.delete(pm.id);
      }
    }
    // If active source went offline, drop it too
    if (previousSource && !onlineNow.has(previousSource) && state.peers.has(previousSource)) {
      const entry = state.peers.get(previousSource);
      try { entry.pc.close(); } catch {}
      state.peers.delete(previousSource);
    }
  }
  renderAll();
  if (state.room.activeSourceId === state.self?.id && state.captureStream) {
    ensurePublisherConnections();
  }
  if (state.room.activeSourceId !== state.self?.id && state.audioElement?.srcObject && state.room.sourceStatus === 'NONE') {
    state.audioElement.srcObject = null;
  }
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
      const context = new AudioContext();
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
        state.captureStream = null;
        send({ type: 'stop-source' });
        toast('The audio capture session ended.', 'error');
      }
    }));
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

function closePeerConnections() {
  for (const entry of state.peers.values()) {
    try { entry.pc?.close(); } catch {}
  }
  state.peers.clear();
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
  audio.volume = state.muted ? 0 : state.volume;
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
  return audio;
}

function ensurePublisherConnections() {
  if (!state.captureStream || !isSelfSource()) return;
  for (const member of state.members) {
    if (member.id !== state.self.id && member.online && !state.peers.has(member.id)) createPublisherPeer(member.id);
  }
}

async function createPublisherPeer(targetId) {
  if (!state.captureStream || state.peers.has(targetId)) return;
  const audioTracks = liveAudioTracks(state.captureStream);
  if (!audioTracks.length) { console.warn("[RoomSound] no live tracks for "+targetId); return; }
  await loadIceConfig();
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, role: 'publisher', pendingCandidates: [], remoteDescSet: false };
  state.peers.set(targetId, entry);
  // Display capture uses a live video track to keep Chrome's audio session
  // alive, but the room protocol is audio-only. Never send an ended/disabled
  // display video track to native listeners.
  audioTracks.forEach((track) => pc.addTrack(track, state.captureStream));
  pc.onicecandidate = (event) => { if (event.candidate) send({ type: 'rtc', to: targetId, signal: { type: 'candidate', candidate: event.candidate }, sourceEpoch: state.room?.sourceEpoch }); };
  pc.onicegatheringstatechange = () => console.log("[RoomSound][pub->"+targetId+"] gathering="+pc.iceGatheringState);
  pc.oniceconnectionstatechange = () => {
    console.log("[RoomSound][pub->"+targetId+"] iceConn="+pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch {}
      const msg = hasTurnServer(rtcConfig) ? 'Audio relay failed — retrying ICE…' : 'No relay candidate — add TURN for internet/cross-NAT audio.';
      toast(msg, 'error');
      setTimeout(() => {
        const cur = state.peers.get(targetId);
        if (isSelfSource() && cur && cur.pc.iceConnectionState === 'failed') {
          try{cur.pc.close();}catch{} state.peers.delete(targetId);
          if (state.captureStream) createPublisherPeer(targetId).catch(()=>{});
        }
      }, 1500);
    }
  };
  pc.onconnectionstatechange = () => {
    console.log("[RoomSound][pub->"+targetId+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
    if (pc.connectionState === 'failed') {
      toast('Audio connection failed — trying to reconnect…', 'error');
      try { pc.restartIce(); } catch {}
      setTimeout(() => {
        const cur = state.peers.get(targetId);
        if (isSelfSource() && cur && cur.pc.connectionState === 'failed') {
          try{cur.pc.close();}catch{} state.peers.delete(targetId);
          if (state.captureStream) createPublisherPeer(targetId).catch(()=>{});
        }
      }, 1000);
    }
    if (['closed', 'disconnected'].includes(pc.connectionState)) { try{pc.close();}catch{} state.peers.delete(targetId); }
    if (pc.connectionState === 'connected') addActivity("Audio peer connected to "+targetId, true);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'rtc', to: targetId, signal: { type: 'offer', description: pc.localDescription }, sourceEpoch: state.room?.sourceEpoch });
  console.log("[RoomSound] sent offer to "+targetId+" epoch="+state.room?.sourceEpoch);
}

async function handleRtcSignal(message) {
  const { from, signal } = message;
  if (!signal) return;
  if (signal.type === 'offer') {
    if (isSelfSource()) return;
    await loadIceConfig();
    const existing = state.peers.get(from);
    try { existing?.pc.close(); } catch {}
    if (existing) state.peers.delete(from);
    const pc = new RTCPeerConnection(rtcConfig);
    const entry = { pc, role: 'listener', pendingCandidates: [], remoteDescSet: false, localDescSet: false };
    state.peers.set(from, entry);
    pc.onicecandidate = (event) => { if (event.candidate) send({ type: 'rtc', to: from, signal: { type: 'candidate', candidate: event.candidate }, sourceEpoch: state.room?.sourceEpoch }); };
    pc.onicegatheringstatechange = () => console.log("[RoomSound][lis<-"+from+"] gathering="+pc.iceGatheringState);
    pc.oniceconnectionstatechange = () => {
      console.log("[RoomSound][lis<-"+from+"] iceConn="+pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
        setTimeout(() => {
          if (pc.iceConnectionState === 'failed') {
            toast(hasTurnServer(rtcConfig) ? 'Audio relay failed — retrying ICE…' : 'No relay candidate — add TURN for internet/cross-NAT audio.', 'error');
          }
        }, 2000);
      }
    };
    pc.onconnectionstatechange = () => {
      console.log("[RoomSound][lis<-"+from+"] conn="+pc.connectionState+" ice="+pc.iceConnectionState);
      if (pc.connectionState === 'failed') {
        toast('Audio connection failed. Check network or TURN config.', 'error');
        try { pc.restartIce(); } catch {}
        state.audioNeedsGesture = true;
        renderControls();
        setTimeout(() => {
          if (pc.connectionState === 'failed') console.warn("[RoomSound] listener still failed, waiting for publisher renegotiation");
        }, 2500);
      }
      if (pc.connectionState === 'connected') addActivity("Audio connected to "+from, true);
    };
    pc.ontrack = (event) => {
      console.log("[RoomSound] ontrack from "+from+" kind="+(event.track?.kind||"audio")+" streams="+(event.streams?.length||0));
      const audio = ensureAudioElement();
      const inbound = event.streams?.[0] || new MediaStream([event.track]);
      audio.srcObject = inbound;
      audio.volume = state.muted ? 0 : state.volume;
      audio.muted = false;
      audio.play().then(() => {
        state.audioNeedsGesture = false;
        renderControls();
        console.log("[RoomSound] remote audio playing from "+from);
      }).catch((err) => {
        console.warn("[RoomSound] autoplay blocked", err);
        state.audioNeedsGesture = true;
        renderControls();
        toast('Tap “Enable room audio” to start playback.', 'error');
      });
    };
    try {
      await pc.setRemoteDescription(signal.description);
      entry.remoteDescSet = true;
      for (const c of entry.pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch (e) { console.warn("[RoomSound] late candidate flush failed", e); } }
    } catch (e) {
      console.error("[RoomSound] setRemoteDescription(offer) failed", e);
      try { pc.close(); } catch {}
      state.peers.delete(from);
      return;
    }
    try {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      entry.localDescSet = true;
      send({ type: 'rtc', to: from, signal: { type: 'answer', description: pc.localDescription }, sourceEpoch: state.room?.sourceEpoch });
      console.log("[RoomSound] sent answer to "+from+" epoch="+state.room?.sourceEpoch);
    } catch (e) { console.error("[RoomSound] createAnswer failed", e); }
    // flush early trickled candidates that arrived before offer was processed
    const pkEarly = "__pending_"+from;
    if (state.peers.has(pkEarly)) {
      const pend = state.peers.get(pkEarly);
      state.peers.delete(pkEarly);
      for (const c of (pend.pendingCandidates||[])) { try { await pc.addIceCandidate(c); } catch {} }
    }
    return;
  }
  const peer = state.peers.get(from);
  if (!peer) {
    if (signal.type === 'candidate' && signal.candidate && !isSelfSource() && state.room?.activeSourceId === from) {
      let pend = state.peers.get("__pending_"+from);
      if (!pend) { pend = { pendingCandidates: [] }; state.peers.set("__pending_"+from, pend); }
      pend.pendingCandidates.push(signal.candidate);
      console.log("[RoomSound] buffered early candidate from "+from+" before offer");
    }
    return;
  }
  if (signal.type === 'answer') {
    try {
      await peer.pc.setRemoteDescription(signal.description);
      peer.remoteDescSet = true;
      console.log("[RoomSound][pub->"+from+"] remote answer set");
      for (const c of (peer.pendingCandidates||[]).splice(0)) { try { await peer.pc.addIceCandidate(c); } catch (e) { console.warn("[RoomSound] flush queued candidate failed", e); } }
    } catch (e) { console.error("[RoomSound] setRemoteDescription(answer) failed", e); }
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
  if (state.peers.has(pk) && peer?.remoteDescSet) {
    const pend = state.peers.get(pk);
    state.peers.delete(pk);
    for (const c of (pend.pendingCandidates||[])) { try { await peer.pc.addIceCandidate(c); } catch {} }
  }
}

function enableRoomAudio() {
  const audio = ensureAudioElement();
  audio.muted = false;
  audio.volume = state.muted ? 0 : state.volume;
  audio.play().then(() => {
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
  modal.innerHTML = `<div class="source-modal settings-modal"><div class="modal-eyebrow">ROOM SETTINGS</div><h2>${escapeHtml(state.room.name)}</h2><p>Private room · up to 10 people · audio is not recorded.</p><div class="settings-summary"><div><span>Room code</span><strong>${escapeHtml(state.room.code)}</strong></div><div><span>Current source</span><strong>${escapeHtml(state.room.activeSourceId ? sourceLabel(state.room.activeSourceType) : 'None')}</strong></div></div>${hostControls}<button class="modal-close" type="button">Close</button></div>`;
  $('#modal-root').append(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
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
    if (state.audioElement) state.audioElement.volume = state.muted ? 0 : state.volume;
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
    if (state.audioElement) state.audioElement.volume = state.muted ? 0 : state.volume;
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
}

wireEvents();
const queryRoom = new URLSearchParams(location.search).get('room');
if (queryRoom) {
  $$('.entry-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.entryTab === 'join'));
  $$('.entry-panel').forEach((panel) => panel.classList.toggle('active-panel', panel.id === 'join-panel'));
  $('#room-code').value = queryRoom.toUpperCase();
}
