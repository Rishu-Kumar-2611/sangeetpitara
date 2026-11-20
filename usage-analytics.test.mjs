import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageAnalytics } from './usage-analytics.mjs';
import { InMemoryRepository } from './persistence.mjs';

test('server usage counts device identities, idle time, received audio and reconnects separately', async () => {
  let time = Date.UTC(2026, 10, 18);
  const repository = new InMemoryRepository();
  const usage = createUsageAnalytics({ repository, now: () => time });
  const host = { _usageAgent: 'okhttp' }, listener = { _usageAgent: 'Chrome' };
  usage.attach(host, { guestId: 'host' }, { created: true });
  usage.attach(listener, { guestId: 'listener' });
  time += 1000;
  usage.delivery(listener, { sampleRate: 48000, sampleCount: 960, sourceEpoch: 1, sequence: 1 });
  usage.delivery(listener, { sampleRate: 48000, sampleCount: 960, sourceEpoch: 1, sequence: 1 });
  usage.delivery(listener, { sampleRate: 48000, sampleCount: 960, sourceEpoch: 1, sequence: 2 }, true);
  time += 1000;
  usage.detach(listener);
  usage.attach(listener, { guestId: 'listener' }, { reconnect: true });
  time += 1000;
  usage.detach(listener); usage.detach(host);
  await usage.flush();
  const summary = await repository.usageSummary('2026-11-18');
  assert.equal(summary.totals.users, 2); assert.equal(summary.totals.sessions, 3);
  assert.equal(summary.totals.onlineMs, 6000); assert.equal(summary.totals.listeningMs, 20);
  assert.equal(summary.totals.roomsCreated, 1); assert.equal(summary.totals.reconnects, 1);
  assert.equal(summary.totals.dropped, 1); assert.equal(usage.onlineUsers, 0);
  assert.deepEqual(new Set(summary.platforms.map(row => row.platform)), new Set(['android', 'web']));
  assert.doesNotMatch(JSON.stringify([...repository.usageRows.values()]), /"host"|"listener"/);
});

test('midnight splits daily duration and a retry after commit never doubles usage', async () => {
  let time = Date.UTC(2026, 10, 18) - 1000;
  const repository = new InMemoryRepository();
  const write = repository.writeUsageBatch.bind(repository);
  let fail = true;
  repository.writeUsageBatch = async batch => { await write(batch); if (fail) { fail = false; throw new Error('response lost after commit'); } };
  const usage = createUsageAnalytics({ repository, now: () => time });
  const socket = {};
  usage.attach(socket, { guestId: 'same-device' });
  time += 2000; usage.detach(socket);
  await assert.rejects(usage.flush()); await usage.flush();
  const summary = await repository.usageSummary('2026-11-17');
  assert.equal(summary.totals.onlineMs, 2000); assert.equal(summary.totals.users, 1);
  assert.deepEqual(summary.daily.map(row => [row.day, row.onlineMs]), [['2026-11-17', 1000], ['2026-11-18', 1000]]);
});

test('burst packet claims cannot manufacture hours of listening time', async () => {
  let time = Date.UTC(2026, 10, 18);
  const repository = new InMemoryRepository();
  const usage = createUsageAnalytics({ repository, now: () => time });
  const socket = {}; usage.attach(socket, { guestId: 'device' });
  time += 1000;
  for (let sequence = 0; sequence < 10000; sequence++) usage.delivery(socket, { sampleRate: 48000, sampleCount: 5760, sourceEpoch: 1, sequence });
  usage.detach(socket); await usage.flush();
  const summary = await repository.usageSummary('2026-11-18');
  assert.ok(summary.totals.listeningMs <= 1000);
});

test('a prolonged database outage cannot grow pending analytics without a bound', async () => {
  let time = Date.UTC(2026, 10, 20);
  const repository = new InMemoryRepository();
  const write = repository.writeUsageBatch.bind(repository);
  repository.writeUsageBatch = async () => { throw new Error('database offline'); };
  const usage = createUsageAnalytics({ repository, now: () => time, maxPendingRows: 3, maxRetryAgeMs: 1000 });
  for (let id = 0; id < 20; id++) { const socket = {}; usage.attach(socket, { guestId: String(id) }); usage.detach(socket); }
  assert.ok(usage.status.pendingRows <= 3); assert.ok(usage.status.discardedRows > 0);
  await assert.rejects(usage.flush());
  for (let id = 20; id < 40; id++) { const socket = {}; usage.attach(socket, { guestId: String(id) }); usage.detach(socket); }
  assert.ok(usage.status.pendingRows <= 6);
  time += 1001; repository.writeUsageBatch = write; await usage.flush();
  assert.ok(usage.status.discardedRows >= 3); assert.equal(usage.status.retrying, false);
  assert.ok(usage.status.lastPersistedAt);
});
