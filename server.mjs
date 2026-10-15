import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const root = fileURLToPath(new URL('.', import.meta.url));
const rootPath = resolve(root);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const rooms = new Map();
const requestTtlMs = 45_000;

const requestJitterMs = 5_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_KEEP = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const TURN_URLS = process.env.TURN_URLS ? process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean) : [];
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), display-capture=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const rateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) if (now > entry.resetAt) rateLimit.delete(ip);
}, 60_000).unref();

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimit.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const randomId = () => crypto.randomUUID();
const randomCode = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

function lanAddresses() {
  if (process.env.NODE_ENV === 'production' && process.env.SHOW_LAN !== '1') return [];
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function safeText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function findMember(room, memberId) {
  return room.members.get(memberId);
}

function isModerator(room, member) {
  return Boolean(member && (member.id === room.hostId || member.id === room.cohostId));
}

function publicMember(member, room) {
  return {
    id: member.id,
    guestId: member.guestId,
    name: member.name,
    role: member.role,
    online: Boolean(member.ws),
    isSource: room.activeSourceId === member.id,
    joinedAt: member.joinedAt,
  };
}

function clientState(room, viewer) {
  const requests = [...room.requests.values()]
    .filter((request) => request.status === 'PENDING')
    .filter((request) => isModerator(room, viewer) || request.requesterId === viewer?.id)
    .map((request) => ({ ...request }));

  return {
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      hostId: room.hostId,
      cohostId: room.cohostId,
      activeSourceId: room.activeSourceId,
      activeSourceType: room.activeSourceType,
      sourceStatus: room.sourceStatus,
      sourceEpoch: room.sourceEpoch,
      resumeSourceId: room.resumeSourceId,
      createdAt: room.createdAt,
    },
    self: viewer ? publicMember(viewer, room) : null,
    members: [...room.members.values()].map((member) => publicMember(member, room)),
    requests,
    messages: room.messages.slice(-80),
  };
}

function broadcastState(room) {
  for (const member of room.members.values()) {
    if (member.ws) send(member.ws, { type: 'state', state: clientState(room, member) });
  }
}

function broadcast(room, payload) {
  for (const member of room.members.values()) send(member.ws, payload);
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function findRoomByCode(code) {
  return [...rooms.values()].find((room) => room.code === String(code).toUpperCase());
}

function makeMember({ guestId, name, ws, role = 'PARTICIPANT' }) {
  return {
    id: randomId(),
    guestId: safeText(guestId, 80) || randomId(),
    name: safeText(name, 40) || 'Guest',
    role,
    ws,
    joinedAt: Date.now(),
  };
}

function attachRoom(ws, room, member) {
  if (room.hostFailoverTimer && member.id === room.hostId) {
    clearTimeout(room.hostFailoverTimer);
    room.hostFailoverTimer = null;
  }
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  ws.roomId = room.id;
  ws.memberId = member.id;
  room.members.set(member.id, member);
  send(ws, { type: 'joined', state: clientState(room, member) });
  broadcastState(room);
}

function createRoom(ws, message) {
  let code = randomCode();
  while (findRoomByCode(code)) code = randomCode();

  const room = {
    id: randomId(),
    code,
    name: safeText(message.name, 60) || 'Listening room',
    status: 'ACTIVE',
    hostId: null,
    cohostId: null,
    activeSourceId: null,
    activeSourceType: null,
    sourceStatus: 'NONE',
    sourceEpoch: 0,
    resumeSourceId: null,
    resumeSourceType: null,
    members: new Map(),
    requests: new Map(),
    messages: [],
    createdAt: Date.now(),
    cleanupTimer: null,
    hostFailoverTimer: null,
  };

  const member = makeMember({ guestId: message.guestId, name: message.displayName, ws, role: 'HOST' });
  room.hostId = member.id;
  rooms.set(room.id, room);
  attachRoom(ws, room, member);
}

function joinRoom(ws, message) {
  const room = findRoomByCode(message.code);
  if (!room || room.status !== 'ACTIVE') return sendError(ws, 'That room is unavailable or has ended.');

  const guestIdClean = safeText(message.guestId, 80);
  const existing = [...room.members.values()].find((member) => member.guestId === guestIdClean);
  if (existing && !existing.ws) {
    existing.ws = ws;
    existing.name = safeText(message.displayName, 40) || existing.name;
    attachRoom(ws, room, existing);
    return;
  }

  const onlineCount = [...room.members.values()].filter((member) => member.ws).length;
  const totalCount = room.members.size;
  if (onlineCount >= 10 || totalCount >= 14) {
    return sendError(ws, 'This room is full. The limit is 10 people.');
  }

  const member = makeMember({ guestId: message.guestId, name: message.displayName, ws });
  attachRoom(ws, room, member);
}

function trimMessages(room) {
  if (room.messages.length > MAX_MESSAGES) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGE_KEEP);
  }
}

