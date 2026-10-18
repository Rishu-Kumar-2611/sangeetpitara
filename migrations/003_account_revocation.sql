ALTER TABLE users ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_revoked_at_idx ON users (revoked_at);
