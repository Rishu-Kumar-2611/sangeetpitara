import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 8;
export const DEFAULT_MAX_JSON_KEYS = 200;
export const DEFAULT_MAX_JSON_ARRAY_LENGTH = 200;
export const DEFAULT_MAX_JSON_STRING_BYTES = 8 * 1024;
export const REDACTED = '[REDACTED]';

const decoder = new TextDecoder('utf-8', { fatal: true });
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class SecurityInputError extends Error {
  constructor(message, { status = 400, code = 'INVALID_REQUEST' } = {}) {
    super(message);
    this.name = 'SecurityInputError';
    this.status = status;
    this.code = code;
  }
}

export class RequestBodyError extends SecurityInputError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RequestBodyError';
  }
}

function optionLimit(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function bodyBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError('Request body must be a string, Buffer, Uint8Array, or ArrayBuffer.');
}

function validateJsonValue(value, {
  depth = 0,
  maxDepth,
  maxKeys,
  maxArrayLength,
  maxStringBytes,
  path = '$',
} = {}) {
  if (depth > maxDepth) {
    throw new RequestBodyError('JSON nesting is too deep.', {
      status: 400,
      code: 'JSON_TOO_DEEP',
    });
  }

  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxStringBytes) {
      throw new RequestBodyError('A JSON string is too large.', {
        status: 400,
        code: 'JSON_STRING_TOO_LARGE',
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      throw new RequestBodyError('A JSON array is too large.', {
        status: 400,
        code: 'JSON_ARRAY_TOO_LARGE',
      });
    }
    value.forEach((item, index) => validateJsonValue(item, {
      depth: depth + 1,
      maxDepth,
      maxKeys,
      maxArrayLength,
      maxStringBytes,
      path: `${path}[${index}]`,
    }));
    return;
  }

  if (!value || typeof value !== 'object') return;

  const keys = Object.keys(value);
  if (keys.length > maxKeys) {
    throw new RequestBodyError('A JSON object has too many fields.', {
      status: 400,
      code: 'JSON_OBJECT_TOO_LARGE',
    });
  }
  for (const key of keys) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new RequestBodyError(`Unsafe JSON field at ${path}.`, {
        status: 400,
        code: 'UNSAFE_JSON_FIELD',
      });
    }
    validateJsonValue(value[key], {
      depth: depth + 1,
      maxDepth,
      maxKeys,
      maxArrayLength,
      maxStringBytes,
      path: `${path}.${key}`,
    });
  }
}

function contentTypeFrom(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get('content-type') || '');
  const direct = headers['content-type'] ?? headers['Content-Type'];
  if (direct !== undefined) return String(Array.isArray(direct) ? direct[0] : direct);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === 'content-type');
  return key ? String(headers[key]) : '';
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : '';
  return String(Array.isArray(value) ? value[0] : value);
}

