# Submission evidence runbook

Callboard should be judged from the deployed product, with screenshots that
tell the end-to-end event-production story and links back to behavioral proof.

## Generate the evidence gallery

The capture script is read-only apart from creating demo-session cookies. It
does not submit forms, edit records, move sessions, send mail, or invoke jobs.

Local seeded server:

```sh
npm run migrate
npm run seed
npm run dev
node scripts/capture-submission-evidence.mjs http://localhost:5173
```

Deployed judge demo:

```sh
node scripts/capture-submission-evidence.mjs \
  <EXACT_DEMO_URL> \
  --allow-remote \
  --out artifacts/submission-evidence/final
```

Replace `<EXACT_DEMO_URL>` with the exact HTTPS `APP_URL` printed and
validated by the guarded demo deploy; do not reuse a remembered, production, or
previous-demo origin. Run `npm run smoke:demo -- <EXACT_DEMO_URL>` successfully
against that same origin before capture.

Remote capture is opt-in because screenshots can expose whatever data is on the
target deployment. Use only the disposable seeded judge environment. Never run
it against a real event without authorization and a content review.

The command produces:

- numbered PNGs in narrative order;
- `manifest.json` with route, viewport, status, title, and caption;
- `index.html`, a portable visual gallery suitable for review or submission
  preparation.

Nothing under `artifacts/` is committed yet — `git ls-files` returns no tracked
path there as of this commit. Run the deployed-judge-demo command above to
generate the gallery at `artifacts/submission-evidence/final/`, review every
image for private data, and commit it before judging begins (the path is not
`.gitignore`d). Regenerate any time with the same command.

## Requirement to screen map

The cold-judge routing table: each rubric area, the exact URLs that serve it, and
one thing to try. Every route below is registered in `app/routes.ts` and was
verified to exist in the commit this file ships in. Paths are relative to the deployed
origin. `<slug>` is the seeded event `frontier-ai-summit-2026` (a Europe sibling,
`frontier-ai-summit-europe-2026`, is seeded too so the event switcher has a
second row); `<cfp>` is the seeded CFP form id
`000000fo-0000-4000-8000-000000000001`. Organizer URLs require an admin session —
start at `/demo` and choose **Enter organizer workspace**; speaker URLs require
the seeded speaker session from the same page.

| Rubric area | Organizer URL(s) | Speaker / public URL(s) | What to try |
|---|---|---|---|
| CFP | `/admin/forms`, `/admin/forms/<formId>/<step>` | `/submit/<slug>/<cfp>`, `/submit/<slug>/<cfp>/step/<step>` | Open the seeded form's builder, add an eligible-track restriction, then submit against it publicly and watch the server reject a track the form does not accept. |
| Abstract Management | `/admin/submissions`, `/admin/submissions/<id>`, `/admin/reviews`, `/admin/submissions/scores.csv` | `/review` (assigned reviewer), `/portal/submissions/<sessionId>/edit` | Stage a few accepts and declines, commit the queue in one batch, then sort the list by score and pull the rubric-aware CSV. Open a submission's detail (`/admin/submissions/<id>`) to read the advisory AI triage card — a score and a queue recommendation with a model label that never changes the decision. |
| Speaker Management | `/admin/speakers`, `/admin/speakers/<id>`, `/admin/tasks`, `/admin/templates`, `/admin/comms`, `/admin/view-as` | `/portal`, `/portal/profile`, `/portal/tasks`, `/portal/resources` | Set a speaker's status and send a portal invite, then use **View as** to enter that speaker's portal and complete one of their required tasks. |
| Content Management | `/admin/resources`, `/admin/sessions/<id>`, `/admin/files`, `/admin/files/download`, `/admin/integrations`, `/admin/integrations/accelevents.csv`, `/admin/api-keys` | `/portal/resources/<slug>`, `/developers`, `/v1/openapi.json` | Publish a resource page and confirm the sanitized preview matches what the speaker portal renders; then export the Accelevents CSV pair and mint a scoped API key against `/v1/openapi.json`. Open the Files library (`/admin/files`) to see an upload's version chain and per-file comments and pull a bulk ZIP, and edit a session on `/admin/sessions/<id>` then restore the prior value from its attributed revision history. |
| AI Agenda | `/admin/agenda`, `/admin/agenda/rooms`, `/admin/agenda/tracks` | `/e/<slug>/schedule`, `/e/<slug>/schedule.ics` | The seed arrives with nine scheduled sessions across three rooms and **two accepted sessions still in the Unscheduled tray**, so **Auto-place remaining** is live on arrival — run it and watch both land without a clash. The seeded programme has zero conflicts on purpose, so drag a placed session on top of another to create the collision yourself, then open the Conflicts view to see it name both the room and the speaker. (Deterministic planner, not a model — see README Limitations.) |
| Public & Embeddable Widgets | `/admin/embeds` | `/e/<slug>`, `/e/<slug>/schedule`, `/e/<slug>/schedule/<sessionId>`, `/e/<slug>/speakers`, `/e/<slug>/speakers/<personId>`, `/embed/<slug>/schedule`, `/embed/<slug>/agenda`, `/embed/<slug>/speakers`, `/embed/<slug>/gallery` | Build a track-filtered dark-theme schedule widget, copy the iframe snippet, and open the `/embed/...` URL directly to see the chrome-less render; disable JavaScript and confirm the public schedule still filters. On `/e/<slug>/speakers` note the consent-gated headshots — a monogram shows for anyone who has not opted in — and click a speaker name on the schedule to jump to their public profile. |
| Speaker CRM | `/admin/contacts`, `/admin/contacts/<id>`, `/admin/pipeline`, `/admin/events/new` | — (organizer-only area) | Import contacts from CSV through the preview-then-commit path, merge a flagged duplicate, then filter to one company, save that filter as a named segment, and bulk-email the selection. Open the sourcing pipeline (`/admin/pipeline`) and drag a contact from **prospect** to **contacted** to see the kanban record the move. Use the event switcher in the admin header (it posts to `/admin/event`, which is an action, not a page) to confirm the directory spans every event while the rest of the admin scopes to one. |

