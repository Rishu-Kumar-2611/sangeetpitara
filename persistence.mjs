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
    isAdmin: Boolean(row.isAdmin ?? row.is_admin),
    revokedAt: (row.revokedAt ?? row.revoked_at) ? isoDate(row.revokedAt ?? row.revoked_at) : null,
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

function mapReport(row) {
  if (!row) return null;
  return {
    kind: 'REPORT',
    id: row.id,
    roomId: row.room_id ?? row.roomId ?? null,
    reporterId: row.reporter_id ?? row.reporterId,
    targetId: row.target_id ?? row.targetId,
    category: row.category,
    description: row.description || '',
    status: row.status,
    createdAt: isoDate(row.created_at ?? row.createdAt),
    updatedAt: isoDate(row.updated_at ?? row.updatedAt),
  };
}

function mapBlock(row) {
  if (!row) return null;
  return {
    kind: 'BLOCK',
    id: row.id,
    roomId: row.room_id ?? row.roomId ?? null,
    blockerId: row.blocker_id ?? row.blockerId,
    blockedId: row.blocked_id ?? row.blockedId,
    reason: row.reason || '',
    active: row.active !== false,
    createdAt: isoDate(row.created_at ?? row.createdAt),
    expiresAt: (row.expires_at ?? row.expiresAt) ? isoDate(row.expires_at ?? row.expiresAt) : null,
  };
}

function mapBan(row) {
  if (!row) return null;
  return {
    kind: 'BAN',
    id: row.id,
    roomId: row.room_id ?? row.roomId ?? null,
    subjectId: row.subject_id ?? row.subjectId,
    issuedBy: row.issued_by ?? row.issuedBy,
    reason: row.reason,
    status: row.status,
    createdAt: isoDate(row.created_at ?? row.createdAt),
    expiresAt: (row.expires_at ?? row.expiresAt) ? isoDate(row.expires_at ?? row.expiresAt) : null,
  };
}

