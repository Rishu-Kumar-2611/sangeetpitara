ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code VARCHAR(6) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  host_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  cohost_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_status VARCHAR(20) NOT NULL DEFAULT 'NONE',
  source_type VARCHAR(60),
  source_epoch INTEGER NOT NULL DEFAULT 0 CHECK (source_epoch >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  CONSTRAINT rooms_code_format CHECK (code ~ '^[A-Z0-9]{4,6}$'),
  CONSTRAINT rooms_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms (status);
CREATE INDEX IF NOT EXISTS rooms_host_user_id_idx ON rooms (host_user_id);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  category VARCHAR(40) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS moderation_reports_status_idx ON moderation_reports (status, created_at);

CREATE TABLE IF NOT EXISTS moderation_blocks (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  CONSTRAINT moderation_blocks_no_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS moderation_blocks_lookup_idx ON moderation_blocks (blocker_id, blocked_id, active);

CREATE TABLE IF NOT EXISTS moderation_bans (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(1000) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  CONSTRAINT moderation_bans_no_self CHECK (subject_id <> issued_by)
);

CREATE INDEX IF NOT EXISTS moderation_bans_lookup_idx ON moderation_bans (subject_id, status);

CREATE TABLE IF NOT EXISTS entitlements (
  subject_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  customer_id VARCHAR(255),
  subscription_id VARCHAR(255),
  price_id VARCHAR(255),
  plan VARCHAR(32) NOT NULL DEFAULT 'free',
  status VARCHAR(32) NOT NULL DEFAULT 'inactive',
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_events (
  provider VARCHAR(32) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, provider_event_id)
);
