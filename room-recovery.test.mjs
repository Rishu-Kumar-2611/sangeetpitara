import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRecovery, restoreRecovery, reconnectDigest, ROOM_RECOVERY_TTL_MS } from './room-recovery.mjs';

function fixture() {
  const members = new Map([['host', { id: 'host', guestId: 'private-guest-host', reconnectSecret: 's'.repeat(43),
    name: 'Private name', ws: {}, joinedAt: 100, role: 'HOST' }],
  ['friend', { id: 'friend', guestId: 'private-guest-friend', reconnectSecret: 'f'.repeat(43), ws: {}, joinedAt: 200 }]]);
  return { status: 'ACTIVE', hostId: 'host', cohostId: 'friend', members, locked: true,
    retiredCodes: ['ABCD2345'], bannedGuestIds: new Set(['banned-person']), bannedReconnectSecrets: new Set(['banned-secret']) };
}

test('restart snapshots preserve ownership and locks without persisting names or raw capabilities', () => {
  const recovery = snapshotRecovery(fixture(), 1000);
  assert.doesNotMatch(JSON.stringify(recovery), /private-guest|Private name|banned-person|banned-secret|ssssss/);
  const restored = restoreRecovery(recovery, 2000);
  assert.equal(restored.hostId, 'host'); assert.equal(restored.cohostId, 'friend'); assert.equal(restored.locked, true);
  assert.equal(restored.members.get('host').role, 'HOST');
  assert.equal(restored.members.get('friend').role, 'CO_HOST');
  assert.equal(restored.members.get('host').reconnectSecretHash, reconnectDigest('s'.repeat(43)));
  assert.equal(restored.members.get('host').ws, null);
  assert.deepEqual(restored.retiredCodes, ['ABCD2345']);
  assert.equal(restored.bannedGuestKeys.size, 1);
});

test('expired, malformed, ambiguous, and ended-room recovery snapshots fail closed', () => {
  const recovery = snapshotRecovery(fixture(), 1000);
  assert.equal(restoreRecovery(recovery, 1000 + ROOM_RECOVERY_TTL_MS), null);
  assert.equal(restoreRecovery({ ...recovery, recoveryState: { ...recovery.recoveryState, hostId: 'missing' } }, 2000), null);
  recovery.recoveryState.members.push(recovery.recoveryState.members[0]);
  assert.equal(restoreRecovery(recovery, 2000), null);
  assert.deepEqual(snapshotRecovery({ ...fixture(), status: 'ENDED' }), { recoveryState: null, recoveryExpiresAt: null });
});

test('a second restart preserves digests instead of hashing them again', () => {
  const saved = snapshotRecovery(fixture(), 1000);
  const restored = restoreRecovery(saved, 2000);
  const savedAgain = snapshotRecovery({ ...restored, status: 'ACTIVE' }, 3000);
  assert.deepEqual(savedAgain.recoveryState.members.map(member => member.reconnectHash), saved.recoveryState.members.map(member => member.reconnectHash));
});

test('bounded restart snapshots retain moderators and online members ahead of recent offline churn', () => {
  const room = fixture();
  const offline = Array.from({ length: 300 }, (_, i) => ['old_' + i, { id: 'old_' + i, guestId: 'old-guest-' + i, reconnectSecret: 'old-secret-' + i, disconnectedAt: 900, joinedAt: 100 }]);
  room.members = new Map([...offline, ...room.members]);
  const restored = restoreRecovery(snapshotRecovery(room, 1000), 2000);
  assert.equal(restored.members.size, 256);
  assert.equal(restored.hostId, 'host');
  assert.equal(restored.cohostId, 'friend');
  assert.equal(restored.members.has('friend'), true);
});
