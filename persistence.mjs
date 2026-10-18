import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_LOCK_KEY = 6_180_244;

export class DuplicateEmailError extends Error {
  constructor(message = 'An account with that email already exists.') {
    super(message);
    this.name = 'DuplicateEmailError';
    this.code = 'DUPLICATE_EMAIL';
  }
}

export class RepositoryError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RepositoryError';
    this.code = 'REPOSITORY_ERROR';
  }
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isoDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) throw new RepositoryError('Invalid timestamp.');
  return date.toISOString();
}

function clone(value) {
  return value ? { ...value } : null;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash ?? row.password_hash,
    createdAt: isoDate(row.createdAt ?? row.created_at),
  };
}

function mapSession(row) {
  if (!row) return null;
  const lastSeenAt = row.lastSeenAt ?? row.last_seen_at;
  return {
    tokenHash: row.tokenHash ?? row.token_hash,
    userId: row.userId ?? row.user_id,
    expiresAt: isoDate(row.expiresAt ?? row.expires_at),
    createdAt: isoDate(row.createdAt ?? row.created_at),
    lastSeenAt: lastSeenAt ? isoDate(lastSeenAt) : null,
  };
}

function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    hostUserId: row.hostUserId ?? row.host_user_id ?? null,
    cohostUserId: row.cohostUserId ?? row.cohost_user_id ?? null,
    sourceStatus: row.sourceStatus ?? row.source_status ?? 'NONE',
    sourceType: row.sourceType ?? row.source_type ?? null,
    sourceEpoch: Number(row.sourceEpoch ?? row.source_epoch ?? 0),
    createdAt: isoDate(row.createdAt ?? row.created_at),
    updatedAt: isoDate(row.updatedAt ?? row.updated_at),
    endedAt: (row.endedAt ?? row.ended_at) ? isoDate(row.endedAt ?? row.ended_at) : null,
  };
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

/**
 * The offline adapter intentionally implements the same methods as the
 * PostgreSQL adapter. It is useful for unit tests and local development where
 * a database is not available; it is not used when DATABASE_URL is set.
 */
export class InMemoryRepository {
  constructor({ clock = () => new Date(), idGenerator = randomUUID } = {}) {
    this.kind = 'memory';
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.usersById = new Map();
    this.userIdsByEmail = new Map();
    this.sessionsByTokenHash = new Map();
    this.roomsById = new Map();
  }

  async migrate() {
    return { applied: [], kind: this.kind };
  }

  async createUser({ email, passwordHash, createdAt } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (this.userIdsByEmail.has(normalizedEmail)) throw new DuplicateEmailError();
    const user = {
      id: this.idGenerator(),
      email: normalizedEmail,
      passwordHash,
      createdAt: isoDate(createdAt, this.clock()),
    };
    this.usersById.set(user.id, user);
    this.userIdsByEmail.set(user.email, user.id);
    return clone(user);
  }

  async findUserByEmail(email) {
    const userId = this.userIdsByEmail.get(normalizeEmail(email));
    return clone(userId ? this.usersById.get(userId) : null);
  }

  async findUserById(id) {
    return clone(this.usersById.get(id));
  }

  async createSession({ tokenHash, userId, expiresAt, createdAt, lastSeenAt } = {}) {
    if (!this.usersById.has(userId)) throw new RepositoryError('Cannot create a session for an unknown user.');
    const session = {
      tokenHash,
      userId,
      expiresAt: isoDate(expiresAt),
      createdAt: isoDate(createdAt, this.clock()),
      lastSeenAt: lastSeenAt ? isoDate(lastSeenAt) : null,
    };
    this.sessionsByTokenHash.set(tokenHash, session);
    return clone(session);
  }

