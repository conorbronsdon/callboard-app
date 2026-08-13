-- Sessions already composed before the informed-gate existed are treated as
-- informed. The gate applies to decisions made from here on; it is not
-- retroactive, because there is no way to know after the fact whether those
-- letters landed, and holding a live programme would be worse than the risk.
UPDATE sessions
SET speaker_informed_at = updated_at
WHERE speaker_informed_at IS NULL
  AND is_abstract = 0
  AND EXISTS (SELECT 1 FROM sessions a WHERE a.composed_into_session_id = sessions.id);
