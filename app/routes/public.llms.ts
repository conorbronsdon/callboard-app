/**
 * `GET /e/:slug/llms.txt` — the event-scoped agent map.
 *
 * Same audience and intent as the platform `/llms.txt` (a cold agent, one
 * visit) but narrowed to ONE event: its public pages, its open calls, its
 * calendar feed, and the API pointers scoped to it with `event.id`. It is not
 * a shrunk copy of the platform file — an agent that already has an event
 * slug does not need the six-stop judge tour again, and this file names paths
 * the platform one cannot (a concrete session id per published session, a
 * concrete form id per open call).
 *
 * Same invariant, same test idiom, factored into `~/test/route-manifest` so
 * the two routes cannot drift apart: every path named below must resolve
 * against `app/routes.ts` segment-wise, pinned by `public.llms.test.ts`, so
 * renaming a route breaks the test instead of shipping an agent a dead link.
 * Demo-mode lines are gated by the same `isDemoMode()` the platform file uses.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events, forms, sessions } from "~/db/schema";
import { API_KEY_HEADER, methodNotAllowed } from "~/lib/api/auth.server";
import { isDemoMode } from "~/lib/env.server";
import type { Route } from "./+types/public.llms";

/** Same ceiling `public.calendar.ts` and the schedule page use for one event's programme. */
const MAX_SESSIONS_LISTED = 500;

interface EventDoc {
  id: string;
  name: string;
  slug: string;
}

interface OpenFormDoc {
  id: string;
  name: string;
  target: string;
}

interface PublishedSessionDoc {
  id: string;
  title: string;
}

function LLMS_TXT(
  event: EventDoc,
  openForms: readonly OpenFormDoc[],
  publishedSessions: readonly PublishedSessionDoc[],
): string {
  const base = `/e/${event.slug}`;

  const sessionLines = publishedSessions.length
    ? publishedSessions.map((session) => `- ${base}/schedule/${session.id} — ${session.title}`).join("\n") +
      (publishedSessions.length >= MAX_SESSIONS_LISTED
        ? `\n\nThis list is capped at ${MAX_SESSIONS_LISTED}. The full programme, always complete: ${base}/schedule and ${base}/schedule.ics`
        : "")
    : `Nothing is published on the schedule yet.`;

  const formLines = openForms.length
    ? openForms
        .map(
          (form) =>
            `- /submit/${event.slug}/${form.id} — ${form.name} (${
              form.target === "submission" ? "abstract" : "guaranteed slot"
            })`,
        )
        .join("\n")
    : `No call for proposals is open on this event right now.`;

  return `# ${event.name}

Event-scoped agent map for Callboard, covering ONE event (${event.slug}): its
public pages, its open calls, its calendar feed, and the API pointers scoped
to it. For the whole platform — organizer, reviewer, and speaker surfaces,
plus the judge path — see /llms.txt.

## Public pages

- ${base} — event overview: dates, venue, open calls.
- ${base}/schedule — the published schedule, with search, day tabs, and
  track/format/room facets. Calendar feed: ${base}/schedule.ics
- ${base}/speakers — the speaker directory for this event.

## Published sessions

${sessionLines}

## Call for proposals

${formLines}

## API — scoped to this event

- Auth: an event-scoped key minted at /admin/api-keys, sent as the
  \`${API_KEY_HEADER}\` header (\`Authorization: Bearer <key>\` also works).
  Full scope list, envelope, and error shape: /developers and
  /v1/openapi.json.
- /v1/event/${event.id}/sessions — list, search, create, bulk create, get,
  update, restore
- /v1/event/${event.id}/speakers — list, search, get (read-only, no update)
- /v1/event/${event.id}/tracks — one of the shared metadata families; the
  same event-scoped pattern also covers rooms, tags, formats, and levels
${
  isDemoMode()
    ? `
## Demo-mode notes for agents

- This deployment is in demo mode. Magic links are revealed on screen instead
  of emailed — submit any seeded address at /login and the sign-in link
  prints in the response. One-click role sign-in: /demo.
- No real mail leaves this deployment; every send is written to the Worker log.
- The data is disposable and periodically reset to the seed. Do not upload
  private material.
`
    : ""
}`;
}

export async function loader({ params }: Route.LoaderArgs) {
  const db = getDb();
  const event = await db.query.events.findFirst({ where: eq(events.slug, params.slug) });
  if (!event) throw new Response("Event not found", { status: 404 });

  const [openForms, publishedSessions] = await Promise.all([
    db.query.forms.findMany({
      where: and(eq(forms.eventId, event.id), eq(forms.surface, "cfp"), eq(forms.status, "open")),
      orderBy: asc(forms.createdAt),
    }),
    // Same predicate the public schedule and its .ics feed use, so this file
    // never names a session those pages would not also show.
    db
      .select({ id: sessions.id, title: sessions.title })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          eq(sessions.isPublic, true),
          isNotNull(sessions.startsAt),
          isNull(sessions.deletedAt),
        ),
      )
      .orderBy(asc(sessions.startsAt), asc(sessions.title))
      .limit(MAX_SESSIONS_LISTED),
  ]);

  const body = LLMS_TXT(
    { id: event.id, name: event.name, slug: event.slug },
    openForms.map((form) => ({ id: form.id, name: form.name, target: form.target })),
    publishedSessions,
  );

  return new Response(body, {
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
