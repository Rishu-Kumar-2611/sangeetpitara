import { createHash } from 'node:crypto';

export const ROOM_RECOVERY_TTL_MS = 15 * 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const guestIdentityKey = value => typeof value === 'string' && value.length ? hash(value) : '';
export const reconnectDigest = value => typeof value === 'string' && value.length ? hash(value) : '';

/** No names, raw guest identities, reconnect tokens, audio, or messages on disk. */
export function snapshotRecovery(room, now = Date.now()) {
  if (room.status !== 'ACTIVE') return { recoveryState: null, recoveryExpiresAt: null };
  const members = [...room.members.values()].filter(member => member.ws ||
    member.id === room.hostId || member.id === room.cohostId || now - member.disconnectedAt < 5 * 60_000)
    .sort((a, b) => {
      const priority = member => member.id === room.hostId ? 0 : member.id === room.cohostId ? 1 : member.ws ? 2 : 3;
      return priority(a) - priority(b);
    }).slice(0, 256).map(member => ({
      id: member.id, accountId: member.accountId || null,
      guestKey: member.guestKey || guestIdentityKey(member.guestId),
      reconnectHash: member.reconnectSecretHash || reconnectDigest(member.reconnectSecret),
      joinedAt: member.joinedAt,
    }));
  return {
    recoveryState: {
      version: 1, hostId: room.hostId, cohostId: room.cohostId || null, members,
      locked: Boolean(room.locked), chatSlowModeSeconds: room.chatSlowModeSeconds || 0,
      retiredCodes: (room.retiredCodes || []).slice(-4),
      bannedGuestKeys: [...(room.bannedGuestKeys || []), ...[...(room.bannedGuestIds || [])].map(guestIdentityKey)].slice(-512),
      bannedReconnectHashes: [...(room.bannedReconnectHashes || []), ...[...(room.bannedReconnectSecrets || [])].map(reconnectDigest)].slice(-512),
    },
    recoveryExpiresAt: new Date(now + ROOM_RECOVERY_TTL_MS).toISOString(),
  };
}

export function restoreRecovery(record, now = Date.now()) {
  const state = record.recoveryState;
  if (!state || state.version !== 1 || !(Date.parse(record.recoveryExpiresAt) > now) ||
      !Array.isArray(state.members) || !state.members.length || state.members.length > 256 ||
      !identifier(state.hostId) || !state.members.some(member => member.id === state.hostId)) return null;
  const ids = new Set();
  const members = new Map();
  for (const member of state.members) {
    if (!identifier(member.id) || ids.has(member.id) || !digest(member.guestKey) || !digest(member.reconnectHash) ||
        (member.accountId != null && !identifier(member.accountId))) return null;
    ids.add(member.id);
    members.set(member.id, { id: member.id, accountId: member.accountId, guestId: null, guestKey: member.guestKey,
      reconnectSecret: null, reconnectSecretHash: member.reconnectHash, name: 'Guest',
      role: member.id === state.hostId ? 'HOST' : member.id === state.cohostId ? 'CO_HOST' : 'PARTICIPANT',
      ws: null, codecs: new Set(['pcm16']), listening: true, disconnectedAt: now,
      joinedAt: Number.isFinite(member.joinedAt) ? member.joinedAt : now });
  }
  return { members, hostId: state.hostId, cohostId: members.has(state.cohostId) ? state.cohostId : null,
    locked: Boolean(state.locked), chatSlowModeSeconds: [0, 2, 5, 10].includes(state.chatSlowModeSeconds) ? state.chatSlowModeSeconds : 0,
    retiredCodes: Array.isArray(state.retiredCodes) ? state.retiredCodes.filter(code => /^(?:[A-F0-9]{6}|[A-Z0-9]{8})$/.test(code)).slice(-4) : [],
    bannedGuestKeys: new Set(Array.isArray(state.bannedGuestKeys) ? state.bannedGuestKeys.filter(digest).slice(-512) : []),
    bannedReconnectHashes: new Set(Array.isArray(state.bannedReconnectHashes) ? state.bannedReconnectHashes.filter(digest).slice(-512) : []),
    recovered: true };
}
