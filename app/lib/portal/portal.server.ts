/**
 * Shared loaders for the portal routes: "who is looking, at which event, with
 * what submissions and tasks". Every portal page needs some subset of this, and
 * writing the joins once keeps the numbers on Home identical to the numbers on
 * Tasks — a dashboard that disagrees with the page it links to reads as a bug.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import {
  eventPeople,
  events,
  formats,
  sessionParticipants,
  sessions,
  tasks,
  type Event,
} from "~/db/schema";
import { currentEvent } from "~/lib/event.server";
import {
  speakerVisibleStatus,
  type SpeakerSubmissionSummary,
  type TaskSummary,
} from "~/lib/portal-progress";
import { FORMAT_ANSWER_KEYS, readNamedOptionAnswer } from "~/lib/public-submit/normalize";
import { requirePortalActor, type PortalActor } from "./impersonation.server";

export interface PortalContext {
  actor: PortalActor;
  event: Event;
}

/**
 * Every event this person is actually attached to, newest membership first.
 *
 * `event_people` is the only record of "this speaker belongs to that event",
 * and `event_people_person_idx` (app/db/schema.ts) is the index this reads
 * through. Ordering is by the MEMBERSHIP's `createdAt`, not the event's: a
 * speaker added late to an old event is looking at the thing they were just
 * invited to, not at whichever event happens to be oldest.
 */
async function speakerEvents(personId: string): Promise<Event[]> {
  const rows = await getDb()
    .select({ event: events })
    .from(eventPeople)
    .innerJoin(events, eq(events.id, eventPeople.eventId))
    .where(eq(eventPeople.personId, personId))
    .orderBy(desc(eventPeople.createdAt))
    .limit(20);
  return rows.map((row) => row.event);
}

/**
 * Which event is this portal showing?
 *
 * An impersonating admin gets the event bound into the view-as cookie when the
 * preview started. That binding is what makes the selection survive a tab
 * click: `/portal/*` never sees the organizer's `Path=/admin` selection cookie,
 * and a `?event=` on the landing URL is dropped by the first navigation, so
 * anything carried in the URL resolves the DEFAULT event one click later.
 *
 * ── Issue #86: the same defect, without the impersonation ────────────────────
 * Binding the cookie fixed view-as and left the wider case open. A REAL speaker
 * signing in has no binding at all, so resolution fell through to
 * `currentEvent(request)` — which, off `/admin`, ignores the selection cookie
 * and returns the OLDEST event. A speaker whose only membership is the second
 * event therefore landed on the first one and saw a confident, completely empty
 * portal: every portal query is `personId AND eventId`, and one of those two was
 * wrong.
 *
 * The speaker's own memberships are the authority now, because they are the
 * only input that is actually about this person:
 *
 *   1. an honoured impersonation binding, unchanged — the organizer chose it;
 *   2. exactly one membership → that event, whatever the URL or the default
 *      says. A single-event speaker has no other correct answer, so an inbound
 *      `?event=` pointing elsewhere would only ever produce the empty portal
 *      this exists to remove;
 *   3. several memberships → the request's event when it is one of THEIRS
 *      (so `?event=` still steers a multi-event speaker), otherwise their
 *      newest membership;
 *   4. no membership at all → `currentEvent(request)`, exactly as before. That
 *      is the brand-new account mid-CFP-signup, whose `event_people` row does
 *      not exist yet.
 *
 * Neither the memberships nor the request event carry authority: this picks
 * WHICH event a portal renders, never WHETHER the person may see it. Scoping is
 * still `loadSubmissions` / `loadTasks` filtering on the actor's own id.
 */
export async function portalContext(request: Request): Promise<PortalContext> {
  const [actor, requestEvent] = await Promise.all([
    requirePortalActor(request),
    currentEvent(request),
  ]);

  const bound = actor.boundEventId
    ? ((await getDb().query.events.findFirst({ where: eq(events.id, actor.boundEventId) })) ?? null)
    : null;

  let event = bound;
  if (!event) {
    const memberships = await speakerEvents(actor.person.id);
    if (memberships.length === 1) {
      event = memberships[0];
    } else if (memberships.length > 1) {
      event =
        memberships.find((candidate) => candidate.id === requestEvent?.id) ?? memberships[0];
    } else {
      event = requestEvent;
    }
  }

  if (!event) throw new Response("No event has been set up yet.", { status: 404 });
  return { actor, event };
}

