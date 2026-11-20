import { createHash, randomUUID } from 'node:crypto';

export function summarizeUsage(rows, since) {
  const totals = { users: new Set(), onlineMs: 0, listeningMs: 0, sessions: 0, roomsCreated: 0, reconnects: 0, forwarded: 0, dropped: 0 };
  const daily = new Map();
  const platforms = new Map();
  for (const row of rows) {
    const day = String(row.day).slice(0, 10);
    if (day < since) continue;
    const current = daily.get(day) || { day, users: new Set(), onlineMs: 0, listeningMs: 0, sessions: 0, roomsCreated: 0, reconnects: 0, forwarded: 0, dropped: 0 };
    const platform = platforms.get(row.platform) || { platform: row.platform, users: new Set(), onlineMs: 0, listeningMs: 0, sessions: 0, roomsCreated: 0, reconnects: 0, forwarded: 0, dropped: 0 };
    for (const item of [totals, current, platform]) {
      item.users.add(row.visitor);
      for (const key of ['onlineMs', 'listeningMs', 'sessions', 'roomsCreated', 'reconnects', 'forwarded', 'dropped']) item[key] += Number(row[key] || 0);
    }
    daily.set(day, current); platforms.set(row.platform, platform);
  }
  const serial = row => ({ ...row, users: row.users.size });
  return { totals: serial(totals), daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).map(serial), platforms: [...platforms.values()].map(serial) };
}

/** Server-observed room time and relay delivery; never accepts client counters. */
export function createUsageAnalytics({ repository, now = Date.now, onError = () => {}, maxPendingRows = 5000, maxRetryAgeMs = 86_400_000 }) {
  const active = new Map();
  const rowLimit = Math.max(1, Math.min(10000, Math.trunc(maxPendingRows) || 5000));
  const retryLimit = Math.max(1000, Math.min(86_400_000, Number(maxRetryAgeMs) || 86_400_000));
  let pending = new Map();
  let retry = null;
  let flight = null;
  let discardedRows = 0;
  let lastPersistedAt = null;
  const discarded = { onlineMs: 0, listeningMs: 0, sessions: 0, roomsCreated: 0, reconnects: 0, forwarded: 0, dropped: 0 };
  function row(session, time = now()) {
    const day = new Date(time).toISOString().slice(0, 10);
    const key = `${day}:${session.visitor}:${session.platform}`;
    if (!pending.has(key)) {
      if (pending.size >= rowLimit) {
        discardedRows = Math.min(1e12, discardedRows + 1);
        return discarded;
      }
      pending.set(key, { day, visitor: session.visitor, platform: session.platform, onlineMs: 0, listeningMs: 0, sessions: 0, roomsCreated: 0, reconnects: 0, forwarded: 0, dropped: 0 });
    }
    return pending.get(key);
  }
  function tickSession(session, time) {
    // Bound a stalled event loop or dead connection to one sample interval.
    let start = Math.max(session.last, time - 30_000);
    while (start < time) {
      const end = Math.min(time, Date.parse(new Date(start).toISOString().slice(0, 10)) + 86_400_000);
      row(session, start).onlineMs += end - start;
      start = end;
    }
    session.last = time;
  }
  return {
    attach(socket, member, { created = false, reconnect = false } = {}) {
      this.detach(socket);
      const time = now();
      const ua = String(socket._usageAgent || '');
      const session = { visitor: createHash('sha256').update(`sangeetpitara:device:${member.accountId || member.guestId}`).digest('hex'), platform: /Android|okhttp/i.test(ua) ? 'android' : /Electron/i.test(ua) ? 'desktop' : 'web', last: time, audioAt: time, credit: 0, sequence: null };
      active.set(socket, session);
      const data = row(session);
      data.sessions++; data.roomsCreated += Number(created); data.reconnects += Number(reconnect);
    },
    detach(socket) {
      const session = active.get(socket);
      if (session) { tickSession(session, now()); active.delete(socket); }
    },
    delivery(socket, header, dropped = false) {
      const session = active.get(socket);
      if (!session) return;
      const time = now();
      const data = row(session, time);
      if (dropped) { data.dropped++; return; }
      data.forwarded++;
      const sequence = `${header.sourceEpoch}:${header.sequence}`;
      if (sequence === session.sequence) return;
      session.sequence = sequence;
      session.credit = Math.min(1000, session.credit + Math.max(0, time - session.audioAt));
      session.audioAt = time;
      const duration = Math.min(session.credit, header.sampleCount / header.sampleRate * 1000);
      session.credit -= duration;
      data.listeningMs += Math.round(duration);
    },
    tick() { const time = now(); for (const session of active.values()) tickSession(session, time); },
    async flush() {
      if (flight) { await flight; return this.flush(); }
      this.tick();
      if (retry && now() - retry.createdAt > retryLimit) {
        discardedRows = Math.min(1e12, discardedRows + retry.rows.length);
        retry = null;
        onError(new Error('Analytics retry horizon expired; bounded pending statistics were discarded.'));
      }
      if (!retry && !pending.size) return;
      if (!retry) { retry = { id: randomUUID(), createdAt: now(), rows: [...pending.values()] }; pending = new Map(); }
      flight = repository.writeUsageBatch(retry).then(() => { retry = null; lastPersistedAt = now(); }).catch(error => { onError(error); throw error; }).finally(() => { flight = null; });
      return flight;
    },
    get onlineUsers() { return new Set([...active.values()].map(value => value.visitor)).size; },
    get onlineSessions() { return active.size; },
    get status() { return { pendingRows: pending.size + (retry?.rows.length || 0), retrying: Boolean(retry),
      discardedRows, lastPersistedAt: lastPersistedAt === null ? null : new Date(lastPersistedAt).toISOString() }; },
  };
}