  async findSession(tokenHash) {
    const session = this.sessionsByTokenHash.get(tokenHash);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= new Date(this.clock()).getTime()) {
      this.sessionsByTokenHash.delete(tokenHash);
      return null;
    }
    if (!this.usersById.has(session.userId)) {
      this.sessionsByTokenHash.delete(tokenHash);
      return null;
    }
    return clone(session);
  }

  async getSession(tokenHash) {
    return this.findSession(tokenHash);
  }

  async deleteSession(tokenHash) {
    return this.sessionsByTokenHash.delete(tokenHash);
  }

  async deleteSessionsForUser(userId) {
    let deleted = 0;
    for (const [tokenHash, session] of this.sessionsByTokenHash) {
      if (session.userId === userId) {
        this.sessionsByTokenHash.delete(tokenHash);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteExpiredSessions(now = this.clock()) {
    const timestamp = new Date(now).getTime();
    let deleted = 0;
    for (const [tokenHash, session] of this.sessionsByTokenHash) {
      if (new Date(session.expiresAt).getTime() <= timestamp) {
        this.sessionsByTokenHash.delete(tokenHash);
        deleted += 1;
      }
    }
    return deleted;
  }

  async createRoom(room) {
    const record = clone(room);
    if (!record?.id || !record.code) throw new RepositoryError('A room id and code are required.');
    this.roomsById.set(record.id, record);
    return clone(record);
  }

  async updateRoom(room) {
    if (!room?.id || !this.roomsById.has(room.id)) return null;
    this.roomsById.set(room.id, clone(room));
    return clone(room);
  }

  async listActiveRooms() {
    return [...this.roomsById.values()]
      .filter((room) => room.status === 'ACTIVE')
      .map(clone);
  }

  async endRoom(roomId, endedAt = this.clock()) {
    const room = this.roomsById.get(roomId);
    if (!room) return false;
    room.status = 'ENDED';
    room.endedAt = isoDate(endedAt);
    room.updatedAt = isoDate(endedAt);
    return true;
  }

  async close() {}
}

export class PostgresRepository {
  constructor({ pool, connectionString, poolOptions = {}, migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY } = {}) {
    if (!pool && !connectionString) throw new RepositoryError('DATABASE_URL is required for PostgreSQL persistence.');
    this.kind = 'postgres';
    this.pool = pool || new Pool({ connectionString, ...poolOptions });
    this.ownsPool = !pool;
    this.migrationsDirectory = migrationsDirectory;
  }

  async migrate() {
    return runMigrations(this.pool, { directory: this.migrationsDirectory });
  }

  async createUser({ email, passwordHash, id = randomUUID(), createdAt } = {}) {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP))
         RETURNING id, email, password_hash, created_at`,
        [id, normalizeEmail(email), passwordHash, createdAt ? isoDate(createdAt) : null],
      );
      return mapUser(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, created_at
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [normalizeEmail(email)],
    );
    return mapUser(result.rows[0]);
  }

  async findUserById(id) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, created_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    return mapUser(result.rows[0]);
  }

  async createSession({ tokenHash, userId, expiresAt, createdAt, lastSeenAt } = {}) {
    const result = await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES ($1, $2, $3::timestamptz, COALESCE($4::timestamptz, CURRENT_TIMESTAMP), $5::timestamptz)
       RETURNING token_hash, user_id, expires_at, created_at, last_seen_at`,
      [tokenHash, userId, isoDate(expiresAt), createdAt ? isoDate(createdAt) : null, lastSeenAt ? isoDate(lastSeenAt) : null],
    );
    return mapSession(result.rows[0]);
  }

  async findSession(tokenHash) {
    const result = await this.pool.query(
      `SELECT token_hash, user_id, expires_at, created_at, last_seen_at
       FROM sessions
       WHERE token_hash = $1
         AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [tokenHash],
    );
    return mapSession(result.rows[0]);
  }

  async getSession(tokenHash) {
    return this.findSession(tokenHash);
  }

  async deleteSession(tokenHash) {
    const result = await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return result.rowCount > 0;
  }

  async deleteSessionsForUser(userId) {
    const result = await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return result.rowCount;
  }

  async deleteExpiredSessions() {
    const result = await this.pool.query('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    return result.rowCount;
  }

  async createRoom(room) {
    const result = await this.pool.query(
      `INSERT INTO rooms (
         id, code, name, status, host_user_id, cohost_user_id,
         source_status, source_type, source_epoch, created_at, updated_at, ended_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz)
       RETURNING id, code, name, status, host_user_id, cohost_user_id,
         source_status, source_type, source_epoch, created_at, updated_at, ended_at`,
      [
        room.id,
        room.code,
        room.name,
        room.status || 'ACTIVE',
        room.hostUserId || null,
        room.cohostUserId || null,
        room.sourceStatus || 'NONE',
        room.sourceType || null,
        Number.isInteger(room.sourceEpoch) ? room.sourceEpoch : 0,
        room.createdAt ? isoDate(room.createdAt) : null,
        room.updatedAt ? isoDate(room.updatedAt) : null,
        room.endedAt ? isoDate(room.endedAt) : null,
      ],
    );
    return mapRoom(result.rows[0]);
  }

  async updateRoom(room) {
    const result = await this.pool.query(
      `UPDATE rooms
       SET name = $2, status = $3, host_user_id = $4, cohost_user_id = $5,
           source_status = $6, source_type = $7, source_epoch = $8,
           updated_at = COALESCE($9::timestamptz, CURRENT_TIMESTAMP),
           ended_at = $10::timestamptz
       WHERE id = $1
       RETURNING id, code, name, status, host_user_id, cohost_user_id,
         source_status, source_type, source_epoch, created_at, updated_at, ended_at`,
      [
        room.id,
        room.name,
        room.status,
        room.hostUserId || null,
        room.cohostUserId || null,
        room.sourceStatus || 'NONE',
        room.sourceType || null,
        Number.isInteger(room.sourceEpoch) ? room.sourceEpoch : 0,
        room.updatedAt ? isoDate(room.updatedAt) : null,
        room.endedAt ? isoDate(room.endedAt) : null,
      ],
    );
    return mapRoom(result.rows[0]);
  }

  async listActiveRooms() {
    const result = await this.pool.query(
      `SELECT id, code, name, status, host_user_id, cohost_user_id,
         source_status, source_type, source_epoch, created_at, updated_at, ended_at
       FROM rooms
       WHERE status = 'ACTIVE'
       ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRoom);
  }

  async endRoom(roomId, endedAt = new Date()) {
    const result = await this.pool.query(
      `UPDATE rooms
       SET status = 'ENDED', ended_at = $2::timestamptz, updated_at = $2::timestamptz
       WHERE id = $1`,
      [roomId, isoDate(endedAt)],
    );
    return result.rowCount > 0;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

async function migrationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d+[\w-]*\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Apply checked-in SQL migrations atomically. The advisory lock prevents two
 * application instances from applying the same migration during a deploy.
 */
export async function runMigrations(pool, { directory = DEFAULT_MIGRATIONS_DIRECTORY } = {}) {
  const files = await migrationFiles(directory);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const file of files) {
      const id = basename(file, '.sql');
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
      if (existing.rowCount) continue;

      const sql = await readFile(join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
        applied.push(id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied, directory };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

export function createRepository({ databaseUrl = process.env.DATABASE_URL, pool, poolOptions, migrationsDirectory } = {}) {
  if (pool) return new PostgresRepository({ pool, poolOptions, migrationsDirectory });
  if (typeof databaseUrl === 'string' && databaseUrl.trim()) {
    return new PostgresRepository({
      connectionString: databaseUrl.trim(),
      poolOptions,
      migrationsDirectory,
    });
  }
  return new InMemoryRepository();
}

export async function createRepositoryFromEnv(env = process.env) {
  const databaseUrl = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL.trim() : '';
  if (!databaseUrl) return new InMemoryRepository();

  const poolOptions = {
    max: Number.isFinite(Number(env.DATABASE_POOL_MAX)) && Number(env.DATABASE_POOL_MAX) > 0
      ? Number(env.DATABASE_POOL_MAX)
      : 10,
    connectionTimeoutMillis: Number.isFinite(Number(env.DATABASE_CONNECT_TIMEOUT_MS)) && Number(env.DATABASE_CONNECT_TIMEOUT_MS) > 0
      ? Number(env.DATABASE_CONNECT_TIMEOUT_MS)
      : 10_000,
  };
  if (env.DATABASE_SSL === '1' || env.DATABASE_SSL === 'true') {
    poolOptions.ssl = { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== '0' };
  }

  const repository = new PostgresRepository({ connectionString: databaseUrl, poolOptions });
  try {
    await repository.migrate();
    return repository;
  } catch (error) {
    await repository.close().catch(() => {});
    throw new RepositoryError(`PostgreSQL migrations failed: ${error.message}`, { cause: error });
  }
}

export { DEFAULT_MIGRATIONS_DIRECTORY };
