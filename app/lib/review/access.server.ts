import { and, asc, eq } from "drizzle-orm";

import { getDb } from "~/db/client.server";
import { events, reviewTeamMembers, reviewTeams, type Event, type Person } from "~/db/schema";
import { requireUser } from "~/lib/auth/auth.server";
import { readReviewerImpersonationCookie } from "~/lib/review/impersonation.server";

export interface ReviewerActor {
  person: Person;
  impersonatedBy: Person | null;
}

/** True when this person belongs to at least one review team for the event. */
export async function isReviewerForEvent(personId: string, eventId: string): Promise<boolean> {
  const [membership] = await getDb()
    .select({ personId: reviewTeamMembers.personId })
    .from(reviewTeamMembers)
    .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
    .where(and(eq(reviewTeamMembers.personId, personId), eq(reviewTeams.eventId, eventId)))
    .limit(1);
  return Boolean(membership);
}

/** Used after sign-in so reviewer-only accounts arrive at their actual workspace. */
export async function hasAnyReviewMembership(personId: string): Promise<boolean> {
  const [membership] = await getDb()
    .select({ personId: reviewTeamMembers.personId })
    .from(reviewTeamMembers)
    .where(eq(reviewTeamMembers.personId, personId))
    .limit(1);
  return Boolean(membership);
}

/**
 * Resolve the identity rendered by the reviewer workspace.
 *
 * Ordinary reviewers act as themselves. An admin may use the separate signed,
 * admin-bound reviewer-preview cookie; event membership is checked separately
 * on every loader/action. Speaker preview and reviewer preview intentionally
 * use different cookies so neither surface silently changes the other's actor.
 */
export async function requireReviewerActor(request: Request): Promise<ReviewerActor> {
  const real = await requireUser(request);
  const claim = await readReviewerImpersonationCookie(request);
  if (!claim || real.role !== "admin" || claim.adminId !== real.id) {
    return { person: real, impersonatedBy: null };
  }

  const target = await getDb().query.people.findFirst({
    where: (people, { eq }) => eq(people.id, claim.targetId),
  });
  return target ? { person: target, impersonatedBy: real } : { person: real, impersonatedBy: null };
}

export async function requireEventReviewer(
  request: Request,
  eventId: string,
): Promise<ReviewerActor> {
  const actor = await requireReviewerActor(request);
  if (!(await isReviewerForEvent(actor.person.id, eventId))) {
    throw new Response("Forbidden — reviewer access required for this event.", { status: 403 });
  }
  return actor;
}

/** Resolve only an event this reviewer actually participates in. */
export async function requireReviewerEvent(request: Request, personId: string): Promise<Event> {
  const slug = new URL(request.url).searchParams.get("event");
  const [row] = await getDb()
    .select({ event: events })
    .from(reviewTeamMembers)
    .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
    .innerJoin(events, eq(events.id, reviewTeams.eventId))
    .where(
      and(
        eq(reviewTeamMembers.personId, personId),
        ...(slug ? [eq(events.slug, slug)] : []),
      ),
    )
    .orderBy(asc(events.createdAt))
    .limit(1);
  if (!row) {
    throw new Response("Forbidden — reviewer access required for this event.", { status: 403 });
  }
  return row.event;
}
