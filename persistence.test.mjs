import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSessionToken } from './auth.mjs';
import { DuplicateEmailError, InMemoryRepository, createRepositoryFromEnv } from './persistence.mjs';

test('offline repository persists users, expires sessions, and revokes all sessions', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const repository = new InMemoryRepository({ clock: () => now });
  const user = await repository.createUser({ email: 'USER@example.test', passwordHash: 'opaque-hash' });
  assert.equal(user.email, 'user@example.test');
  await assert.rejects(
    repository.createUser({ email: 'user@example.test', passwordHash: 'other' }),
    DuplicateEmailError,
  );

  const first = hashSessionToken('first-session-token');
  const second = hashSessionToken('second-session-token');
  await repository.createSession({ userId: user.id, tokenHash: first, expiresAt: new Date(now.getTime() + 1000) });
  await repository.createSession({ userId: user.id, tokenHash: second, expiresAt: new Date(now.getTime() + 1000) });
  assert.equal((await repository.findSession(first)).userId, user.id);
  assert.equal(await repository.deleteSessionsForUser(user.id), 2);
  assert.equal(await repository.findSession(first), null);

  const third = hashSessionToken('third-session-token');
  await repository.createSession({ userId: user.id, tokenHash: third, expiresAt: new Date(now.getTime() + 1000) });
  now = new Date('2026-01-01T00:00:02.000Z');
  assert.equal(await repository.findSession(third), null);
  assert.equal(await repository.revokeUser(user.id), true);
  assert.ok((await repository.findUserById(user.id)).revokedAt);
});

test('DATABASE_URL absence selects the offline adapter without opening PostgreSQL', async () => {
  const repository = await createRepositoryFromEnv({ DATABASE_URL: '' });
  assert.ok(repository instanceof InMemoryRepository);
  assert.equal(repository.kind, 'memory');
  await repository.close();
});
