-- Preserve existing data. Old entries have no owner key and are not publicly claimable as owned.
ALTER TABLE invites ADD COLUMN owner_key_hash TEXT;
ALTER TABLE invites ADD COLUMN claim_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN milestone_at INTEGER;
ALTER TABLE invites ADD COLUMN snapshot_at INTEGER;
ALTER TABLE invites ADD COLUMN snapshot_copies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN snapshot_successes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN snapshot_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN snapshot_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN copied_at INTEGER;

UPDATE invites SET claim_count=(SELECT COUNT(*) FROM claims WHERE invite_id=invites.id);
CREATE INDEX idx_invites_ready ON invites(platform,status,milestone_at,claim_count);
CREATE INDEX idx_invites_expiry ON invites(milestone_at) WHERE milestone_at IS NOT NULL;
CREATE TABLE relay_totals (
  id INTEGER PRIMARY KEY CHECK(id=1),
  copies INTEGER NOT NULL DEFAULT 0,
  milestones INTEGER NOT NULL DEFAULT 0,
  positive_reports INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0
);
INSERT INTO relay_totals(id,positive_reports,submissions,draws)
  SELECT 1,COALESCE(SUM(success_count),0),COUNT(*),(SELECT COUNT(*) FROM claims) FROM invites;
-- Anonymous counters keep their meaning after all records for a code are deleted.
CREATE TABLE relay_daily(day INTEGER PRIMARY KEY,submissions INTEGER NOT NULL DEFAULT 0,draws INTEGER NOT NULL DEFAULT 0);
INSERT INTO relay_daily(day,submissions) SELECT (created_at/86400000)*86400000,COUNT(*) FROM invites GROUP BY 1;
INSERT INTO relay_daily(day,draws) SELECT (created_at/86400000)*86400000,COUNT(*) FROM claims WHERE 1 GROUP BY 1
  ON CONFLICT(day) DO UPDATE SET draws=excluded.draws;
-- These short-lived rate counters have no code IDs or receipts. Cleared the next UTC day.
CREATE TABLE daily_quota(actor_hash TEXT NOT NULL,day INTEGER NOT NULL,draws INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(actor_hash,day));
INSERT INTO daily_quota(actor_hash,day,submissions)
  SELECT submitted_by,(created_at/86400000)*86400000,COUNT(*) FROM invites GROUP BY 1,2;
INSERT INTO daily_quota(actor_hash,day,draws)
  SELECT actor_hash,(created_at/86400000)*86400000,COUNT(*) FROM claims WHERE 1 GROUP BY 1,2
  ON CONFLICT(actor_hash,day) DO UPDATE SET draws=excluded.draws;

CREATE TRIGGER count_share AFTER INSERT ON invites
BEGIN
  UPDATE relay_totals SET submissions=submissions+1 WHERE id=1;
  INSERT INTO relay_daily(day,submissions) VALUES((NEW.created_at/86400000)*86400000,1)
    ON CONFLICT(day) DO UPDATE SET submissions=submissions+1;
  INSERT INTO daily_quota(actor_hash,day,submissions) VALUES(NEW.submitted_by,(NEW.created_at/86400000)*86400000,1)
    ON CONFLICT(actor_hash,day) DO UPDATE SET submissions=submissions+1;
END;

CREATE TRIGGER count_claim AFTER INSERT ON claims
BEGIN
  UPDATE invites SET claim_count=claim_count+1 WHERE id=NEW.invite_id;
  UPDATE relay_totals SET draws=draws+1 WHERE id=1;
  INSERT INTO relay_daily(day,draws) VALUES((NEW.created_at/86400000)*86400000,1)
    ON CONFLICT(day) DO UPDATE SET draws=draws+1;
  INSERT INTO daily_quota(actor_hash,day,draws) VALUES(NEW.actor_hash,(NEW.created_at/86400000)*86400000,1)
    ON CONFLICT(actor_hash,day) DO UPDATE SET draws=draws+1;
END;

-- Delete child rows before the parent's FK check; all code-related detail is removed atomically.
CREATE TRIGGER purge_invite BEFORE DELETE ON invites
BEGIN
  DELETE FROM claims WHERE invite_id=OLD.id;
END;

-- A receipt may transition to copied only once. Counters and the final snapshot
-- commit together with that transition, including concurrent requests.
CREATE TRIGGER count_copy AFTER UPDATE OF copied_at ON claims
WHEN OLD.copied_at IS NULL AND NEW.copied_at IS NOT NULL
BEGIN
  UPDATE invites SET copy_count=copy_count+1 WHERE id=NEW.invite_id;
  UPDATE relay_totals SET copies=copies+1 WHERE id=1;
  UPDATE relay_totals SET milestones=milestones+1
    WHERE id=1 AND EXISTS(SELECT 1 FROM invites WHERE id=NEW.invite_id AND copy_count=30 AND milestone_at IS NULL);
  UPDATE invites SET milestone_at=NEW.copied_at,
    snapshot_at=NEW.copied_at,snapshot_copies=copy_count,
    snapshot_successes=success_count,snapshot_failures=failure_count,snapshot_final=1
    WHERE id=NEW.invite_id AND copy_count=30 AND milestone_at IS NULL;
END;

-- Feedback counters must not diverge if a request fails between two queries.
CREATE TRIGGER count_feedback AFTER UPDATE OF feedback ON claims
WHEN OLD.feedback IS NULL AND NEW.feedback IS NOT NULL
BEGIN
  UPDATE invites SET success_count=success_count+(NEW.feedback='success'),
    failure_count=failure_count+(NEW.feedback='failure'),last_verified_at=NEW.feedback_at,
    status=CASE WHEN status='ACTIVE' AND failure_count+(NEW.feedback='failure')>=2 THEN 'PAUSED' ELSE status END
    WHERE id=NEW.invite_id;
  UPDATE relay_totals SET positive_reports=positive_reports+(NEW.feedback='success') WHERE id=1;
END;
