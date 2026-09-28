-- 0003: track daily progress-query counts per anonymous actor.
ALTER TABLE daily_quota ADD COLUMN queries INTEGER NOT NULL DEFAULT 0;
