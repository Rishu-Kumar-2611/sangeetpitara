import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHealthState,
  createLogger,
  createMetricsRegistry,
} from './observability.mjs';

test('structured logger emits JSON lines with secrets and room codes redacted', () => {
  const lines = [];
  const logger = createLogger({
    service: 'roomsound-test',
    level: 'debug',
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    sink: (line) => lines.push(line),
  });
  logger.info('member joined', {
    room: { code: 'ABC123' },
    authorization: 'Bearer private-token',
    memberId: 'member-1',
  });
  logger.error('failed password=secret', new Error('token=error-token'));
  logger.child({ roomCode: 'DEF456' }).warn('request token=embedded');

  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.deepEqual(first.room, { code: '[REDACTED]' });
  assert.equal(first.authorization, '[REDACTED]');
  assert.equal(first.memberId, 'member-1');
  assert.equal(first.time, '2026-01-01T00:00:00.000Z');
  assert.equal(first.service, 'roomsound-test');
  const second = JSON.parse(lines[1]);
  assert.match(second.message, /password=\[REDACTED\]/);
  assert.equal(second.error.message, 'token=[REDACTED]');
  assert.equal(JSON.parse(lines[2]).roomCode, '[REDACTED]');
});

test('metrics registry provides bounded counters, gauges, histograms, and safe labels', () => {
  const metrics = createMetricsRegistry({ prefix: 'roomsound_test', maxSeries: 10 });
  const requests = metrics.counter('requests', 'HTTP requests');
  requests.inc(2, { method: 'GET', roomCode: 'ABC123' });
  metrics.gauge('connected_clients', 'Connected clients').set(3, { state: 'ready' });
  metrics.histogram('request_duration_seconds', 'Request duration', [0.1, 1]).observe(0.2, { token: 'not-a-label' });

  const output = metrics.renderPrometheus();
  assert.match(output, /# HELP roomsound_test_requests_total HTTP requests/);
  assert.match(output, /roomsound_test_requests_total\{method="GET",roomCode="\[REDACTED\]"\} 2/);
  assert.match(output, /roomsound_test_connected_clients\{state="ready"\} 3/);
  assert.match(output, /roomsound_test_request_duration_seconds_bucket/);
  assert.match(output, /token="\[REDACTED\]"/);
  assert.equal(metrics.snapshot().metrics.length, 3);

  assert.throws(() => metrics.increment('requests', -1), /non-negative/);
  assert.throws(() => metrics.increment('requests', 1, { bad: 'x'.repeat(129) }), /too long/);
});

test('health state separates liveness from readiness and redacts check details', async () => {
  let current = new Date('2026-01-01T00:00:00.000Z');
  const health = createHealthState({
    service: 'roomsound-test',
    version: '1.2.3',
    clock: () => current,
    checks: {
      repository: () => ({ ok: true, details: { roomCode: 'ABC123', pool: 'ready' } }),
      failingDependency: () => false,
    },
  });

  assert.equal(health.health().status, 'ok');
  let readiness = await health.readiness();
  assert.equal(readiness.status, 'not_ready');
  assert.equal(readiness.checks.application.ok, false);
  assert.equal(readiness.checks.repository.details.roomCode, '[REDACTED]');
  assert.equal(readiness.checks.failingDependency.error, 'CHECK_FAILED');

  health.setReady(true);
  health.registerCheck('failingDependency', () => true);
  current = new Date('2026-01-01T00:00:01.500Z');
  readiness = await health.readiness();
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.uptimeSeconds, 1.5);
  assert.equal((await health.readinessResponse()).statusCode, 200);
  assert.equal((await health.healthResponse()).statusCode, 200);
});
