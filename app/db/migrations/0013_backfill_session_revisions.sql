-- Backfill one current-content snapshot for sessions created before revision history.
-- Idempotent: any session that already has history remains unchanged.
INSERT INTO session_revisions (
  id,
  session_id,
  title,
  description,
  editor_person_id,
  editor_name,
  source,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  sessions.id,
  sessions.title,
  sessions.description,
  primary_person.id,
  CASE
    WHEN primary_person.id IS NULL THEN 'System'
    ELSE COALESCE(NULLIF(trim(primary_person.full_name), ''), primary_person.email)
  END,
  'system',
  sessions.created_at
FROM sessions
LEFT JOIN people AS primary_person
  ON primary_person.id = (
    SELECT participant.person_id
    FROM session_participants AS participant
    WHERE participant.session_id = sessions.id
      AND participant.is_primary = 1
    ORDER BY participant."order", participant.person_id
    LIMIT 1
  )
WHERE NOT EXISTS (
  SELECT 1
  FROM session_revisions AS revision
  WHERE revision.session_id = sessions.id
);
