-- WS1b end-to-end fixtures. Applied on top of `npm run seed` by
-- tests/e2e/setup.mjs; idempotent (fixed ids + INSERT OR REPLACE).
--
-- Schemas are in WS1a's FormSchema shape (app/lib/form-schema.ts).
--
-- These four cover the states the DEMO seed deliberately does not: a form past
-- its close date, a form with no questions at all, a one-submission cap, and a
-- role minimum above 1. Conditional logic, the cross-field limit and category
-- routing now ship ON the seeded CFP form and are walked against seed data by
-- `tests/e2e/seeded-demo.spec.ts` — the point being that a judge sees them with
-- no fixtures installed.

PRAGMA defer_foreign_keys = true;

-- Reset anything a previous run created, so "from a clean DB" is literally true.
DELETE FROM sessions WHERE form_id LIKE 'ws1btst%';
DELETE FROM people   WHERE email LIKE 'ws1b-e2e%@example.com';

-- 1. Conditional + combined-limit CFP.
--    · `takeaways` appears only when Format = Workshop        (conditional logic)
--    · title + takeaways share a 120-character budget          (cross-field limit)
--    · Speaker min 2 / max 4 drives "Speaker: 2–4 required · 1 added"
--    · Workshop routes to the workshop committee               (category routing)
--    · 2 submissions per user
INSERT OR REPLACE INTO forms (
  "id", "event_id", "name", "target", "status",
  "welcome_title", "welcome_body", "thank_you_body",
  "schema", "settings",
  "min_speakers", "max_speakers", "max_participants_total",
  "closes_at", "submission_limit", "allow_multiple_drafts",
  "created_at", "updated_at"
) VALUES (
  'ws1btst-0000-4000-8000-000000000001',
  '000000ev-0000-4000-8000-000000000001',
  'WS1b conditional CFP',
  'submission',
  'open',
  'Speak at the Frontier AI Summit',
  'Talks are 30 minutes. Workshops are 90 and need audience takeaways.',
  'Thanks — we review in two rounds and reply to everyone.',
  '{"version":1,
    "fields":[
      {"fieldId":"000000fd-0000-4000-8000-000000000001","key":"title","type":"text","label":"Session title","scope":"submission","order":0,"required":true,"validation":{"required":true,"maxLength":120}},
      {"fieldId":"000000fd-0000-4000-8000-000000000004","key":"format","type":"select","label":"Format","scope":"submission","order":1,"required":true,"validation":{"required":true,"options":["Talk","Workshop","Lightning"]}},
      {"fieldId":"000000fd-0000-4000-8000-000000000005","key":"takeaways","type":"textarea","label":"Audience takeaways","scope":"submission","order":2,"required":true,"validation":{"required":true,"minLength":20,"maxLength":400}},
      {"fieldId":"000000fd-0000-4000-8000-000000000006","key":"video_url","type":"video_url","label":"Video pitch (optional)","scope":"submission","order":3,"required":false,"validation":{}}
    ],
    "rules":[
      {"id":"show-takeaways","label":"Workshops explain their takeaways","match":"all","when":[{"fieldKey":"format","op":"equals","value":"Workshop"}],"action":"show","targetKeys":["takeaways"],"scope":"submission","enabled":true}
    ],
    "combinedLimits":[
      {"id":"programme","label":"Printed programme block","fieldKeys":["title","takeaways"],"maxChars":120,"scope":"submission","enabled":true}
    ],
    "routing":{"rules":[{"id":"route-workshop","match":"all","when":[{"fieldKey":"format","op":"equals","value":"Workshop"}],"trackId":"000000tr-0000-4000-8000-000000000002","reviewTeamKey":"workshop-committee","order":0,"enabled":true}],"defaultTrackId":"000000tr-0000-4000-8000-000000000001"},
    "participants":{"collect":true,"roles":[{"key":"speaker","label":"Speaker","enabled":true,"min":2,"max":4},{"key":"moderator","label":"Moderator","enabled":true,"min":0,"max":1}],"maxTotal":4,"minTotal":null}
   }',
  '{"welcome":{"title":"Speak at the Frontier AI Summit","heading":"Welcome!","body":""},
    "abstract":{"title":"Tell us about your submission","heading":"Submission","body":"What do you want to present?"},
    "participant":{"title":"Tell us about you","heading":"Participant","body":"Give us your details and your credentials for presenting."},
    "autoRedirectToPortal":true,
    "successMessage":"You will receive a confirmation email shortly with a link to your speaker portal.",
    "notifications":{"confirmationEmail":{"enabled":true,"subject":"We got your submission to {{event_name}}","body":"We review over the next few weeks and then notify you."}}
   }',
  2, 4, 4,
  1798761540000,   -- 2026-12-31T23:59Z, comfortably in the future
  2, 1,
  1786000000000, 1786000000000
);

-- 2. Past its close date. Everything else valid, so the closed page is the only
--    reason it cannot be used.
INSERT OR REPLACE INTO forms (
  "id", "event_id", "name", "target", "status",
  "welcome_title", "welcome_body",
  "schema", "settings", "min_speakers", "allow_multiple_drafts",
  "closes_at", "created_at", "updated_at"
) VALUES (
  'ws1btst-0000-4000-8000-000000000002',
  '000000ev-0000-4000-8000-000000000001',
  'WS1b closed CFP',
  'submission',
  'open',
  'This one already closed',
  'You are too late for this call.',
  '{"version":1,"fields":[{"fieldId":"000000fd-0000-4000-8000-000000000001","key":"title","type":"text","label":"Session title","scope":"submission","order":0,"required":true,"validation":{"required":true}}],"rules":[],"combinedLimits":[],"routing":{"rules":[],"defaultTrackId":null},"participants":{"collect":true,"roles":[{"key":"speaker","label":"Speaker","enabled":true,"min":1,"max":null}],"maxTotal":null,"minTotal":null}}',
  '{}', 1, 1,
  1735689600000,   -- 2025-01-01, in the past
  1786000000000, 1786000000000
);

-- 3. Zero state: an open form with no questions, no rules and no limits.
INSERT OR REPLACE INTO forms (
  "id", "event_id", "name", "target", "status",
  "welcome_title", "welcome_body",
  "schema", "settings", "min_speakers", "max_speakers", "allow_multiple_drafts",
  "created_at", "updated_at"
) VALUES (
  'ws1btst-0000-4000-8000-000000000003',
  '000000ev-0000-4000-8000-000000000001',
  'WS1b empty CFP',
  'submission',
  'open',
  'Nothing to fill in yet',
  'This form has no questions configured.',
  '{}',
  '{}', 1, 1, 1,
  1786000000000, 1786000000000
);

-- 4. A one-submission-per-user form, for the limit-reached path. No questions,
--    one speaker: fast to walk twice.
INSERT OR REPLACE INTO forms (
  "id", "event_id", "name", "target", "status",
  "welcome_title", "welcome_body",
  "schema", "settings", "min_speakers", "max_speakers",
  "submission_limit", "allow_multiple_drafts",
  "created_at", "updated_at"
) VALUES (
  'ws1btst-0000-4000-8000-000000000004',
  '000000ev-0000-4000-8000-000000000001',
  'WS1b one-shot CFP',
  'submission',
  'open',
  'One submission each',
  'You may submit once.',
  '{}',
  '{}', 1, 1,
  1, 1,
  1786000000000, 1786000000000
);
