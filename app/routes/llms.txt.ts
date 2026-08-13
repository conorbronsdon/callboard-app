/**
 * `GET /llms.txt` — the agent-facing landing strip for Callboard.
 *
 * Written for a COLD agent with ONE visit: what this is, the walkable judge
 * path in order, where each brief feature lives, the API strip, and the
 * demo-mode facts an agent needs to actually get in. It is not a route index
 * and not marketing copy.
 *
 * Two invariants, both pinned by llms.txt.test.ts:
 *
 *   1. Every path named below must resolve against `app/routes.ts`. The test
 *      extracts the paths from this body and matches each one segment-wise
 *      against the route manifest, so renaming a route breaks the test rather
 *      than shipping an agent a dead URL.
 *   2. The demo lines are conditional because `/demo` 404s outside demo mode
 *      and the magic-link reveal never happens in production. The public and
 *      API strips render everywhere. The test covers both directions.
 *
 * The demo slug and the two button labels are IMPORTED, not retyped: a judge
 * told to click "Enter organizer workspace" has to find that exact string on
 * the page, and app/lib/demo.ts is what the page renders from.
 */
import { API_KEY_HEADER, methodNotAllowed } from "~/lib/api/auth.server";
import { DEMO_ACCOUNTS, DEMO_EVENT_SLUG } from "~/lib/demo";
import { isDemoMode } from "~/lib/env.server";

function LLMS_TXT() {
  return `# Callboard

Callboard is conference operations software. Organizers run a call-for-proposals,
review and score submissions, build the agenda, and coordinate speakers; speakers
manage their own profile, materials, and onboarding tasks; the public gets an
event page, a schedule, and a speaker directory. It is one Cloudflare Worker:
React Router framework mode, D1 for data, R2 for files.

## The judge path — walk these in order

${
  isDemoMode()
    ? `- /demo — START HERE. One-click seeded sign-in: no account, no password.
  Two buttons: "${DEMO_ACCOUNTS.admin.label}" and "${DEMO_ACCOUNTS.speaker.label}".
  Take the organizer first; the organizer-side steps below assume that session.
- /e/${DEMO_EVENT_SLUG} — the seeded event on this deployment. Substitute
  that slug for :slug in every public path below.
`
    : ""
}- /e/:slug — public event page: dates, venue, calls that are open.
- /e/:slug/schedule — the published schedule, with search, day tabs, and
  track/format/room facets. Calendar feed: /e/:slug/schedule.ics
- /e/:slug/schedule/:sessionId — one session: abstract, time, room, speakers.
- /e/:slug/speakers/:personId — one speaker's public profile. Full directory:
  /e/:slug/speakers
- /submit/:eventSlug/:formId — the public CFP wizard, entry step. This is the
  shareable link an organizer hands to prospective speakers.
- /admin — organizer dashboard: programme readiness, explicit blockers, and the
  next actions across submissions, speakers, tasks, schedule, and publication.
- /admin/submissions — the seven-state decision pipeline. Stage accept and
  decline queues here and commit them in bulk; open /admin/submissions/:id to
  read one abstract and run the advisory AI first-pass triage on it.
- /review — the reviewer workspace: assigned abstracts only, weighted scoring
  across rounds, outside the organizer chrome.
- /admin/agenda — the agenda day board: drag and drop with room and speaker
  conflict detection, plus list, week, track, and room views.
- /admin/contacts — the speaker CRM, spanning every event on the deployment.
  Sourcing pipeline board: /admin/pipeline
- /admin/embeds — the embed builder: four chrome-less widgets emitted as an
  iframe snippet, a link, or a calendar feed.
- /admin/files — every upload for the event, grouped into version chains, with
  a bulk ZIP download.
- /portal — the speaker portal: profile, headshot and material uploads, tasks,
  and event resources.

## Where each feature in the brief lives

- Custom CFP forms, conditional logic, category routing — /admin/forms
- Self-service speaker portal for bios, headshots, documents — /portal
- Templated communications, reminders, calendar invites — /admin/templates
  (delivery log: /admin/comms)
- Submission evaluation and scoring, optional AI-assisted review — /admin/reviews
- Drag-and-drop agenda building with conflict detection — /admin/agenda
- Dashboard of speakers with outstanding onboarding tasks — /admin/tasks
- One-way Accelevents integration — /admin/integrations
- Resource and wiki pages inside the speaker portal — /admin/resources
- Embeddable speaker gallery and schedule — /admin/embeds

## API

- /developers — the human-readable guide, with copy-paste curl per endpoint.
- /v1/openapi.json — OpenAPI 3.1 document, unauthenticated, machine-readable.
- Auth: every other API endpoint requires a key scoped to ONE event, minted at
  /admin/api-keys and sent as the \`${API_KEY_HEADER}\` header
  (\`Authorization: Bearer <key>\` also works). Scopes do not cascade —
  read:events, read:sessions, write:sessions, read:contacts, read:metadata,
  write:metadata — and a request missing the required scope is rejected.
- Coverage: events; sessions (list, search, create, bulk create, get, update,
  restore); speakers (list, search, get, update); and the shared metadata
  families tracks, rooms, tags, formats, and levels.
${
  isDemoMode()
    ? `
## Demo-mode notes for agents

- This deployment is in demo mode, so /demo mints a seeded session for either
  role instantly. That route returns 404 on a production deployment.
- Magic links are revealed on screen. Submit any seeded address at /login and
  the sign-in link is printed in the response instead of being emailed, so no
  mailbox is required. Production never does this.
- No real mail leaves this deployment; every send is written to the Worker log.
- The data is disposable and deterministic. It is periodically reset to the
  seed, so anything created here is temporary. Do not upload private material.
`
    : ""
}`;
}

export async function loader() {
  return new Response(LLMS_TXT(), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export async function action() {
  return methodNotAllowed(["GET"]);
}
