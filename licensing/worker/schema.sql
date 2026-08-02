PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issuers (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  roles_json TEXT NOT NULL DEFAULT '["invite.issue","invite.revoke"]',
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT REFERENCES issuers(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS issuer_challenges (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES issuers(id),
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issuer_challenges_lookup
  ON issuer_challenges(issuer_id, expires_at, used_at);

CREATE TABLE IF NOT EXISTS invite_batches (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES issuers(id),
  invitation_count INTEGER NOT NULL CHECK (invitation_count = 10),
  edition TEXT NOT NULL,
  license_days INTEGER NOT NULL,
  customer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES invite_batches(id),
  issuer_id TEXT NOT NULL REFERENCES issuers(id),
  code_hash TEXT NOT NULL UNIQUE,
  last_four TEXT NOT NULL CHECK (length(last_four) = 4),
  status TEXT NOT NULL CHECK (status IN ('unused', 'activated', 'expired', 'revoked')),
  edition TEXT NOT NULL,
  license_days INTEGER NOT NULL,
  customer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT,
  activation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_issuer_status
  ON invites(issuer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES invites(id),
  license_id TEXT NOT NULL UNIQUE,
  device_key_hash TEXT NOT NULL,
  entitlement_hash TEXT NOT NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  activation_key_hash TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_credentials (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  replaced_by TEXT REFERENCES recovery_credentials(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_recovery_credentials_active
  ON recovery_credentials(holder, status);
