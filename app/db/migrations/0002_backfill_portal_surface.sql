-- Backfill portal forms created before forms.surface became the routing boundary.
-- Idempotent: already-correct rows remain unchanged.
UPDATE forms
SET surface = 'portal'
WHERE surface = 'cfp'
  AND json_valid(settings)
  AND json_extract(settings, '$.surface') = 'portal';
