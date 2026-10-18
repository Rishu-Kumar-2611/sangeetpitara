import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestBodyError,
  constantTimeEqual,
  parseJsonBody,
  readJsonBody,
  redactSecrets,
} from './security.mjs';

async function* chunks(values) {
  for (const value of values) yield value;
}

test('parseJsonBody accepts bounded JSON objects and rejects unsafe payloads', () => {
  assert.deepEqual(parseJsonBody(Buffer.from('{"name":"Listener","nested":{"ok":true}}')), {
    name: 'Listener',
    nested: { ok: true },
  });

  assert.throws(
    () => parseJsonBody('{"__proto__":{"polluted":true}}'),
    (error) => error instanceof RequestBodyError && error.code === 'UNSAFE_JSON_FIELD',
  );
  assert.throws(
    () => parseJsonBody('[]'),
    (error) => error instanceof RequestBodyError && error.code === 'JSON_OBJECT_REQUIRED',
  );
  assert.throws(
    () => parseJsonBody('{"name":"too large"}', { maxBytes: 5 }),
    (error) => error instanceof RequestBodyError && error.status === 413,
  );
});

test('readJsonBody enforces content type, content length, and byte limits', async () => {
  const request = {
    headers: {
      'content-type': 'application/vnd.roomsound+json; charset=utf-8',
      'content-length': '15',
    },
    [Symbol.asyncIterator]: () => chunks(['{"ok":', 'true}']),
  };
  assert.deepEqual(await readJsonBody(request, { maxBytes: 64, requireJsonContentType: true }), { ok: true });

  await assert.rejects(
    readJsonBody({
      headers: { 'content-type': 'text/plain' },
      [Symbol.asyncIterator]: () => chunks(['{}']),
    }, { requireJsonContentType: true }),
    (error) => error instanceof RequestBodyError && error.status === 415,
  );
  await assert.rejects(
    readJsonBody({
      headers: { 'content-length': '1000' },
      [Symbol.asyncIterator]: () => chunks(['{}']),
    }, { maxBytes: 10 }),
    (error) => error instanceof RequestBodyError && error.code === 'REQUEST_BODY_TOO_LARGE',
  );
});

test('constantTimeEqual compares strings and bytes without coercing unrelated values', () => {
  assert.equal(constantTimeEqual('session-token', 'session-token'), true);
  assert.equal(constantTimeEqual('session-token', 'different-token'), false);
  assert.equal(constantTimeEqual(Buffer.from([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(constantTimeEqual('1', '01'), false);
  assert.equal(constantTimeEqual(null, 'session-token'), false);
});

test('redactSecrets clones nested values and removes credentials, tokens, and room codes', () => {
  const input = {
    room: { code: 'ABC123' },
    roomCode: 'DEF456',
    authorization: 'Bearer super-secret-token',
    cookie: 'roomsound_session=private-cookie; theme=dark',
    nested: {
      password: 'correct horse battery staple',
      text: 'token=embedded-token roomCode=GHI789',
    },
    safe: 'visible',
  };
  const redacted = redactSecrets(input);

  assert.equal(redacted.room.code, '[REDACTED]');
  assert.equal(redacted.roomCode, '[REDACTED]');
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.cookie, '[REDACTED]');
  assert.equal(redacted.nested.password, '[REDACTED]');
  assert.match(redacted.nested.text, /token=\[REDACTED\]/);
  assert.match(redacted.nested.text, /roomCode=\[REDACTED\]/);
  assert.equal(redacted.safe, 'visible');
  assert.equal(input.room.code, 'ABC123');
  assert.equal(input.nested.password, 'correct horse battery staple');
});
