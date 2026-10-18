import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditValidationError,
  createAuditEvent,
  createAuditRecorder,
} from './audit.mjs';

test('createAuditEvent validates event types and redacts metadata', () => {
  const event = createAuditEvent({
    type: 'moderation.report.created',
    actorId: 'member-1',
    targetId: 'member-2',
    roomId: 'room-1',
    severity: 'INFO',
    metadata: {
      room: { code: 'ABC123' },
      token: 'should-not-be-kept',
      reason: 'Repeated spam',
    },
  }, {
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    idGenerator: () => 'audit-1',
  });

  assert.equal(event.id, 'audit-1');
  assert.equal(event.type, 'moderation.report.created');
  assert.equal(event.severity, 'info');
  assert.equal(event.metadata.room.code, '[REDACTED]');
  assert.equal(event.metadata.token, '[REDACTED]');
  assert.equal(event.metadata.reason, 'Repeated spam');
  assert.equal(event.occurredAt, '2026-01-01T00:00:00.000Z');

  assert.throws(
    () => createAuditEvent({ type: 'not-allowed', metadata: {} }),
    (error) => error instanceof AuditValidationError && error.code === 'INVALID_EVENT_TYPE',
  );
});

test('audit recorder keeps a bounded buffer, supports filters, and isolates sink failures', () => {
  const delivered = [];
  const sinkErrors = [];
  let id = 0;
  const recorder = createAuditRecorder({
    maxEvents: 2,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    idGenerator: () => `audit-${++id}`,
    sink: (event) => {
      delivered.push(event);
      if (event.type === 'security.rate_limited') throw new Error('sink unavailable');
    },
    onSinkError: (error, event) => sinkErrors.push({ message: error.message, id: event.id }),
  });

  recorder.record({ type: 'room.created', roomId: 'room-1', metadata: { roomCode: 'ABC123' } });
  recorder.record({ type: 'security.rate_limited', roomId: 'room-1', metadata: { authorization: 'secret' } });
  recorder.record({ type: 'room.joined', roomId: 'room-2', actorId: 'member-2', metadata: {} });

  assert.equal(recorder.size, 2);
  assert.deepEqual(recorder.list().map((event) => event.type), ['security.rate_limited', 'room.joined']);
  assert.deepEqual(recorder.list({ type: 'room.joined', actorId: 'member-2' }).map((event) => event.id), ['audit-3']);
  assert.equal(delivered[0].metadata.roomCode, '[REDACTED]');
  assert.equal(delivered[1].metadata.authorization, '[REDACTED]');
  assert.deepEqual(sinkErrors, [{ message: 'sink unavailable', id: 'audit-2' }]);

  const listed = recorder.list();
  listed[0].metadata.changed = true;
  assert.equal(recorder.list()[0].metadata.changed, undefined);
});
