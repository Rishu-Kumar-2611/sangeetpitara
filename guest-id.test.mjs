import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestId } from './guest-id.js';

test('uses native randomUUID when available', () => {
  const expected = 'f0ebcfce-6839-4a98-9d28-a22301d475ec';
  assert.equal(createGuestId({ randomUUID: () => expected }), expected);
});

test('creates a UUID without randomUUID on a LAN HTTP browser', () => {
  const httpCrypto = { getRandomValues: (bytes) => crypto.getRandomValues(bytes) };
  assert.throws(() => httpCrypto.randomUUID(), TypeError); // Original startup failure.
  const first = createGuestId(httpCrypto);
  const second = createGuestId(httpCrypto);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('does not replace missing cryptographic randomness with Math.random', () => {
  assert.throws(() => createGuestId({}), /cannot generate a guest identity/);
});