function parseContentLength(headers) {
  const raw = headerValue(headers, 'content-length');
  if (!raw) return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RequestBodyError('Content-Length must be a non-negative integer.', {
      status: 400,
      code: 'INVALID_CONTENT_LENGTH',
    });
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new RequestBodyError('Content-Length is too large.', {
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  }
  return length;
}

/**
 * Parse and bound a JSON payload before application code consumes it.
 * Prototype-pollution keys, oversized values, invalid UTF-8, and non-object
 * top-level payloads are rejected by default.
 */
export function parseJsonBody(body, options = {}) {
  const maxBytes = optionLimit(options.maxBytes, DEFAULT_MAX_BODY_BYTES, 'maxBytes');
  const maxDepth = optionLimit(options.maxDepth, DEFAULT_MAX_JSON_DEPTH, 'maxDepth');
  const maxKeys = optionLimit(options.maxKeys, DEFAULT_MAX_JSON_KEYS, 'maxKeys');
  const maxArrayLength = optionLimit(options.maxArrayLength, DEFAULT_MAX_JSON_ARRAY_LENGTH, 'maxArrayLength');
  const maxStringBytes = optionLimit(options.maxStringBytes, DEFAULT_MAX_JSON_STRING_BYTES, 'maxStringBytes');
  const requireObject = options.requireObject !== false;
  const bytes = bodyBytes(body);

  if (bytes.byteLength > maxBytes) {
    throw new RequestBodyError('Request body is too large.', {
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  }

  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new RequestBodyError('Request body must be valid UTF-8.', {
      status: 400,
      code: 'INVALID_UTF8',
    });
  }
  if (!text.trim()) {
    throw new RequestBodyError('Request body must not be empty.', {
      status: 400,
      code: 'EMPTY_REQUEST_BODY',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestBodyError('Request body must be valid JSON.', {
      status: 400,
      code: 'INVALID_JSON',
    });
  }

  if (requireObject && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new RequestBodyError('Request body must be a JSON object.', {
      status: 400,
      code: 'JSON_OBJECT_REQUIRED',
    });
  }
  validateJsonValue(parsed, { maxDepth, maxKeys, maxArrayLength, maxStringBytes });
  return parsed;
}

/**
 * Read a Node IncomingMessage (or any async iterable of body chunks) without
 * buffering more than the configured limit.
 */
export async function readJsonBody(request, options = {}) {
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('request must be an async iterable.');
  }
  const maxBytes = optionLimit(options.maxBytes, DEFAULT_MAX_BODY_BYTES, 'maxBytes');
  const contentLength = parseContentLength(request.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new RequestBodyError('Request body is too large.', {
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  }
  if (options.requireJsonContentType) {
    const contentType = contentTypeFrom(request.headers).split(';', 1)[0].trim().toLowerCase();
    if (!contentType || (contentType !== 'application/json' && !contentType.endsWith('+json'))) {
      throw new RequestBodyError('Content-Type must be application/json.', {
        status: 415,
        code: 'JSON_CONTENT_TYPE_REQUIRED',
      });
    }
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    let bytes;
    try {
      bytes = bodyBytes(chunk);
    } catch {
      throw new RequestBodyError('Request body contains an invalid chunk.', {
        status: 400,
        code: 'INVALID_REQUEST_BODY',
      });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      throw new RequestBodyError('Request body is too large.', {
        status: 413,
        code: 'REQUEST_BODY_TOO_LARGE',
      });
    }
    chunks.push(bytes);
  }
  return parseJsonBody(Buffer.concat(chunks), options);
}

export async function readRawBody(request, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const limit = optionLimit(maxBytes, DEFAULT_MAX_BODY_BYTES, 'maxBytes');
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('request must be an async iterable.');
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = bodyBytes(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > limit) {
      throw new RequestBodyError('Request body is too large.', {
        status: 413,
        code: 'REQUEST_BODY_TOO_LARGE',
      });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function comparableBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/**
 * Compare secrets without an early byte-by-byte exit. Hashing first also
 * gives crypto.timingSafeEqual fixed-size inputs when the original lengths
 * differ; the length check is evaluated only after the constant-time digest
 * comparison.
 */
export function constantTimeEqual(left, right) {
  const leftBytes = comparableBytes(left);
  const rightBytes = comparableBytes(right);
  if (!leftBytes || !rightBytes) return false;
  const leftDigest = createHash('sha256').update(leftBytes).digest();
  const rightDigest = createHash('sha256').update(rightBytes).digest();
  return timingSafeEqual(leftDigest, rightDigest) && leftBytes.byteLength === rightBytes.byteLength;
}

export const safeEqual = constantTimeEqual;

const SENSITIVE_KEY_PATTERN = /(?:pass(?:word|phrase)?|passwd|pwd|secret|token|credential|authorization|cookie|api[-_]?key|private[-_]?key|signing[-_]?key|database[-_]?url|connection[-_]?string|dsn|jwt|refresh[-_]?token|access[-_]?token|session(?:[-_](?:id|token|key))?)/i;

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key));
}

function isRoomCodeKey(key, parentKey) {
  const current = normalizedKey(key);
  if (current === 'roomcode' || current === 'invitecode') return true;
  return current === 'code' && ['room', 'invite', 'invitation'].includes(normalizedKey(parentKey));
}

function redactString(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:roomsound[_-]?session|access[_-]?token|refresh[_-]?token|room[_-]?code|invite[_-]?code)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|session|session_token|authorization|room_code|invite_code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passphrase|secret|credential|api[_-]?key|authorization|cookie|token)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]');
}

function redactValue(value, key, parentKey, depth, seen, maxDepth) {
  if (isSensitiveKey(key) || isRoomCodeKey(key, parentKey)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth >= maxDepth) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  let redacted;
  if (Array.isArray(value)) {
    redacted = value.map((item) => redactValue(item, '', key, depth + 1, seen, maxDepth));
  } else if (value instanceof Date) {
    redacted = Number.isNaN(value.getTime()) ? '[INVALID_DATE]' : value.toISOString();
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    redacted = `[BINARY ${value.byteLength} BYTES]`;
  } else {
    redacted = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactValue(childValue, childKey, key, depth + 1, seen, maxDepth);
    }
  }
  seen.delete(value);
  return redacted;
}

/**
 * Clone a value for logs/audit metadata while replacing secret-like fields
 * and token-bearing strings. The input is never mutated.
 */
export function redactSecrets(value, { maxDepth = 8 } = {}) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new TypeError('maxDepth must be a positive safe integer.');
  return redactValue(value, '', '', 0, new WeakSet(), maxDepth);
}

export const redactLogValue = redactSecrets;