Two judge-visible surfaces sit outside the seven areas and are worth a look:
`/demo` (the cold-judge entry point with both seeded roles) and `/admin` (the
programme-readiness dashboard that names blockers and next actions).

## Evidence matrix

| Story beat | Screenshot | Product claim | Behavioral evidence |
|---|---|---|---|
| Public event | `01-public-event-desktop.png` | Branded public entry point | Public smoke check |
| CFP | `02-cfp-welcome-mobile.png` | Mobile-first submission entry | Public-submit Playwright suite |
| Command centre | `03-command-centre-desktop.png` | Actionable event overview | Seeded dashboard tests |
| Form builder | `04-form-builder-desktop.png` | Configurable CFP workflow | Form round-trip and seeded CFP tests |
| Review workbench | `05-review-workbench-desktop.png` | Seeded decision pipeline | Seeded demo drill-in/status tests |
| Schedule planner | `06-schedule-planner-desktop.png` | Agenda and conflict workflow | Agenda unit + drag Playwright tests |
| Communications | `07-communications-desktop.png` | Templates and delivery history | Mail/ICS lifecycle tests |
| Integrations | `08-integrations-desktop.png` | Export/API/Airtable surfaces | CSV fixtures and API tests |
| Public programme | `09-public-programme-desktop.png` | Published schedule | Public schedule smoke check |
| Speaker portal | `10-speaker-portal-mobile.png` | Status and next action | Portal seeded-state tests |
| Speaker tasks | `11-speaker-tasks-mobile.png` | Onboarding completion | Portal task tests |
| Speaker resources | `12-speaker-resources-mobile.png` | Organizer guidance | Sanitization and portal tests |

## Human review checklist

- [ ] Every page has seeded data or an intentional, useful empty state.
- [ ] Titles and primary actions are visible without zooming.
- [ ] No internal IDs, field keys, stack terms, secrets, or private addresses are exposed.
- [ ] Status labels and counts agree across dashboard, review, agenda, and portal.
- [ ] Desktop pages do not clip controls; mobile pages do not scroll horizontally.
- [ ] Captions describe user outcomes and do not overclaim unverified behavior.
- [ ] The gallery is reviewed alongside DECISIONS.md, not as a substitute for it.
- [ ] The final selected images form a coherent story in the listed order.
