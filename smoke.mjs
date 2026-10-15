import WebSocket from 'ws';

function client() {
  const socket = new WebSocket('ws://localhost:4173');
  const events = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  return {
    socket,
    open: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', reject);
    }),
    wait: (predicate) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('WebSocket message timeout'));
        }, 5000);
        waiters.push(waiter);
      });
    },
  };
}

const host = client();
await host.open();
host.socket.send(JSON.stringify({ type: 'create-room', name: 'Smoke Room', displayName: 'Alex', guestId: 'smoke-host' }));
const created = await host.wait((message) => message.type === 'joined');
console.log('created', created.state.room.code);

const hostSawGuest = host.wait((message) => message.type === 'state' && message.state.members.length === 2);
const guest = client();
await guest.open();
guest.socket.send(JSON.stringify({ type: 'join-room', code: created.state.room.code, displayName: 'Sam', guestId: 'smoke-guest' }));
await guest.wait((message) => message.type === 'joined');
console.log('guest joined');
await hostSawGuest;
console.log('host saw guest');

const hostSawRejectedRequest = host.wait((message) => message.type === 'state' && message.state.requests.length === 1);
guest.socket.send(JSON.stringify({ type: 'request-control', sourceType: 'DEVICE_AUDIO', note: 'Smoke request' }));
const requestState = await hostSawRejectedRequest;
console.log('host saw request');
const requestId = requestState.state.requests[0].id;
const guestSawRejection = guest.wait((message) => message.type === 'request-result' && message.status === 'REJECTED');
host.socket.send(JSON.stringify({ type: 'reject-request', requestId }));
await guestSawRejection;
console.log('guest rejection delivered');

const hostSawApprovalRequest = host.wait((message) => message.type === 'state' && message.state.requests.length === 1 && message.state.requests[0].note === 'Second smoke request');
guest.socket.send(JSON.stringify({ type: 'request-control', sourceType: 'DEVICE_AUDIO', note: 'Second smoke request' }));
const approvalRequestState = await hostSawApprovalRequest;
const approvalRequestId = approvalRequestState.state.requests[0].id;
const guestSawApproval = guest.wait((message) => message.type === 'request-result' && message.status === 'APPROVED');
const hostSawParticipantSource = host.wait((message) => message.type === 'state' && message.state.room.activeSourceId === approvalRequestState.state.requests[0].requesterId);
host.socket.send(JSON.stringify({ type: 'approve-request', requestId: approvalRequestId }));
await guestSawApproval;
await hostSawParticipantSource;
console.log('guest approved');

const secondGuest = client();
await secondGuest.open();
secondGuest.socket.send(JSON.stringify({ type: 'join-room', code: created.state.room.code, displayName: 'Taylor', guestId: 'smoke-second-guest' }));
await secondGuest.wait((message) => message.type === 'joined');
const blockedRequest = secondGuest.wait((message) => message.type === 'error' && message.message.includes('paused'));
secondGuest.socket.send(JSON.stringify({ type: 'request-control', sourceType: 'DEVICE_AUDIO', note: 'Blocked while another participant shares' }));
await blockedRequest;
console.log('second request correctly blocked');

const hostSawTakeover = host.wait((message) => message.type === 'state' && message.state.room.activeSourceId === message.state.room.hostId);
host.socket.send(JSON.stringify({ type: 'takeover', sourceType: 'TEST_TONE' }));
await hostSawTakeover;
console.log('host takeover succeeded');

const hostSawOfflineRequest = host.wait((message) => message.type === 'state' && message.state.requests.length === 1 && message.state.requests[0].note === 'Offline request');
secondGuest.socket.send(JSON.stringify({ type: 'request-control', sourceType: 'DEVICE_AUDIO', note: 'Offline request' }));
const offlineRequestState = await hostSawOfflineRequest;
console.log('host saw offline request');
const offlineApprovalError = host.wait((message) => message.type === 'error' && message.message.includes('no longer connected'));
const hostSawSecondGuestOffline = host.wait((message) => message.type === 'state' && message.state.members.some((member) => member.guestId === 'smoke-second-guest' && !member.online));
secondGuest.socket.close();
await hostSawSecondGuestOffline;
host.socket.send(JSON.stringify({ type: 'approve-request', requestId: offlineRequestState.state.requests[0].id }));
await offlineApprovalError;
console.log('offline requester cannot be approved');

const cohostState = host.wait((message) => message.type === 'state' && message.state.room.cohostId);
const guestMember = (await guest.wait((message) => message.type === 'state' && message.state.members.some((member) => member.guestId === 'smoke-guest'))).state.members.find((member) => member.guestId === 'smoke-guest');
host.socket.send(JSON.stringify({ type: 'assign-cohost', memberId: guestMember.id }));
await cohostState;
console.log('co-host assignment succeeded');

const promotedState = guest.wait((message) => message.type === 'state' && message.state.room.hostId === guestMember.id);
host.socket.send(JSON.stringify({ type: 'leave-room' }));
await promotedState;
console.log('co-host promotion after host leave succeeded');

console.log(JSON.stringify({ roomCode: created.state.room.code, joinedMembers: 3, rejectionDelivered: true, requestApproved: true, competingRequestBlocked: true, hostTakeover: true, offlineApprovalBlocked: true, cohostAssigned: true, hostLeavePromotion: true }));
if (host.socket.readyState === WebSocket.OPEN) host.socket.close();
guest.socket.close();
secondGuest.socket.close();
