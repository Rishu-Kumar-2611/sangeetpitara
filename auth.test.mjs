import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  AuthConflictError,
  AuthValidationError,
  InvalidCredentialsError,
  createAuthService,
  hashPassword,
  hashSessionToken,
  parseCookies,
  serializeSessionCookie,
  verifyPassword,
} from './auth.mjs';
import { InMemoryRepository, createRepositoryFromEnv } from './persistence.mjs';

const credentials = { email: 'Listener@Example.test', password: 'correct horse battery staple' };

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { server, baseUrl: `http://127.0.0.1:${port}` };
    } catch {
      // The listener may need another event-loop turn.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error(`RoomSound server did not start: ${output.join('')}`);
}

function cookieHeader(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] || '';
}

test('password hashes are salted and verify without storing the plaintext', async () => {
  const first = await hashPassword(credentials.password);
  const second = await hashPassword(credentials.password);
  assert.notEqual(first, credentials.password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(credentials.password, first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
});

test('registration validates input, stores a user, and issues a server session', async () => {
  const repository = new InMemoryRepository();
  const service = createAuthService({
    repository,
    sessionTtlMs: 60_000,
    tokenGenerator: () => 'registration-session-token-1234567890',
  });

  await assert.rejects(
    service.register({ email: 'not-an-email', password: 'short' }),
    (error) => error instanceof AuthValidationError && error.field === 'email',
  );

  const result = await service.register(credentials);
  assert.equal(result.user.email, 'listener@example.test');
  assert.equal(result.token, 'registration-session-token-1234567890');
  assert.ok(result.expiresAt);
  const stored = await repository.findUserByEmail(credentials.email);
  assert.ok(stored);
  assert.notEqual(stored.passwordHash, credentials.password);
  assert.equal(await service.currentUser(result.token).then((user) => user.email), 'listener@example.test');
});

test('duplicate registration and incorrect login fail without creating a new account', async () => {
  const repository = new InMemoryRepository();
  let nextToken = 0;
  const service = createAuthService({
    repository,
    tokenGenerator: () => `session-token-${++nextToken}-1234567890`,
  });
  await service.register(credentials);
  await assert.rejects(service.register(credentials), AuthConflictError);
  await assert.rejects(
    service.login({ email: credentials.email, password: 'a definitely wrong password' }),
    InvalidCredentialsError,
  );
  await assert.rejects(
    service.login({ email: 'missing@example.test', password: credentials.password }),
    InvalidCredentialsError,
  );
  assert.equal(repository.sessionsByTokenHash.size, 1);
});

test('login success and logout invalidate only the server-side session', async () => {
  const repository = new InMemoryRepository();
  let nextToken = 0;
  const service = createAuthService({
    repository,
    tokenGenerator: () => `login-session-token-${++nextToken}-1234567890`,
  });
  const registered = await service.register(credentials);
  const loggedIn = await service.login(credentials);
  assert.notEqual(loggedIn.token, registered.token);
  assert.equal((await service.currentUser(loggedIn.token)).email, 'listener@example.test');
  assert.equal(await service.logout(loggedIn.token), true);
  assert.equal(await service.currentUser(loggedIn.token), null);
  assert.equal((await service.currentUser(registered.token)).email, 'listener@example.test');
  assert.equal(await service.logout(loggedIn.token), false);
});

test('repository session contract expires sessions and hashes are one-way', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const repository = new InMemoryRepository({ clock: () => now });
  const user = await repository.createUser({ email: 'contract@example.test', passwordHash: 'scrypt$test' });
  const rawToken = 'contract-session-token-1234567890';
  const tokenHash = hashSessionToken(rawToken);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  await repository.createSession({
    tokenHash,
    userId: user.id,
    expiresAt: new Date(now.getTime() + 1_000).toISOString(),
  });
  assert.equal((await repository.findSession(tokenHash)).userId, user.id);
  now = new Date('2026-01-01T00:00:02.000Z');
  assert.equal(await repository.findSession(tokenHash), null);
  assert.equal(await repository.deleteSession(tokenHash), false);
});

test('DATABASE_URL absence selects the offline repository without opening a database', async () => {
  const repository = await createRepositoryFromEnv({ DATABASE_URL: '' });
  assert.ok(repository instanceof InMemoryRepository);
  assert.equal(repository.kind, 'memory');
  await repository.close();
});

test('session cookies are HttpOnly, same-site, and parseable', () => {
  const cookie = serializeSessionCookie('token/with+safe', { maxAgeSeconds: 60, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.deepEqual(parseCookies('roomsound_session=token%2Fwith%2Bsafe; theme=dark'), {
    roomsound_session: 'token/with+safe',
    theme: 'dark',
  });
});

test('HTTP auth routes register, reject bad login, expose current user, and invalidate logout', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.kill());

  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(register.status, 201);
  const cookie = cookieHeader(register);
  assert.match(cookie, /^roomsound_session=/);
  assert.equal((await register.json()).user.email, 'listener@example.test');

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(duplicate.status, 409);

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: 'wrong password for this account' }),
  });
  assert.equal(badLogin.status, 401);

  const current = await fetch(`${baseUrl}/api/auth/current-user`, { headers: { Cookie: cookie } });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).user.email, 'listener@example.test');

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);
});
