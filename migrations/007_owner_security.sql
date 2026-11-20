ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS usage_batches_created_idx ON usage_batches (created_at);
-- Reports may be submitted by an authenticated room membership capability.
-- Account reporters remain identifiable by reporter_id; guest reports are not accounts.
ALTER TABLE moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_reporter_id_fkey;
