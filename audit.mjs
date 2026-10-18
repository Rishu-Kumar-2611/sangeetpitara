import { randomUUID } from 'node:crypto';
import { redactSecrets } from './security.mjs';

export const AUDIT_EVENT_TYPES = Object.freeze([
  'server.started',
  'server.ready',
  'server.shutdown',
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',
  'room.created',
  'room.joined',
  'room.left',
  'room.ended',
  'moderation.report.created',
  'moderation.report.reviewed',
  'moderation.report.resolved',
  'moderation.report.dismissed',
  'moderation.block.created',
  'moderation.block.removed',
  'moderation.ban.created',
  'moderation.ban.revoked',
  'security.rate_limited',
  'security.request_rejected',
]);

const AUDIT_EVENT_TYPE_SET = new Set(AUDIT_EVENT_TYPES);
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);

export class AuditValidationError extends Error {
  constructor(message, { field = null, code = 'INVALID_AUDIT_EVENT' } = {}) {
    super(message);
    this.name = 'AuditValidationError';
    this.status = 400;
    this.code = code;
    this.field = field;
  }
}

function requiredString(value, field, { optional = false, max = 160 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw new AuditValidationError(`${field} is required.`, { field, code: 'REQUIRED_FIELD' });
  }
  if (typeof value !== 'string') throw new AuditValidationError(`${field} must be a string.`, { field, code: 'INVALID_FIELD' });
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new AuditValidationError(`${field} is invalid.`, { field, code: 'INVALID_FIELD' });
  return normalized;
}

function timestamp(value, field, fallback) {
  const candidate = value === undefined || value === null ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new AuditValidationError(`${field} must be a valid timestamp.`, { field, code: 'INVALID_TIMESTAMP' });
  return date.toISOString();
}

function optionsWithDefaults(options = {}) {
  const clock = options.clock || (() => new Date());
  const idGenerator = options.idGenerator || randomUUID;
  if (typeof clock !== 'function' || typeof idGenerator !== 'function') throw new TypeError('clock and idGenerator must be functions.');
  const now = clock();
  const nowDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new TypeError('clock must return a valid Date or timestamp.');
  return { clock, idGenerator, now: nowDate.toISOString() };
}

function normalizedEventType(value) {
  const type = requiredString(value, 'type', { max: 80 }).toLowerCase();
  if (!/^[a-z][a-z0-9_.-]*$/.test(type) || (!AUDIT_EVENT_TYPE_SET.has(type) && !type.startsWith('custom.'))) {
    throw new AuditValidationError('type is not an allowed audit event type.', { field: 'type', code: 'INVALID_EVENT_TYPE' });
  }
  return type;
}

function clone(value) {
  return structuredClone(value);
}

export function createAuditEvent(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuditValidationError('Audit event must be an object.');
  const { idGenerator, now } = optionsWithDefaults(options);
  const metadata = input.metadata === undefined ? {} : input.metadata;
  const metadataPrototype = metadata && typeof metadata === 'object' ? Object.getPrototypeOf(metadata) : null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (metadataPrototype !== Object.prototype && metadataPrototype !== null)) {
    throw new AuditValidationError('metadata must be an object.', { field: 'metadata', code: 'INVALID_FIELD' });
  }
  const event = {
    id: requiredString(input.id ?? idGenerator(), 'id'),
    type: normalizedEventType(input.type),
    occurredAt: timestamp(input.occurredAt, 'occurredAt', now),
    ...(input.actorId !== undefined ? { actorId: requiredString(input.actorId, 'actorId') } : {}),
    ...(input.targetId !== undefined ? { targetId: requiredString(input.targetId, 'targetId') } : {}),
    ...(input.roomId !== undefined ? { roomId: requiredString(input.roomId, 'roomId') } : {}),
    ...(input.requestId !== undefined ? { requestId: requiredString(input.requestId, 'requestId') } : {}),
    ...(input.severity !== undefined ? { severity: requiredString(input.severity, 'severity', { max: 12 }).toLowerCase() } : {}),
    metadata: redactSecrets(metadata),
  };
  if (event.severity && !SEVERITIES.has(event.severity)) {
    throw new AuditValidationError('severity is invalid.', { field: 'severity', code: 'INVALID_CHOICE' });
  }
  return event;
}

export function createAuditRecorder({
  maxEvents = 2_000,
  clock,
  idGenerator,
  sink = null,
  onSinkError = () => {},
} = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000) throw new TypeError('maxEvents must be between 1 and 100000.');
  if (sink !== null && typeof sink !== 'function') throw new TypeError('sink must be a function or null.');
  if (typeof onSinkError !== 'function') throw new TypeError('onSinkError must be a function.');
  const events = [];

  function deliver(event) {
    if (!sink) return;
    try {
      const result = sink(clone(event));
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          try { onSinkError(error, clone(event)); } catch { /* logging must not break the request path */ }
        });
      }
    } catch (error) {
      try { onSinkError(error, clone(event)); } catch { /* logging must not break the request path */ }
    }
  }

  function record(input) {
    const event = createAuditEvent(input, { clock, idGenerator });
    events.push(clone(event));
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    deliver(event);
    return clone(event);
  }

  function list({ type, actorId, roomId, since, limit = maxEvents } = {}) {
    const normalizedType = type === undefined ? undefined : normalizedEventType(type);
    const sinceMs = since === undefined ? null : Date.parse(since);
    if (since !== undefined && Number.isNaN(sinceMs)) throw new TypeError('since must be a valid timestamp.');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer.');
    return events
      .filter((event) => !normalizedType || event.type === normalizedType)
      .filter((event) => actorId === undefined || event.actorId === actorId)
      .filter((event) => roomId === undefined || event.roomId === roomId)
      .filter((event) => sinceMs === null || Date.parse(event.occurredAt) >= sinceMs)
      .slice(-limit)
      .map(clone);
  }

  return {
    record,
    list,
    events: list,
    get size() { return events.length; },
    clear() { events.length = 0; },
  };
}
