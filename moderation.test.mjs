import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModerationValidationError,
  createBan,
  createBlock,
  createReport,
  isBanned,
  isBlocked,
  transitionReport,
  validateBan,
  validateBlock,
  validateReport,
} from './moderation.mjs';

const now = new Date('2026-01-01T00:00:00.000Z');
const options = {
  clock: () => now,
  idGenerator: (() => {
    let next = 0;
    return () => `moderation-${++next}`;
  })(),
};

test('createReport produces a normalized open report contract', () => {
  const report = createReport({
    roomId: 'room-1',
    reporterId: 'member-1',
    targetId: 'member-2',
    category: 'harassment',
    details: '  Repeated unwanted messages.  ',
  }, options);

  assert.deepEqual(report, {
    kind: 'REPORT',
    id: 'moderation-1',
    roomId: 'room-1',
    reporterId: 'member-1',
    targetId: 'member-2',
    category: 'HARASSMENT',
    description: 'Repeated unwanted messages.',
    status: 'OPEN',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(validateReport(report), { valid: true, errors: [] });
});

test('block and ban contracts enforce identity, scope, and expiry rules', () => {
  const block = createBlock({
    roomId: 'room-1',
    blockerId: 'member-1',
    blockedId: 'member-2',
    reason: 'No longer want direct contact',
    expiresAt: '2026-01-01T01:00:00.000Z',
  }, options);
  const ban = createBan({
    roomId: 'room-1',
    subjectId: 'member-2',
    issuedBy: 'moderator-1',
    reason: 'Repeated abuse',
    expiresAt: '2026-01-01T02:00:00.000Z',
  }, options);

  assert.equal(validateBlock(block).valid, true);
  assert.equal(validateBan(ban).valid, true);
  assert.equal(isBlocked([block], {
    blockerId: 'member-1',
    blockedId: 'member-2',
    roomId: 'room-1',
    now,
  }), true);
  assert.equal(isBlocked([block], {
    blockerId: 'member-1',
    blockedId: 'member-2',
    roomId: 'room-2',
    now,
  }), false);
  assert.equal(isBanned([ban], { subjectId: 'member-2', roomId: 'room-1', now }), true);
  assert.equal(isBanned([ban], { subjectId: 'member-2', roomId: 'room-1', now: new Date('2026-01-01T03:00:00.000Z') }), false);

  assert.throws(
    () => createBlock({ blockerId: 'same', blockedId: 'same' }, options),
    (error) => error instanceof ModerationValidationError && error.code === 'SELF_MODERATION',
  );
  assert.throws(
    () => createBan({ subjectId: 'member-2', issuedBy: 'moderator-1', reason: 'bad', expiresAt: now.toISOString() }, options),
    (error) => error instanceof ModerationValidationError && error.code === 'INVALID_EXPIRY',
  );
  assert.throws(
    () => createBlock({ blockerId: 'member-1', blockedId: 'member-2', active: 'false' }, options),
    (error) => error instanceof ModerationValidationError && error.code === 'INVALID_FIELD',
  );
});

test('report transitions are explicit and update the audit timestamp', () => {
  const report = createReport({ reporterId: 'member-1', targetId: 'member-2' }, options);
  const reviewed = transitionReport(report, 'in_review', {
    clock: () => new Date('2026-01-01T00:05:00.000Z'),
  });
  assert.equal(reviewed.status, 'IN_REVIEW');
  assert.equal(reviewed.updatedAt, '2026-01-01T00:05:00.000Z');

  assert.throws(
    () => transitionReport(reviewed, 'open', options),
    (error) => error instanceof ModerationValidationError && error.code === 'INVALID_STATUS_TRANSITION',
  );
});

test('validators expose actionable errors for malformed records', () => {
  const result = validateReport({ kind: 'REPORT', id: '', status: 'UNKNOWN' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === 'id'));
  assert.ok(result.errors.some((error) => error.field === 'category'));
  assert.ok(result.errors.some((error) => error.field === 'status'));
});
