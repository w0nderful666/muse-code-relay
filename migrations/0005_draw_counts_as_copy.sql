-- Drawing a code now counts as a copy immediately: the claim row is created with
-- copied_at set, so right-click/manual copies are never undercounted.
-- The copy button becomes "confirm copy": only after the user really clicks it
-- is feedback unlocked (confirmed_at), so votes come from people who took the code.
ALTER TABLE claims ADD COLUMN confirmed_at INTEGER;

DROP TRIGGER IF EXISTS count_copy;
CREATE TRIGGER count_copy AFTER INSERT ON claims
WHEN NEW.copied_at IS NOT NULL
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
