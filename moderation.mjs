import { randomUUID } from 'node:crypto';

export const REPORT_CATEGORIES = Object.freeze([
  'ABUSE',
  'HARASSMENT',
  'IMPERSONATION',
  'ILLEGAL_CONTENT',
  'SPAM',
  'OTHER',
]);

export const REPORT_STATUSES = Object.freeze([
  'OPEN',
  'IN_REVIEW',
  'RESOLVED',
  'DISMISSED',
]);

export const BAN_STATUSES = Object.freeze(['ACTIVE', 'REVOKED']);

export const MODERATION_ACTIONS = Object.freeze([
  'REPORT_CREATED',
  'REPORT_REVIEWED',
  'REPORT_RESOLVED',
  'REPORT_DISMISSED',
  'BLOCK_CREATED',
  'BLOCK_REMOVED',
  'BAN_CREATED',
  'BAN_REVOKED',
]);

const REPORT_TRANSITIONS = Object.freeze({
  OPEN: new Set(['IN_REVIEW', 'RESOLVED', 'DISMISSED']),
  IN_REVIEW: new Set(['RESOLVED', 'DISMISSED']),
  RESOLVED: new Set(),
  DISMISSED: new Set(),
});

export class ModerationValidationError extends Error {
  constructor(message, { field = null, code = 'INVALID_MODERATION_RECORD' } = {}) {
    super(message);
    this.name = 'ModerationValidationError';
    this.status = 400;
    this.code = code;
    this.field = field;
  }
}

function ensureInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModerationValidationError('Moderation input must be an object.');
  }
  return input;
}

function id(value, field, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new ModerationValidationError(`${field} is required.`, { field, code: 'REQUIRED_FIELD' });
  }
  if (typeof value !== 'string') {
    throw new ModerationValidationError(`${field} must be a string.`, { field, code: 'INVALID_FIELD' });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) {
    throw new ModerationValidationError(`${field} must be between 1 and 160 characters.`, { field, code: 'INVALID_FIELD' });
  }
  return normalized;
}

function text(value, field, { optional = true, max = 2_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    throw new ModerationValidationError(`${field} is required.`, { field, code: 'REQUIRED_FIELD' });
  }
  if (typeof value !== 'string') {
    throw new ModerationValidationError(`${field} must be a string.`, { field, code: 'INVALID_FIELD' });
  }
  const normalized = value.trim();
  if (!normalized && !optional) {
    throw new ModerationValidationError(`${field} is required.`, { field, code: 'REQUIRED_FIELD' });
  }
  if (normalized.length > max) {
    throw new ModerationValidationError(`${field} is too long.`, { field, code: 'FIELD_TOO_LONG' });
  }
  return normalized;
}

function choice(value, field, allowed, fallback = null) {
  const normalized = value === undefined || value === null || value === ''
    ? fallback
    : String(value).trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (!normalized || !allowed.includes(normalized)) {
    throw new ModerationValidationError(`${field} must be one of: ${allowed.join(', ')}.`, {
      field,
      code: 'INVALID_CHOICE',
    });
  }
  return normalized;
}

function timestamp(value, field, fallback) {
  const candidate = value === undefined || value === null ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new ModerationValidationError(`${field} must be a valid timestamp.`, { field, code: 'INVALID_TIMESTAMP' });
  }
  return date.toISOString();
}

function defaultOptions(options = {}) {
  const clock = options.clock || (() => new Date());
  const idGenerator = options.idGenerator || randomUUID;
  if (typeof clock !== 'function' || typeof idGenerator !== 'function') throw new TypeError('clock and idGenerator must be functions.');
  const now = clock();
  const nowDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new TypeError('clock must return a valid Date or timestamp.');
  return { clock, idGenerator, now: nowDate.toISOString() };
}

function generatedId(input, idGenerator) {
  return id(input.id ?? idGenerator(), 'id');
}

function expiry(input, createdAt, field = 'expiresAt') {
  if (input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === '') return null;
  const expiresAt = timestamp(input.expiresAt, field, createdAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new ModerationValidationError(`${field} must be after createdAt.`, { field, code: 'INVALID_EXPIRY' });
  }
  return expiresAt;
}

export function createReport(input, options = {}) {
  const source = ensureInput(input);
  const { idGenerator, now } = defaultOptions(options);
  const createdAt = timestamp(source.createdAt, 'createdAt', now);
  const updatedAt = timestamp(source.updatedAt, 'updatedAt', createdAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ModerationValidationError('updatedAt cannot be before createdAt.', { field: 'updatedAt', code: 'INVALID_TIMESTAMP_ORDER' });
  }
  const record = {
    kind: 'REPORT',
    id: generatedId(source, idGenerator),
    roomId: id(source.roomId, 'roomId', { optional: true }),
    reporterId: id(source.reporterId, 'reporterId'),
    targetId: id(source.targetId, 'targetId'),
    category: choice(source.category, 'category', REPORT_CATEGORIES, 'OTHER'),
    description: text(source.description ?? source.details, 'description', { max: 2_000 }),
    status: 'OPEN',
    createdAt,
    updatedAt,
  };
  assertValidReport(record);
  return record;
}

