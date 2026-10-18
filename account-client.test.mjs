import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentUser, logout, submitAuth } from './account-client.mjs';

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('account client uses same-origin credentials without exposing a session token', async () => {
  let call;
  const payload = { user: { id: 'u1', email: 'listener@example.test' } };
  const user = (await submitAuth('login', {
    email: 'listener@example.test',
    password: 'correct horse battery staple',
  }, async (path, init) => {
    call = { path, init };
    return response(200, payload);
  })).user;

  assert.deepEqual(user, payload.user);
  assert.equal(call.path, '/api/auth/login');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), {
    email: 'listener@example.test',
    password: 'correct horse battery staple',
  });
  assert.equal('token' in payload, false);
});

test('expired sessions become a signed-out UI state', async () => {
  let request;
  assert.equal(await getCurrentUser(async (path, init) => {
    request = { path, init };
    return response(401, { error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
  }), null);
  assert.equal(request.path, '/api/auth/me');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'same-origin');
});

test('account errors preserve only the server-safe message and status', async () => {
  await assert.rejects(
    submitAuth('register', { email: 'bad', password: 'short' }, async () => response(400, {
      error: 'Enter a valid email address.',
      code: 'VALIDATION_ERROR',
      field: 'email',
      secret: 'must not reach the UI',
    })),
    (error) => {
      assert.equal(error.message, 'Enter a valid email address.');
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.field, 'email');
      assert.equal('secret' in error, false);
      return true;
    },
  );
});

test('logout is a cookie-only POST', async () => {
  let call;
  await logout(async (path, init) => {
    call = { path, init };
    return response(200, { ok: true });
  });
  assert.equal(call.path, '/api/auth/logout');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.body, undefined);
});
