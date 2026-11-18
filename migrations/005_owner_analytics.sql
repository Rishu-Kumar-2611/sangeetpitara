ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_totp_step BIGINT NOT NULL DEFAULT -1;

-- Aggregate device usage only: no room content, names, addresses or raw guest IDs.
CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE NOT NULL,
  visitor CHAR(64) NOT NULL,
  platform VARCHAR(12) NOT NULL,
  online_ms BIGINT NOT NULL DEFAULT 0,
  listening_ms BIGINT NOT NULL DEFAULT 0,
  sessions BIGINT NOT NULL DEFAULT 0,
  rooms_created BIGINT NOT NULL DEFAULT 0,
  reconnects BIGINT NOT NULL DEFAULT 0,
  forwarded BIGINT NOT NULL DEFAULT 0,
  dropped BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, visitor, platform)
);
CREATE TABLE IF NOT EXISTS usage_batches (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
