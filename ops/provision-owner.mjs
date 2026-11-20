// Run once from an operator terminal with the production DATABASE_URL.
// Inputs stay in environment variables, never CLI arguments or committed files.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRepositoryFromEnv } from '../persistence.mjs';
import { hashPassword, normalizeEmail } from '../auth.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!process.env.ADMIN_SETUP_EMAIL || !process.env.ADMIN_SETUP_PASSWORD) throw new Error('Set ADMIN_SETUP_EMAIL and ADMIN_SETUP_PASSWORD in your operator terminal.');
const email = normalizeEmail(process.env.ADMIN_SETUP_EMAIL);
const passwordHash = await hashPassword(process.env.ADMIN_SETUP_PASSWORD);
delete process.env.ADMIN_SETUP_PASSWORD;
const repository = await createRepositoryFromEnv(process.env);
try {
  const existing = await repository.findUserByEmail(email);
  if (existing && process.env.ADMIN_SETUP_REPLACE_EXISTING !== '1') throw new Error('This account already exists. To deliberately reset its password and sessions, set ADMIN_SETUP_REPLACE_EXISTING=1 and rerun.');
  const client = await repository.pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    if (existing) {
      id = existing.id;
      await client.query('UPDATE users SET password_hash=$2, auth_version=auth_version+1, is_admin=TRUE, revoked_at=NULL, admin_totp_step=-1 WHERE id=$1', [id, passwordHash]);
      await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await client.query('DELETE FROM admin_recovery_codes WHERE user_id=$1', [id]);
    } else {
      id = randomUUID();
      await client.query('INSERT INTO users (id,email,password_hash,is_admin) VALUES ($1,$2,$3,TRUE)', [id, email, passwordHash]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // 160 random bits, encoded as a standard 32-character Base32 TOTP key.
  const bytes = randomBytes(20);
  let bits = 0, buffer = 0, key = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; key += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(buffer >>> bits) & 31]; }
  }
  console.log(`Owner account provisioned. Store these values in your deployment secret settings:\nADMIN_OWNER_ID=${id}\nADMIN_TOTP_SECRET=${key}\n\nEnroll the same authenticator key: SHA1, 6 digits, 30 seconds. This is the only time this setup command prints the key. Treat this terminal output as a secret.`);
} finally { await repository.close(); }