function mapEntitlement(row) {
  if (!row) return null;
  return {
    subjectId: row.subject_id ?? row.subjectId,
    provider: row.provider,
    customerId: row.customer_id ?? row.customerId ?? null,
    subscriptionId: row.subscription_id ?? row.subscriptionId ?? null,
    priceId: row.price_id ?? row.priceId ?? null,
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: (row.current_period_end ?? row.currentPeriodEnd) ? isoDate(row.current_period_end ?? row.currentPeriodEnd) : null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end ?? row.cancelAtPeriodEnd),
    updatedAt: isoDate(row.updated_at ?? row.updatedAt),
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
    this.reportsById = new Map();
    this.blocksById = new Map();
    this.bansById = new Map();
    this.entitlementsBySubject = new Map();
    this.billingEvents = new Set();
  }

  async migrate() {
    return { applied: [], kind: this.kind };
  }

  async healthCheck() {
    return true;
  }

  async createUser({ email, passwordHash, createdAt } = {}) {
    const normalizedEmail = normalizeEmail(email);
    if (this.userIdsByEmail.has(normalizedEmail)) throw new DuplicateEmailError();
    const user = {
      id: this.idGenerator(),
      email: normalizedEmail,
      passwordHash,
      isAdmin: false,
      revokedAt: null,
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
    const user = this.usersById.get(session.userId);
    if (!user || user.revokedAt) {
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

  async revokeUser(userId, revokedAt = this.clock()) {
    const user = this.usersById.get(userId);
    if (!user) return false;
    user.revokedAt = isoDate(revokedAt);
    await this.deleteSessionsForUser(userId);
    return true;
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

  async createReport(record) {
    this.reportsById.set(record.id, clone(record));
    return clone(record);
  }

  async listReports({ reporterId = null, status = null, limit = 100 } = {}) {
    return [...this.reportsById.values()]
      .filter((record) => !reporterId || record.reporterId === reporterId)
      .filter((record) => !status || record.status === status)
      .slice(-limit)
      .map(clone);
  }

  async updateReport(record) {
    this.reportsById.set(record.id, clone(record));
    return clone(record);
  }

  async createBlock(record) {
    this.blocksById.set(record.id, clone(record));
    return clone(record);
  }

  async listBlocks({ blockerId = null, blockedId = null, roomId = null, activeOnly = false } = {}) {
    return [...this.blocksById.values()]
      .filter((record) => !blockerId || record.blockerId === blockerId)
      .filter((record) => !blockedId || record.blockedId === blockedId)
      .filter((record) => !roomId || record.roomId === roomId)
      .filter((record) => !activeOnly || record.active !== false)
      .map(clone);
  }

  async deactivateBlock(id) {
    const record = this.blocksById.get(id);
    if (!record) return false;
    record.active = false;
    return true;
  }

  async createBan(record) {
    this.bansById.set(record.id, clone(record));
    return clone(record);
  }

  async listBans({ subjectId = null, roomId = null, activeOnly = false } = {}) {
    return [...this.bansById.values()]
      .filter((record) => !subjectId || record.subjectId === subjectId)
      .filter((record) => !roomId || record.roomId === roomId)
      .filter((record) => !activeOnly || record.status === 'ACTIVE')
      .map(clone);
  }

  async getEntitlement(subjectId) {
    return clone(this.entitlementsBySubject.get(subjectId));
  }

  async upsertEntitlement(record) {
    this.entitlementsBySubject.set(record.subjectId, clone(record));
    return clone(record);
  }

  async recordBillingEvent(provider, providerEventId) {
    const key = `${provider}:${providerEventId}`;
    if (this.billingEvents.has(key)) return false;
    this.billingEvents.add(key);
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

  async healthCheck() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async createUser({ email, passwordHash, id = randomUUID(), createdAt } = {}) {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP))
         RETURNING id, email, password_hash, is_admin, revoked_at, created_at`,
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
        `SELECT id, email, password_hash, is_admin, revoked_at, created_at
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [normalizeEmail(email)],
    );
    return mapUser(result.rows[0]);
  }

  async findUserById(id) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, is_admin, revoked_at, created_at
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
       JOIN users ON users.id = sessions.user_id
       WHERE token_hash = $1
         AND users.revoked_at IS NULL
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

  async revokeUser(userId, revokedAt = new Date()) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE users SET revoked_at = $2::timestamptz WHERE id = $1 AND revoked_at IS NULL',
        [userId, isoDate(revokedAt)],
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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

  async createReport(record) {
    const result = await this.pool.query(
      `INSERT INTO moderation_reports (id, room_id, reporter_id, target_id, category, description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
       RETURNING *`,
      [record.id, record.roomId || null, record.reporterId, record.targetId, record.category, record.description, record.status, isoDate(record.createdAt), isoDate(record.updatedAt)],
    );
    return mapReport(result.rows[0]);
  }

  async listReports({ reporterId = null, status = null, limit = 100 } = {}) {
    const result = await this.pool.query(
      `SELECT * FROM moderation_reports
       WHERE ($1::text IS NULL OR reporter_id = $1)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [reporterId, status, Math.min(500, Math.max(1, limit))],
    );
    return result.rows.map(mapReport);
  }

  async updateReport(record) {
    const result = await this.pool.query(
      `UPDATE moderation_reports
       SET status = $2, updated_at = $3::timestamptz, description = $4
       WHERE id = $1
       RETURNING *`,
      [record.id, record.status, isoDate(record.updatedAt), record.description || ''],
    );
    return mapReport(result.rows[0]);
  }

  async createBlock(record) {
    const result = await this.pool.query(
      `INSERT INTO moderation_blocks (id, room_id, blocker_id, blocked_id, reason, active, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       RETURNING *`,
      [record.id, record.roomId || null, record.blockerId, record.blockedId, record.reason || '', record.active !== false, isoDate(record.createdAt), record.expiresAt ? isoDate(record.expiresAt) : null],
    );
    return mapBlock(result.rows[0]);
  }

  async listBlocks({ blockerId = null, blockedId = null, roomId = null, activeOnly = false } = {}) {
    const result = await this.pool.query(
      `SELECT * FROM moderation_blocks
       WHERE ($1::text IS NULL OR blocker_id = $1)
         AND ($2::text IS NULL OR blocked_id = $2)
         AND ($3::text IS NULL OR room_id = $3)
         AND ($4::boolean = FALSE OR active = TRUE)`,
      [blockerId, blockedId, roomId, activeOnly],
    );
    return result.rows.map(mapBlock);
  }

  async deactivateBlock(id) {
    const result = await this.pool.query('UPDATE moderation_blocks SET active = FALSE WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async createBan(record) {
    const result = await this.pool.query(
      `INSERT INTO moderation_bans (id, room_id, subject_id, issued_by, reason, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       RETURNING *`,
      [record.id, record.roomId || null, record.subjectId, record.issuedBy, record.reason, record.status, isoDate(record.createdAt), record.expiresAt ? isoDate(record.expiresAt) : null],
    );
    return mapBan(result.rows[0]);
  }

  async listBans({ subjectId = null, roomId = null, activeOnly = false } = {}) {
    const result = await this.pool.query(
      `SELECT * FROM moderation_bans
       WHERE ($1::text IS NULL OR subject_id = $1)
         AND ($2::text IS NULL OR room_id = $2)
         AND ($3::boolean = FALSE OR status = 'ACTIVE')`,
      [subjectId, roomId, activeOnly],
    );
    return result.rows.map(mapBan);
  }

  async getEntitlement(subjectId) {
    const result = await this.pool.query('SELECT * FROM entitlements WHERE subject_id = $1 LIMIT 1', [subjectId]);
    return mapEntitlement(result.rows[0]);
  }

  async upsertEntitlement(record) {
    const result = await this.pool.query(
      `INSERT INTO entitlements (
         subject_id, provider, customer_id, subscription_id, price_id, plan, status,
         current_period_end, cancel_at_period_end, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz)
       ON CONFLICT (subject_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         customer_id = EXCLUDED.customer_id,
         subscription_id = EXCLUDED.subscription_id,
         price_id = EXCLUDED.price_id,
         plan = EXCLUDED.plan,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [record.subjectId, record.provider, record.customerId, record.subscriptionId, record.priceId, record.plan, record.status, record.currentPeriodEnd ? isoDate(record.currentPeriodEnd) : null, Boolean(record.cancelAtPeriodEnd), isoDate(record.updatedAt || new Date())],
    );
    return mapEntitlement(result.rows[0]);
  }

  async recordBillingEvent(provider, providerEventId) {
    const result = await this.pool.query(
      `INSERT INTO billing_events (provider, provider_event_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [provider, providerEventId],
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
