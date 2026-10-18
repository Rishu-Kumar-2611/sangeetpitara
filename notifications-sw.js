const actionMessageType = 'roomsound-notification-action';
const readyMessageType = 'roomsound-notification-ready';
const pendingActions = [];
const readyClients = new Map();

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase();
}

function roomCodeFromUrl(value) {
  try {
    return normalizeRoomCode(new URL(value).searchParams.get('room'));
  } catch {
    return '';
  }
}

function normalizeAction(data) {
  const action = data?.action === 'approve' || data?.action === 'reject' ? data.action : '';
  const requestId = String(data?.requestId || '').trim();
  const roomCode = normalizeRoomCode(data?.roomCode) || roomCodeFromUrl(data?.roomUrl);
  if (!action || !requestId || !roomCode) return null;
  return {
    type: actionMessageType,
    action,
    requestId,
    roomCode,
    roomUrl: data?.roomUrl || '',
  };
}

function actionKey(action) {
  return `${action.roomCode}:${action.action}:${action.requestId}`;
}

function addPendingAction(action) {
  if (!pendingActions.some((item) => actionKey(item) === actionKey(action))) pendingActions.push(action);
}

function clientRoomCode(client) {
  return readyClients.get(client.id)?.roomCode || roomCodeFromUrl(client.url);
}

function matchingClients(clients, roomCode) {
  const exact = clients.filter((client) => clientRoomCode(client) === roomCode);
  if (exact.length) return exact;
  // A page that is still on the landing route has no room query yet. The page
  // sends its room code in the ready handshake after it joins.
  return clients.filter((client) => !clientRoomCode(client));
}

function chooseClient(clients) {
  return clients.find((client) => client.visibilityState === 'visible') || clients[0] || null;
}

async function focusClient(client) {
  if (!client) return;
  try { await client.focus(); } catch {}
}

function postAction(client, action) {
  if (!client) return false;
  try {
    client.postMessage(action);
    return true;
  } catch {
    return false;
  }
}

async function deliverPendingAction(client, roomCode) {
  let delivered = false;
  for (let index = pendingActions.length - 1; index >= 0; index -= 1) {
    if (pendingActions[index].roomCode !== roomCode) continue;
    const [action] = pendingActions.splice(index, 1);
    if (!postAction(client, action)) {
      addPendingAction(action);
      continue;
    }
    delivered = true;
  }
  if (delivered) await focusClient(client);
  return delivered;
}

function actionUrl(action) {
  const target = new URL(action.roomUrl || '/', self.location.origin);
  target.searchParams.set('room', action.roomCode);
  target.searchParams.set('notificationAction', action.action);
  target.searchParams.set('requestId', action.requestId);
  return target.href;
}

async function handleNotificationAction(data, actionName) {
  const action = normalizeAction({ ...data, action: actionName });
  if (!action) return;

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const candidates = matchingClients(windows, action.roomCode);
  const ready = candidates.filter((client) => readyClients.get(client.id)?.roomCode === action.roomCode);
  const target = chooseClient(ready.length ? ready : candidates);

  if (target && readyClients.get(target.id)?.roomCode === action.roomCode) {
    if (!postAction(target, action)) addPendingAction(action);
    await focusClient(target);
    return;
  }

  addPendingAction(action);
  if (target) {
    await focusClient(target);
    return;
  }

  try {
    await self.clients.openWindow(actionUrl(action));
  } catch {
    // The action remains queued until a RoomSound page sends its ready handshake.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== readyMessageType || !event.source?.id) return;
  const roomCode = normalizeRoomCode(event.data.roomCode);
  readyClients.set(event.source.id, { roomCode });
  event.waitUntil(deliverPendingAction(event.source, roomCode));
});

self.addEventListener('notificationclick', (event) => {
  const actionName = event.action;
  event.notification.close();
  if (!actionName) return;
  event.waitUntil(handleNotificationAction(event.notification.data, actionName));
});

self.addEventListener('messageerror', (event) => {
  // Keep the worker resilient if an older page sends an unsupported message.
  console.warn('[RoomSound] notification worker message error', event.data);
});