export function createBlock(input, options = {}) {
  const source = ensureInput(input);
  const { idGenerator, now } = defaultOptions(options);
  const createdAt = timestamp(source.createdAt, 'createdAt', now);
  if (source.active !== undefined && typeof source.active !== 'boolean') {
    throw new ModerationValidationError('active must be boolean.', { field: 'active', code: 'INVALID_FIELD' });
  }
  const record = {
    kind: 'BLOCK',
    id: generatedId(source, idGenerator),
    roomId: id(source.roomId, 'roomId', { optional: true }),
    blockerId: id(source.blockerId, 'blockerId'),
    blockedId: id(source.blockedId, 'blockedId'),
    reason: text(source.reason, 'reason', { max: 500 }),
    active: source.active ?? true,
    createdAt,
    expiresAt: expiry(source, createdAt),
  };
  if (record.blockerId === record.blockedId) {
    throw new ModerationValidationError('A member cannot block itself.', { field: 'blockedId', code: 'SELF_MODERATION' });
  }
  assertValidBlock(record);
  return record;
}

export function createBan(input, options = {}) {
  const source = ensureInput(input);
  const { idGenerator, now } = defaultOptions(options);
  const createdAt = timestamp(source.createdAt, 'createdAt', now);
  const record = {
    kind: 'BAN',
    id: generatedId(source, idGenerator),
    roomId: id(source.roomId, 'roomId', { optional: true }),
    subjectId: id(source.subjectId ?? source.bannedId, 'subjectId'),
    issuedBy: id(source.issuedBy ?? source.moderatorId, 'issuedBy'),
    reason: text(source.reason, 'reason', { optional: false, max: 1_000 }),
    status: choice(source.status, 'status', BAN_STATUSES, 'ACTIVE'),
    createdAt,
    expiresAt: expiry(source, createdAt),
  };
  if (record.subjectId === record.issuedBy) {
    throw new ModerationValidationError('A moderator cannot ban itself.', { field: 'subjectId', code: 'SELF_MODERATION' });
  }
  assertValidBan(record);
  return record;
}

function baseErrors(record, kind) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [{ field: null, code: 'INVALID_RECORD', message: 'Record must be an object.' }];
  }
  if (record.kind !== kind) errors.push({ field: 'kind', code: 'INVALID_KIND', message: `kind must be ${kind}.` });
  for (const field of ['id', 'createdAt']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) errors.push({ field, code: 'INVALID_FIELD', message: `${field} is required.` });
  }
  if (record.createdAt && Number.isNaN(Date.parse(record.createdAt))) errors.push({ field: 'createdAt', code: 'INVALID_TIMESTAMP', message: 'createdAt must be valid.' });
  return errors;
}

function addIdError(errors, record, field, { optional = false } = {}) {
  if (record[field] === null && optional) return;
  if (typeof record[field] !== 'string' || !record[field].trim() || record[field].length > 160) {
    errors.push({ field, code: 'INVALID_FIELD', message: `${field} must be a non-empty string.` });
  }
}

export function validateReport(record) {
  const errors = baseErrors(record, 'REPORT');
  if (!errors.length || record?.kind === 'REPORT') {
    addIdError(errors, record, 'roomId', { optional: true });
    addIdError(errors, record, 'reporterId');
    addIdError(errors, record, 'targetId');
    if (!REPORT_CATEGORIES.includes(record?.category)) errors.push({ field: 'category', code: 'INVALID_CHOICE', message: 'category is invalid.' });
    if (!REPORT_STATUSES.includes(record?.status)) errors.push({ field: 'status', code: 'INVALID_CHOICE', message: 'status is invalid.' });
    if (typeof record?.description !== 'string' || record.description.length > 2_000) errors.push({ field: 'description', code: 'INVALID_FIELD', message: 'description is invalid.' });
    if (typeof record?.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) errors.push({ field: 'updatedAt', code: 'INVALID_TIMESTAMP', message: 'updatedAt must be valid.' });
    else if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) errors.push({ field: 'updatedAt', code: 'INVALID_TIMESTAMP_ORDER', message: 'updatedAt cannot be before createdAt.' });
  }
  return { valid: errors.length === 0, errors };
}