function addSystemMessage(room, text) {
  const message = { id: randomId(), kind: 'system', text: safeText(text, 280), createdAt: Date.now() };
  room.messages.push(message);
  trimMessages(room);
  broadcast(room, { type: 'chat', message });
}

function setSource(room, member, sourceType, status = 'STARTING') {
  room.activeSourceId = member.id;
  room.activeSourceType = safeText(sourceType, 60) || 'MICROPHONE';
  room.sourceStatus = status;
  room.sourceEpoch += 1;
}

function stopSource(room, reason, resume = true, notify = true) {
  const previousId = room.activeSourceId;
  const previousMember = previousId ? findMember(room, previousId) : null;
  const shouldResume = resume && previousMember?.role === 'PARTICIPANT' && room.resumeSourceId;

  if (shouldResume) {
    const resumeMember = findMember(room, room.resumeSourceId);
    room.activeSourceId = resumeMember?.ws ? room.resumeSourceId : null;
    room.activeSourceType = room.activeSourceId ? room.resumeSourceType : null;
    // The host keeps its local capture alive while a participant temporarily
    // owns the room, so a return-to-host transition is immediately live.
    room.sourceStatus = room.activeSourceId ? 'LIVE' : 'NONE';
    room.sourceEpoch += 1;
    room.resumeSourceId = null;
    room.resumeSourceType = null;
  } else {
    room.activeSourceId = null;
    room.activeSourceType = null;
    room.sourceStatus = 'NONE';
    room.sourceEpoch += 1;
    room.resumeSourceId = null;
    room.resumeSourceType = null;
  }

  addSystemMessage(room, reason || 'The active audio source stopped.');
  if (notify) broadcastState(room);
}

function scheduleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const online = [...room.members.values()].some((member) => member.ws);
    if (!online && room.status === 'ACTIVE') {
      room.status = 'ENDED';
      if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
      rooms.delete(room.id);
    }
  }, 5 * 60 * 1000);
}

function promoteCohost(room) {
  const cohost = room.cohostId ? findMember(room, room.cohostId) : null;
  if (!cohost || !cohost.ws) return false;
  const previousHost = findMember(room, room.hostId);
  if (previousHost) previousHost.role = 'PARTICIPANT';
  room.hostId = cohost.id;
  room.cohostId = null;
  cohost.role = 'HOST';
  addSystemMessage(room, `${cohost.name} is now the host.`);
  broadcast(room, { type: 'host-promoted', memberId: cohost.id });
  broadcastState(room);
  return true;
}

function handleDisconnect(ws) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  if (!room) return;
  const member = findMember(room, ws.memberId);
  if (!member || member.ws !== ws) return;
  member.ws = null;

  if (room.activeSourceId === member.id) {
    stopSource(room, 'The active audio source has disconnected.', true);
    broadcast(room, { type: 'source-disconnected', memberId: member.id });
  }

  if (member.id === room.hostId) {
    broadcast(room, { type: 'host-disconnected', memberId: member.id });
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    room.hostFailoverTimer = setTimeout(() => {
      if (room.hostId === member.id && !findMember(room, member.id)?.ws) {
        if (!promoteCohost(room)) {
          addSystemMessage(room, 'The host is unavailable. This room will close when everyone leaves.');
          broadcastState(room);
        }
      }
    }, 30_000);
  }

  if (![...room.members.values()].some((item) => item.ws)) scheduleCleanup(room);
  broadcastState(room);
}

function currentMember(ws) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  const member = room ? findMember(room, ws.memberId) : null;
  return { room, member };
}

function isValidType(value) {
  return typeof value === 'string' && /^[a-z-]+$/.test(value);
}

