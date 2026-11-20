-- Only short-lived reconnect capabilities are persisted, never live audio/chat.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS recovery_state JSONB;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS recovery_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS rooms_recovery_expiry_idx ON rooms (recovery_expires_at) WHERE recovery_state IS NOT NULL;