/**
 * The portal context for a page whose URL names ONE record.
 *
 * ── Why ambient resolution is the wrong input here ───────────────────────────
 * `portalContext` answers "which event is this portal showing?" — a question
 * about a person browsing. `/portal/tasks/:taskId` is not that question: the URL
 * already names the thing to render, and the record knows which event it is in.
 *
 * Every portal list links to these pages WITHOUT an `?event=` (portal.index.tsx,
 * portal.tasks.tsx, portal.submissions.tsx, and `nextAction` in
 * portal-progress.ts), which is what turned the mismatch into a 404 on every
 * link rather than an occasional one. A multi-event speaker browsing under
 * `?event=B` gets event B's rows in the list; the link drops the param; the
 * detail request re-resolves the DEFAULT event A one click later; and a lookup
 * filtered `taskId AND personId AND eventId=A` finds nothing. SPK-09 / CNT-02.
 *
 * ── What decides instead ─────────────────────────────────────────────────────
 * `findEventId` looks the record up BY ID AND OWNER and hands back the event it
 * actually lives in. That is the same move as the #86 fix — prefer the input
 * that is genuinely about this request — one level further in: there, the
 * speaker's memberships beat the URL; here, the named record beats both.
 *
 * ── The event id is a pointer, never a permission ────────────────────────────
 * Two separate checks, and neither is the other's job:
 *   - `findEventId` filters on the OWNER, so a record belonging to someone else
 *     is not found and this 404s before an event is ever resolved. That filter
 *     is what authorises; the event id never was.
 *   - the membership re-check below then refuses an event the speaker no longer
 *     belongs to, so "trust the record's event" cannot hand a removed speaker
 *     their old event's rows back.
 *
 * 404, not 403, throughout: confirming that a record id exists is itself a leak
 * (`requireOwnTask` gives the same reasoning).
 */
export async function portalRecordContext(
  request: Request,
  findEventId: (personId: string) => Promise<string | null | undefined>,
): Promise<PortalContext> {
  const actor = await requirePortalActor(request);
  const notFound = () => new Response("Not found.", { status: 404 });

  const eventId = await findEventId(actor.person.id);
  if (!eventId) throw notFound();

  const [membership] = await getDb()
    .select({ eventId: eventPeople.eventId })
    .from(eventPeople)
    .where(and(eq(eventPeople.eventId, eventId), eq(eventPeople.personId, actor.person.id)))
    .limit(1);
  if (!membership) throw notFound();

  const event = await getDb().query.events.findFirst({ where: eq(events.id, eventId) });
  if (!event) throw notFound();

  return { actor, event };
}

/**
 * The speaker's own submissions (abstracts they participate in).
 *
 * Program sessions composed FROM an accepted abstract are excluded — showing
 * both would double-count one talk on the acceptance card, which is the number
 * the walkthrough says must be front and centre.
 *
 * **The status is projected before it leaves this function.** Every caller is a
 * portal loader and `ssr: true` serialises loader data into the document, so
 * the raw `accept_queue` / `decline_queue` was readable in view-source no matter
 * what the pill rendered. Projecting here rather than in each route means a new
 * portal page cannot reintroduce the leak by forgetting to mask, and the return
 * type refuses a raw row outright. A route that needs the raw status for a
 * SERVER-SIDE decision — the edit lock is the only one — reads it from its own
 * query and must not put it in the payload.
 */
export async function loadSubmissions(
  personId: string,
  eventId: string,
): Promise<SpeakerSubmissionSummary[]> {
  const rows = await getDb()
    .select({
      id: sessions.id,
      friendlyId: sessions.friendlyId,
      title: sessions.title,
      status: sessions.status,
      format: formats.name,
      answers: sessions.answers,
      isPrimary: sessionParticipants.isPrimary,
    })
    .from(sessionParticipants)
    .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
    .leftJoin(formats, eq(formats.id, sessions.formatId))
    .where(
      and(
        eq(sessionParticipants.personId, personId),
        eq(sessions.eventId, eventId),
        eq(sessions.isAbstract, true),
        isNull(sessions.deletedAt),
      ),
    )
    .orderBy(asc(sessions.createdAt))
    .limit(50);

  return rows.map(({ answers, ...row }) => ({
    ...row,
    format:
      row.format ??
      readNamedOptionAnswer(
        (answers ?? {}) as Record<string, unknown>,
        FORMAT_ANSWER_KEYS,
      ),
    status: speakerVisibleStatus(row.status),
  }));
}

/** Every task assigned to the speaker, with the submission title when scoped. */
export async function loadTasks(personId: string, eventId: string): Promise<TaskSummary[]> {
  const rows = await getDb()
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
      sessionId: tasks.sessionId,
      sessionTitle: sessions.title,
      formId: tasks.formId,
    })
    .from(tasks)
    .leftJoin(sessions, eq(sessions.id, tasks.sessionId))
    .where(and(eq(tasks.personId, personId), eq(tasks.eventId, eventId)))
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    dueAt: row.dueAt?.getTime() ?? null,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    formId: row.formId,
  }));
}

/** Serialisable person for a loader payload. */
export function publicPerson(person: PortalActor["person"]) {
  return {
    id: person.id,
    email: person.email,
    fullName: person.fullName,
    firstName: person.firstName,
    lastName: person.lastName,
    pronouns: person.pronouns,
    company: person.company,
    title: person.title,
    bio: person.bio,
    hasHeadshot: Boolean(person.headshotKey),
    links: (person.links ?? {}) as Record<string, string>,
  };
}