function handleMessage(ws, message) {
  const type = message?.type;
  if (typeof type !== 'string' || !isValidType(type)) return sendError(ws, 'Invalid message type.');
  if (type === 'create-room') return createRoom(ws, message);
  if (type === 'join-room') return joinRoom(ws, message);

  const { room, member } = currentMember(ws);
  if (!room || !member) return sendError(ws, 'Join or create a room first.');

  if (type === 'chat') {
    const text = safeText(message.text, 280);
    if (!text) return;
    const chat = { id: randomId(), kind: 'chat', senderId: member.id, senderName: member.name, text, createdAt: Date.now() };
    room.messages.push(chat);
    trimMessages(room);
    broadcast(room, { type: 'chat', message: chat });
    return;
  }

  if (type === 'rtc') {
    if (!message.to || typeof message.to !== 'string') return;
    if (!message.signal || typeof message.signal !== 'object') return;
    const target = findMember(room, message.to);
    if (target?.ws) {
      const forwarded = { type: 'rtc', from: member.id, signal: message.signal };
      // Native peers tag signaling with the source epoch so receivers can
      // discard an offer/candidate that belongs to a previous handoff. Keep
      // the tag on the server hop; older web clients simply ignore it.
      if (Number.isInteger(message.sourceEpoch) && message.sourceEpoch >= 0) {
        forwarded.sourceEpoch = message.sourceEpoch;
      }
      send(target.ws, forwarded);
    }
    return;
  }

  if (type === 'request-control') {
    if (room.activeSourceId === member.id) return sendError(ws, 'You are already the active source.');
    if (room.activeSourceId && room.activeSourceId !== room.hostId && room.activeSourceId !== room.cohostId) {
      return sendError(ws, 'Control requests are paused while another participant is sharing.');
    }
    const hasPending = [...room.requests.values()].some((request) => request.requesterId === member.id && request.status === 'PENDING');
    if (hasPending) return sendError(ws, 'You already have a pending request.');
    const ttl = requestTtlMs + Math.floor(Math.random() * requestJitterMs);
    const request = {
      id: randomId(),
      requesterId: member.id,
      requesterName: member.name,
      sourceType: safeText(message.sourceType, 60) || 'DEVICE_AUDIO',
      note: safeText(message.note, 160),
      status: 'PENDING',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    room.requests.set(request.id, request);
    broadcast(room, { type: 'control-requested', request });
    broadcastState(room);
    setTimeout(() => {
      if (request.status !== 'PENDING' || room.status !== 'ACTIVE') return;
      request.status = 'EXPIRED';
      const requester = findMember(room, request.requesterId);
      if (requester?.ws) send(requester.ws, { type: 'request-result', status: 'EXPIRED', request });
      broadcast(room, { type: 'control-request-expired', requestId: request.id });
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 10_000);
    }, ttl);
    return;
  }

  if (type === 'cancel-request') {
    const request = room.requests.get(message.requestId);
    if (request?.requesterId === member.id && request.status === 'PENDING') {
      request.status = 'CANCELED';
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 5_000);
    }
    return;
  }

  if (type === 'approve-request' || type === 'reject-request') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can manage requests.');
    const request = room.requests.get(message.requestId);
    if (!request || request.status !== 'PENDING') return sendError(ws, 'That request is no longer available.');
    const requester = findMember(room, request.requesterId);
    if (type === 'reject-request') {
      request.status = 'REJECTED';
      if (requester?.ws) send(requester.ws, { type: 'request-result', status: 'REJECTED', request });
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 10_000);
      return;
    }
    if (!requester || !requester.ws) {
      request.status = 'CANCELED';
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 5_000);
      return sendError(ws, 'That participant is no longer connected.');
    }
    request.status = 'APPROVED';
    room.resumeSourceId = room.activeSourceId;
    room.resumeSourceType = room.activeSourceType;
    setSource(room, requester, request.sourceType, 'STARTING');
    if (requester.ws) send(requester.ws, { type: 'request-result', status: 'APPROVED', request });
    addSystemMessage(room, `${requester.name} was approved to share audio.`);
    broadcastState(room);
    setTimeout(() => room.requests.delete(request.id), 30_000);
    return;
  }

  if (type === 'start-source') {
    const authorized = member.id === room.activeSourceId || (isModerator(room, member) && (!room.activeSourceId || room.activeSourceId === member.id));
    if (!authorized) return sendError(ws, 'You are not authorized to publish audio right now.');
    setSource(room, member, message.sourceType, 'LIVE');
    addSystemMessage(room, `${member.name} is sharing ${safeText(message.sourceLabel, 80) || 'audio'}.`);
    broadcastState(room);
    return;
  }

  if (type === 'stop-source') {
    if (member.id !== room.activeSourceId && !isModerator(room, member)) return sendError(ws, 'You cannot stop the active source.');
    stopSource(room, `${member.name} stopped sharing audio.`, true);
    return;
  }

  if (type === 'takeover') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can take control.');
    room.resumeSourceId = null;
    room.resumeSourceType = null;
    setSource(room, member, message.sourceType || 'DEVICE_AUDIO', 'STARTING');
    addSystemMessage(room, `${member.name} took control of the room.`);
    broadcast(room, { type: 'takeover', memberId: member.id });
    broadcastState(room);
    return;
  }

  if (type === 'assign-cohost') {
    if (member.id !== room.hostId) return sendError(ws, 'Only the host can assign a co-host.');
    if (!message.memberId) {
      const previous = room.cohostId ? findMember(room, room.cohostId) : null;
      if (previous) previous.role = 'PARTICIPANT';
      room.cohostId = null;
      addSystemMessage(room, 'The co-host role was removed.');
      broadcastState(room);
      return;
    }
    const target = findMember(room, message.memberId);
    if (!target || target.id === room.hostId) return sendError(ws, 'That participant cannot be made co-host.');
    if (!target.ws) return sendError(ws, 'That participant is not currently connected.');
    if (room.cohostId && room.cohostId !== target.id) {
      const previous = findMember(room, room.cohostId);
      if (previous) previous.role = 'PARTICIPANT';
    }
    room.cohostId = target.id;
    target.role = 'CO_HOST';
    addSystemMessage(room, `${target.name} is now co-host.`);
    broadcastState(room);
    return;
  }

  if (type === 'remove-member') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can remove participants.');
    const target = findMember(room, message.memberId);
    if (!target || target.id === room.hostId) return sendError(ws, 'That participant cannot be removed.');
    if (room.activeSourceId === target.id) stopSource(room, 'The active source was removed.', true, false);
    if (target.ws) {
      send(target.ws, { type: 'removed', message: 'You were removed from the room.' });
      target.ws.close(4003, 'Removed from room');
    }
    room.members.delete(target.id);
    if (room.cohostId === target.id) room.cohostId = null;
    for (const [id, req] of room.requests) if (req.requesterId === target.id) room.requests.delete(id);
    broadcastState(room);
    return;
  }

  if (type === 'end-room') {
    if (member.id !== room.hostId) return sendError(ws, 'Only the host can end the room.');
    room.status = 'ENDED';
    broadcast(room, { type: 'room-ended', message: 'The host ended the room.' });
    for (const participant of room.members.values()) participant.ws?.close(1000, 'Room ended');
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    rooms.delete(room.id);
    return;
  }

  if (type === 'leave-room') {
    if (member.id === room.hostId) {
      if (room.activeSourceId === member.id) stopSource(room, 'The host stopped sharing audio.', false);
      if (!promoteCohost(room)) {
        addSystemMessage(room, 'The host left the room. A co-host was not available to take over.');
        broadcastState(room);
      }
    }
    ws.close(1000, 'Left room');
  }
}