export function validateBlock(record) {
  const errors = baseErrors(record, 'BLOCK');
  if (!errors.length || record?.kind === 'BLOCK') {
    addIdError(errors, record, 'roomId', { optional: true });
    addIdError(errors, record, 'blockerId');
    addIdError(errors, record, 'blockedId');
    if (record?.blockerId === record?.blockedId) errors.push({ field: 'blockedId', code: 'SELF_MODERATION', message: 'A member cannot block itself.' });
    if (typeof record?.reason !== 'string' || record.reason.length > 500) errors.push({ field: 'reason', code: 'INVALID_FIELD', message: 'reason is invalid.' });
    if (typeof record?.active !== 'boolean') errors.push({ field: 'active', code: 'INVALID_FIELD', message: 'active must be boolean.' });
    validateExpiry(errors, record);
  }
  return { valid: errors.length === 0, errors };
}

export function validateBan(record) {
  const errors = baseErrors(record, 'BAN');
  if (!errors.length || record?.kind === 'BAN') {
    addIdError(errors, record, 'roomId', { optional: true });
    addIdError(errors, record, 'subjectId');
    addIdError(errors, record, 'issuedBy');
    if (record?.subjectId === record?.issuedBy) errors.push({ field: 'subjectId', code: 'SELF_MODERATION', message: 'A moderator cannot ban itself.' });
    if (typeof record?.reason !== 'string' || !record.reason.trim() || record.reason.length > 1_000) errors.push({ field: 'reason', code: 'INVALID_FIELD', message: 'reason is invalid.' });
    if (!BAN_STATUSES.includes(record?.status)) errors.push({ field: 'status', code: 'INVALID_CHOICE', message: 'status is invalid.' });
    validateExpiry(errors, record);
  }
  return { valid: errors.length === 0, errors };
}

function validateExpiry(errors, record) {
  if (record?.expiresAt === null) return;
  if (typeof record?.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))) {
    errors.push({ field: 'expiresAt', code: 'INVALID_TIMESTAMP', message: 'expiresAt must be null or valid.' });
  } else if (Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    errors.push({ field: 'expiresAt', code: 'INVALID_EXPIRY', message: 'expiresAt must be after createdAt.' });
  }
}

function assertValid(result, label) {
  if (!result.valid) {
    const first = result.errors[0];
    throw new ModerationValidationError(first.message, { field: first.field, code: first.code });
  }
}

export function assertValidReport(record) {
  assertValid(validateReport(record), 'report');
  return record;
}

export function assertValidBlock(record) {
  assertValid(validateBlock(record), 'block');
  return record;
}

export function assertValidBan(record) {
  assertValid(validateBan(record), 'ban');
  return record;
}

export const isValidReport = (record) => validateReport(record).valid;
export const isValidBlock = (record) => validateBlock(record).valid;
export const isValidBan = (record) => validateBan(record).valid;

export function transitionReport(report, nextStatus, options = {}) {
  assertValidReport(report);
  const status = choice(nextStatus, 'status', REPORT_STATUSES);
  if (status !== report.status && !REPORT_TRANSITIONS[report.status]?.has(status)) {
    throw new ModerationValidationError(`A ${report.status} report cannot move to ${status}.`, {
      field: 'status',
      code: 'INVALID_STATUS_TRANSITION',
    });
  }
  const { now } = defaultOptions(options);
  const updated = { ...report, status, updatedAt: timestamp(undefined, 'updatedAt', now) };
  assertValidReport(updated);
  return updated;
}

function activeAt(record, now) {
  if (!record || record.active === false || record.status === 'REVOKED') return false;
  const at = now instanceof Date ? now.getTime() : new Date(now ?? Date.now()).getTime();
  if (!Number.isFinite(at)) return false;
  return !record.expiresAt || Date.parse(record.expiresAt) > at;
}

export function isBlockActive(block, { now = Date.now(), roomId = null } = {}) {
  if (!isValidBlock(block) || !activeAt(block, now)) return false;
  return !block.roomId || block.roomId === roomId;
}

export function isBanActive(ban, { now = Date.now(), roomId = null } = {}) {
  if (!isValidBan(ban) || !activeAt(ban, now)) return false;
  return !ban.roomId || ban.roomId === roomId;
}

export function isBlocked(blocks, { blockerId, blockedId, roomId = null, now = Date.now() } = {}) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => block.blockerId === blockerId && block.blockedId === blockedId && isBlockActive(block, { now, roomId }));
}

export function isBanned(bans, { subjectId, roomId = null, now = Date.now() } = {}) {
  if (!Array.isArray(bans)) return false;
  return bans.some((ban) => ban.subjectId === subjectId && isBanActive(ban, { now, roomId }));
}
