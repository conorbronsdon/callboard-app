/**
 * `GET /llms.txt` — a concise, agent-facing description of Callboard.
 *
 * Public, unauthenticated, plain text. Every route and claim below must match
 * a real path in app/routes.ts / workers/app.ts — this file is read by agents
 * deciding whether and how to use the product, not marketing copy.
 */
import { API_KEY_HEADER, methodNotAllowed } from "~/lib/api/auth.server";

const LLMS_TXT = `# Callboard

Callboard is a conference operations tool: organizers run a call-for-proposals,
review and schedule sessions, and coordinate speakers; speakers track their own
submissions and onboarding tasks; attendees get a public event page and
schedule. It is built on React Router and deployed as a Cloudflare Worker.

## Public routes
- / — public home
- /e/:slug — public event page
- /e/:slug/schedule — public published schedule
- /speakers is not a top-level route; per-event speaker directories live at
  /e/:slug/speakers and /e/:slug/speakers/:personId
- /submit/:eventSlug/:formId — public call-for-proposals submission wizard

## Try it live
- /demo — one-click seeded sign-in as an organizer or a speaker, no account
  needed. Walks the full lifecycle: CFP intake, review, scheduling, speaker
  onboarding, and the public schedule the work produces.

## Public API (/v1)
Event-scoped JSON API, documented at /v1/openapi.json (unauthenticated) and
described for humans at /developers. Every other /v1 route requires an API
key minted for one event, sent as the \`${API_KEY_HEADER}\` header
(\`Authorization: Bearer <key>\` also works). Keys carry non-cascading scopes
(read:events, read:sessions, write:sessions, read:contacts, read:metadata,
write:metadata); a request without the required scope is rejected. Endpoints
cover events, sessions (list, search, create, bulk create, get/update,
restore), speakers (list, search, get/update), and shared metadata families
(tracks, rooms, tags, formats, levels).
`;

export async function loader() {
  return new Response(LLMS_TXT, {
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
