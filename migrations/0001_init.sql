CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','REMOVED')),
  submitted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_pool ON invites(platform,status,created_at);
CREATE INDEX IF NOT EXISTS idx_invites_submitter ON invites(submitted_by,created_at);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  invite_id INTEGER NOT NULL REFERENCES invites(id),
  actor_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  feedback TEXT CHECK (feedback IN ('success','failure')),
  feedback_at INTEGER,
  UNIQUE(invite_id,actor_hash)
);
CREATE INDEX IF NOT EXISTS idx_claims_actor_time ON claims(actor_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_claims_invite ON claims(invite_id);
