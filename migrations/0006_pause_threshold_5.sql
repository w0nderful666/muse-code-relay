-- Raise the auto-pause threshold from 3 to 5 "does not work" reports.
-- The first four reports only shave a small amount off the draw score now;
-- the fifth pauses the code. Pause is reversible; it never deletes data.
DROP TRIGGER IF EXISTS count_feedback;
CREATE TRIGGER count_feedback AFTER UPDATE OF feedback ON claims
WHEN OLD.feedback IS NULL AND NEW.feedback IS NOT NULL
BEGIN
  UPDATE invites SET success_count=success_count+(NEW.feedback='success'),
    failure_count=failure_count+(NEW.feedback='failure'),last_verified_at=NEW.feedback_at,
    status=CASE WHEN status='ACTIVE' AND failure_count+(NEW.feedback='failure')>=5 THEN 'PAUSED' ELSE status END
    WHERE id=NEW.invite_id;
  UPDATE relay_totals SET positive_reports=positive_reports+(NEW.feedback='success') WHERE id=1;
END;