function buildTurnConfig() {
  if (!TURN_URLS.length) return null;
  return {
    urls: TURN_URLS,
    username: TURN_USERNAME || undefined,
    credential: TURN_CREDENTIAL || undefined,
  };
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = url.pathname;

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    res.end('Too Many Requests');
    return;
  }

  if (requestPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'roomsound', websocket: true, port, rooms: rooms.size }));
    return;
  }
  if (requestPath === '/config') {
    const turn = buildTurnConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...(turn ? [turn] : [])],
      maxMembers: 10,
      requestTtlMs,
    }));
    return;
  }
  const fileName = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  const filePath = resolve(rootPath, fileName);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': mime };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'";
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  verifyClient: (info, cb) => {
    const allowed = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (allowed && allowed.length) {
      const origin = info.origin || info.req.headers.origin || '';
      if (origin && !allowed.some((a) => origin === a || origin.endsWith(a))) {
        cb(false, 403, 'Origin not allowed');
        return;
      }
    }
    const ip = getClientIp(info.req);
    if (!checkRateLimit(ip)) {
      cb(false, 429, 'Too Many Requests');
      return;
    }
    cb(true);
  },
});
wss.on('connection', (ws, req) => {
  ws._ip = getClientIp(req);
  ws.on('message', (raw) => {
    if (raw.length > MAX_PAYLOAD_BYTES) return sendError(ws, 'Message too large.');
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      return sendError(ws, `Invalid message: ${error.message}`);
    }
    ws._msgCount = (ws._msgCount || 0) + 1;
    if (!ws._msgReset) {
      ws._msgReset = Date.now() + 5000;
      ws._msgCount = 1;
    } else if (Date.now() > ws._msgReset) {
      ws._msgReset = Date.now() + 5000;
      ws._msgCount = 1;
    }
    if (ws._msgCount > 30) return sendError(ws, 'You are sending messages too quickly.');
    handleMessage(ws, data);
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, closing ${rooms.size} rooms...`);
  for (const room of rooms.values()) {
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  }
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(`RoomSound is running at http://localhost:${port}`);
  for (const address of lanAddresses()) console.log(`RoomSound LAN address: http://${address}:${port}`);
  console.log(`RoomSound health check: http://localhost:${port}/health`);
  if (TURN_URLS.length) console.log(`TURN configured: ${TURN_URLS.join(', ')}`);
  else console.log('TURN not configured — set TURN_URLS="turn:turn.example.com:3478" for NAT traversal.');
});
