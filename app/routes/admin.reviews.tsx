import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, PageHeader } from "~/components/shell";
import { chunkForBind, getDb } from "~/db/client.server";
import {
  eventPeople,
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  sessions,
  tracks,
} from "~/db/schema";
import {
  findOrCreatePerson,
  normalizeEmail,
  requireAdmin,
  sendMagicLink,
  shouldRevealMagicLink,
  type MagicLinkDelivery,
} from "~/lib/auth/auth.server";
import { appUrl } from "~/lib/env.server";
import { currentEvent } from "~/lib/event.server";
import { buildRoundProgress } from "~/lib/review/progress";
import { sendReviewReminders } from "~/lib/review/reminders.server";
import { parseRubricEditor } from "~/lib/review/review-operations";
import {
  DEFAULT_RUBRIC,
  isRoundBlind,
  isSelectCriterion,
  isTextCriterion,
  isUnscoredCriterion,
  parseRubric,
  withRoundBlind,
} from "~/lib/review/scoring";
import { epochToZonedInput, zonedInputToEpoch } from "~/lib/zoned-time";
import type { Route } from "./+types/admin.reviews";

const PAGE = "/admin/reviews";
/** Per-event roles that may sit on a review team. Deliberately NOT the global
 * `people.role`: a reviewer must be able to exist without organizer authority. */
const REVIEWER_CAPABLE_EVENT_ROLES = ["admin", "organizer", "reviewer"] as const;

/**
 * "May this person review on this event?" — the one predicate, written once.
 *
 * Three independent grants, ORed, and the third is the point. `event_people`
 * has ONE row per person per event (`primaryKey(event_id, person_id)`), so
 * `event_role` can hold one value. Provisioning used to take it: an existing
 * speaker invited as a reviewer had `event_role` overwritten from `speaker` to
 * `reviewer`, which is a silent DELETE from every surface that reads that
 * column by equality — `speakerRoster()` in admin.tasks, and `selectRecipients`
 * in comms/bulk, where it means an accepted speaker stops matching
 * `all_speakers` and never receives their logistics mail again.
 *
 * `is_reviewer` grants the capability without withdrawing the role. Callers
 * must use THIS helper rather than re-deriving the OR, so the loader's dropdown
 * and the server-side `add-member` check can never disagree about who is
 * eligible — a dropdown that offers someone the action then refuses is the
 * failure mode the pair of call sites exists to prevent.
 */
function reviewerCapable() {
  return or(
    eq(people.role, "admin"),
    inArray(eventPeople.eventRole, [...REVIEWER_CAPABLE_EVENT_ROLES]),
    eq(eventPeople.isReviewer, true),
  );
}
/*
 * `dark:bg-gray-950`, not `dark:bg-gray-900`: the section shells below now
 * carry `dark:bg-gray-900` themselves, and a field the same colour as the card
 * it sits on is an invisible input.
 */
const FIELD =
  "rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950";
const FIELD_NUM = `${FIELD} tabular-nums`;
const BUTTON = buttonClass("primary");
const GHOST = buttonClass("secondary");
/** Row-scale secondary, for the one-per-row control in the assignments table. */
const GHOST_SM = buttonClass("secondary", "sm");
const SECTION =
  "rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900";

function values(form: FormData, key: string): string[] {
  return form.getAll(key).map(String);
}

function assignableAbstractsInEvent(eventId: string, trackId: string | null = null) {
  return and(
    eq(sessions.eventId, eventId),
    eq(sessions.isAbstract, true),
    isNull(sessions.deletedAt),
    inArray(sessions.status, ["pending", "accept_queue", "decline_queue"]),
    ...(trackId ? [eq(sessions.trackId, trackId)] : []),
  );
}

function reminderNotice(url: URL): string | null {
  const reminded = Number(url.searchParams.get("reminded"));
  const failed = Number(url.searchParams.get("reminderFailed"));
  if (!url.searchParams.has("reminded") || !Number.isInteger(reminded) || reminded < 0) return null;
  const failureCount = Number.isInteger(failed) && failed > 0 ? failed : 0;
  if (reminded === 0 && failureCount === 0) return "No reviewers have outstanding reviews.";
  if (reminded === 0) {
    return `No reviewer reminders were sent. ${failureCount} reminder${failureCount === 1 ? "" : "s"} failed.`;
  }
  const sent = `Reminded ${reminded} reviewer${reminded === 1 ? "" : "s"} with outstanding reviews.`;
  return failureCount > 0
    ? `${sent} ${failureCount} reminder${failureCount === 1 ? "" : "s"} failed.`
    : sent;
}

/**
 * What "Assign all matching" did, in the same green banner every other bulk
 * action on this page reports through (ABS-06).
 *
 * Two numbers, because one cannot tell the difference between "there was
 * nothing to do" and "nothing happened" — and that ambiguity is the bug.
 */
function assignNotice(url: URL): string | null {
  /*
   * Strict on purpose. `Number(null)` and `Number("")` are both 0, not NaN, so
   * the obvious spelling turns a hand-typed `?assigned=` into a confident
   * "nothing to assign" — a receipt for an action nobody took, which is the
   * defect this banner exists to remove, pointed the other way.
   */
  const count = (key: string): number | null => {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };

  const assigned = count("assigned");
  const matched = count("matched");
  if (assigned === null || matched === null || matched < assigned) return null;

  const submissions = (count: number) => `${count} submission${count === 1 ? "" : "s"}`;
  if (matched === 0) return "No submissions matched that filter — nothing to assign.";
  if (assigned === 0) {
    return `${submissions(matched)} matched, and every one was already assigned to that team.`;
  }
  return assigned === matched
    ? `Assigned ${submissions(assigned)} to that review team.`
    : `Assigned ${submissions(assigned)} to that review team. The other ${matched - assigned} were already assigned.`;
}

export function meta() {
  return [{ title: "Review ops — callboard admin" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const notice = reminderNotice(url) ?? assignNotice(url);
  const event = await currentEvent(request);
  if (!event) {
    return { event: null, teams: [], rounds: [], reviewers: [], submissions: [], assignments: [], recusals: [], tracks: [], assignTrack: null, notice };
  }

  const db = getDb();
  const trackRows = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, event.id))
    .orderBy(asc(tracks.order), asc(tracks.name));
  const requestedTrack = url.searchParams.get("assignTrack");
  const assignTrack = trackRows.some((track) => track.id === requestedTrack) ? requestedTrack : null;
  const [teamRows, memberRows, roundRows, reviewRows, reviewerRows, submissionRows, assignmentRows, recusalRows] =
    await Promise.all([
      db.select().from(reviewTeams).where(eq(reviewTeams.eventId, event.id)).orderBy(asc(reviewTeams.name)),
      db
        .select({
          teamId: reviewTeamMembers.teamId,
          personId: people.id,
          name: people.fullName,
          email: people.email,
        })
        .from(reviewTeamMembers)
        .innerJoin(people, eq(people.id, reviewTeamMembers.personId))
        .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
        .where(eq(reviewTeams.eventId, event.id))
        .orderBy(asc(people.fullName)),
      db.select().from(reviewRounds).where(eq(reviewRounds.eventId, event.id)).orderBy(asc(reviewRounds.ordinal)),
      db
        .select({
          roundId: reviews.roundId,
          sessionId: reviews.sessionId,
          reviewerId: reviews.reviewerId,
          submittedAt: reviews.submittedAt,
          recusedAt: reviews.recusedAt,
        })
        .from(reviews)
        .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
        .innerJoin(sessions, eq(sessions.id, reviews.sessionId))
        .where(
          and(
            eq(reviewRounds.eventId, event.id),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, true),
            isNull(sessions.deletedAt),
            or(isNotNull(reviews.submittedAt), isNotNull(reviews.recusedAt)),
          ),
        ),
      db
        .select({
          id: people.id,
          name: people.fullName,
          email: people.email,
          eventRole: eventPeople.eventRole,
          isReviewer: eventPeople.isReviewer,
        })
        .from(eventPeople)
        .innerJoin(people, eq(people.id, eventPeople.personId))
        .where(and(eq(eventPeople.eventId, event.id), reviewerCapable()))
        .orderBy(asc(people.fullName)),
      db
        .select({
          id: sessions.id,
          friendlyId: sessions.friendlyId,
          title: sessions.title,
          trackId: sessions.trackId,
          trackName: tracks.name,
        })
        .from(sessions)
        .leftJoin(tracks, eq(tracks.id, sessions.trackId))
        .where(assignableAbstractsInEvent(event.id, assignTrack))
        .orderBy(asc(sessions.createdAt)),
      db
        .select({
          id: reviewAssignments.id,
          roundId: reviewAssignments.roundId,
          teamId: reviewAssignments.teamId,
          teamName: reviewTeams.name,
          sessionId: reviewAssignments.sessionId,
          sessionTitle: sessions.title,
          friendlyId: sessions.friendlyId,
        })
        .from(reviewAssignments)
        .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssignments.roundId))
        .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
        .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
        .where(
          and(
            eq(reviewRounds.eventId, event.id),
            eq(reviewTeams.eventId, event.id),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, true),
            isNull(sessions.deletedAt),
          ),
        ),
      db
        .select({
          roundId: reviews.roundId,
          sessionId: reviews.sessionId,
          reviewerName: people.fullName,
          reviewerEmail: people.email,
        })
        .from(reviews)
        .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
        .innerJoin(sessions, eq(sessions.id, reviews.sessionId))
        .innerJoin(people, eq(people.id, reviews.reviewerId))
        .where(
          and(
            eq(reviewRounds.eventId, event.id),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, true),
            isNull(sessions.deletedAt),
            isNotNull(reviews.recusedAt),
          ),
        ),
    ]);

  return {
    event: { id: event.id, name: event.name, timezone: event.timezone },
    teams: teamRows.map((team) => ({
      id: team.id,
      name: team.name,
      members: memberRows.filter((member) => member.teamId === team.id),
    })),
    rounds: roundRows.map((round) => {
      const progress = buildRoundProgress({
        roundId: round.id,
        members: memberRows,
        assignments: assignmentRows,
        submittedReviews: reviewRows.filter((review) => review.submittedAt !== null),
        excludedReviews: reviewRows.filter((review) => review.recusedAt !== null),
        teamNames: new Map(teamRows.map((team) => [team.id, team.name])),
      });
      return {
        id: round.id,
        name: round.name,
        ordinal: round.ordinal,
        opensAt: round.opensAt?.toISOString() ?? null,
        closesAt: round.closesAt?.toISOString() ?? null,
        rubric: parseRubric(round.rubric),
        blind: isRoundBlind(round.rubric),
        submittedReviews: reviewRows.filter(
          (review) => review.roundId === round.id && review.submittedAt !== null,
        ).length,
        progress,
      };
    }),
    reviewers: reviewerRows,
    submissions: submissionRows,
    assignments: assignmentRows,
    recusals: recusalRows,
    tracks: trackRows,
    assignTrack,
    notice,
  };
}

async function teamInEvent(eventId: string, teamId: string) {
  return getDb().query.reviewTeams.findFirst({
    where: and(eq(reviewTeams.id, teamId), eq(reviewTeams.eventId, eventId)),
  });
}

async function roundInEvent(eventId: string, roundId: string) {
  return getDb().query.reviewRounds.findFirst({
    where: and(eq(reviewRounds.id, roundId), eq(reviewRounds.eventId, eventId)),
  });
}

/** A person who may be added to a review team on this event, or undefined. */
async function reviewerCandidate(eventId: string, personId: string) {
  const [candidate] = await getDb()
    .select({ id: people.id, fullName: people.fullName, email: people.email })
    .from(eventPeople)
    .innerJoin(people, eq(people.id, eventPeople.personId))
    .where(and(eq(eventPeople.eventId, eventId), eq(people.id, personId), reviewerCapable()))
    .limit(1);
  return candidate;
}

async function scopeSessionIdsToEvent(
  eventId: string,
  sessionIds: string[],
): Promise<boolean> {
  // Bulk select-all puts one bound parameter per checked submission in this
  // IN list, on top of the event/abstract predicates — chunk it under D1's cap.
  const scoped = (
    await Promise.all(
      chunkForBind(sessionIds, 1).map((chunk) =>
        getDb()
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.eventId, eventId),
              eq(sessions.isAbstract, true),
              isNull(sessions.deletedAt),
              inArray(sessions.id, chunk),
            ),
          ),
      ),
    )
  ).flat();
  return scoped.length === sessionIds.length;
}

function roundDate(raw: string, timeZone: string, endOfDay: boolean): Date | null | undefined {
  if (!raw) return null;
  // `zonedInputToEpoch` keeps organizer-entered dates in the event zone; UTC parsing shifts the visible day.
  const epoch = zonedInputToEpoch(`${raw}T${endOfDay ? "23:59" : "00:00"}`, timeZone);
  return epoch === null ? undefined : new Date(epoch);
}

function invalidRoundWindow(opensAt: Date | null, closesAt: Date | null): boolean {
  return Boolean(opensAt && closesAt && closesAt.getTime() <= opensAt.getTime());
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await currentEvent(request);
  if (!event) return { ok: false as const, error: "Create an event before configuring reviews." };

  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create-team") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 80) {
      return { ok: false as const, error: "Team names are required and capped at 80 characters." };
    }
    const duplicate = await db.query.reviewTeams.findFirst({
      where: and(eq(reviewTeams.eventId, event.id), eq(reviewTeams.name, name)),
    });
    if (duplicate) return { ok: false as const, error: "A review team already uses that name." };
    await db.insert(reviewTeams).values({ id: crypto.randomUUID(), eventId: event.id, name });
    return redirect(PAGE);
  }

  if (intent === "invite-reviewer") {
    const name = String(form.get("name") ?? "").trim();
    const email = normalizeEmail(String(form.get("email") ?? ""));
    const teamId = String(form.get("teamId") ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false as const, error: "Enter a valid email address." };
    }
    if (name.length > 120) {
      return { ok: false as const, error: "Reviewer names are capped at 120 characters." };
    }
    if (teamId && !(await teamInEvent(event.id, teamId))) {
      return { ok: false as const, error: "That review team does not belong to this event." };
    }

    const person = await findOrCreatePerson(email, { fullName: name || undefined });
    if (name && !person.fullName?.trim()) {
      await db.update(people).set({ fullName: name }).where(eq(people.id, person.id));
      person.fullName = name;
    }

    const membership = await db.query.eventPeople.findFirst({
      where: and(eq(eventPeople.eventId, event.id), eq(eventPeople.personId, person.id)),
    });
    /*
     * Grant reviewer capability; never withdraw the role they already hold.
     *
     * A brand-new person has no other role to lose, so `event_role` is set to
     * "reviewer" for legibility on the roster. An EXISTING membership keeps its
     * `event_role` untouched — overwriting a speaker's role here removed them
     * from `speakerRoster()` (admin.tasks) and from every `comms/bulk`
     * audience, so a speaker who agreed to review stopped receiving their own
     * logistics email. `is_reviewer` is additive and carries the capability on
     * its own; `reviewerCapable()` above is what reads it.
     */
    if (!membership) {
      await db.insert(eventPeople).values({
        eventId: event.id,
        personId: person.id,
        eventRole: "reviewer",
        isReviewer: true,
      });
    } else if (!membership.isReviewer) {
      await db
        .update(eventPeople)
        .set({ isReviewer: true })
        .where(and(eq(eventPeople.eventId, event.id), eq(eventPeople.personId, person.id)));
    }

    if (teamId) {
      await db
        .insert(reviewTeamMembers)
        .values({ teamId, personId: person.id })
        .onConflictDoNothing();
    }

    /*
     * Report the delivery the mailer OBSERVED, not the absence of an exception.
     *
     * `mailed = true` because `sendMagicLink()` returned was unfalsifiable: the
     * console driver — the default on a fresh clone, and what MAIL_DRIVER pins
     * for the demo and for every e2e run — returns `ok: true` unconditionally
     * and never throws. So the panel said "a sign-in link was emailed to them"
     * on the one configuration where nothing had been emailed to anybody.
     * `delivery.state` is the mailer's own answer; "sent" is reachable only
     * from a provider that answered.
     *
     * The catch is still here and still resolves ok: a rate limit must not
     * un-provision a reviewer who is already on the team. But it now reports
     * "unknown" rather than borrowing the failure state of a provider that was
     * never reached.
     */
    let magicLink: string | null = null;
    let delivery: MagicLinkDelivery = { state: "unknown", driver: "unknown" };
    try {
      const issued = await sendMagicLink({ request, email, redirectTo: "/review" });
      delivery = issued.delivery;
      magicLink = shouldRevealMagicLink() ? issued.url : null;
    } catch (error) {
      delivery = {
        state: "unknown",
        driver: "unknown",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true as const,
      invited: { name: person.fullName ?? "", email: person.email, magicLink, delivery },
    };
  }

  if (intent === "rename-team") {
    const teamId = String(form.get("teamId") ?? "");
    const team = await teamInEvent(event.id, teamId);
    if (!team) return { ok: false as const, error: "That review team does not belong to this event." };
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 80) {
      return { ok: false as const, error: "Team names are required and capped at 80 characters." };
    }
    const duplicate = await db.query.reviewTeams.findFirst({
      where: and(eq(reviewTeams.eventId, event.id), eq(reviewTeams.name, name)),
    });
    if (duplicate && duplicate.id !== team.id) {
      return { ok: false as const, error: "A review team already uses that name." };
    }
    await db.update(reviewTeams).set({ name, updatedAt: new Date() }).where(eq(reviewTeams.id, team.id));
    return redirect(PAGE);
  }

  if (intent === "add-member") {
    const teamId = String(form.get("teamId") ?? "");
    const personId = String(form.get("personId") ?? "");
    if (!(await teamInEvent(event.id, teamId))) {
      return { ok: false as const, error: "That review team does not belong to this event." };
    }
    const candidate = await reviewerCandidate(event.id, personId);
    if (!candidate) {
      return { ok: false as const, error: "That person is not a reviewer, organizer, or admin on this event." };
    }
    await db
      .insert(reviewTeamMembers)
      .values({ teamId, personId })
      .onConflictDoNothing();
    return redirect(PAGE);
  }

  if (intent === "remove-member") {
    const teamId = String(form.get("teamId") ?? "");
    const personId = String(form.get("personId") ?? "");
    if (!(await teamInEvent(event.id, teamId))) {
      return { ok: false as const, error: "That review team does not belong to this event." };
    }
    await db
      .delete(reviewTeamMembers)
      .where(and(eq(reviewTeamMembers.teamId, teamId), eq(reviewTeamMembers.personId, personId)));
    return redirect(PAGE);
  }

  if (intent === "create-round") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 80) {
      return { ok: false as const, error: "Round names are required and capped at 80 characters." };
    }
    const opensRaw = String(form.get("opensAt") ?? "").trim();
    const closesRaw = String(form.get("closesAt") ?? "").trim();
    const parsedOpens = roundDate(opensRaw, event.timezone, false);
    const parsedCloses = roundDate(closesRaw, event.timezone, true);
    if (parsedOpens === undefined || parsedCloses === undefined) {
      return { ok: false as const, error: "Enter valid review-round dates." };
    }
    const opensAt = parsedOpens ?? new Date();
    if (invalidRoundWindow(opensAt, parsedCloses)) {
      return { ok: false as const, error: "The close date must be after the open date." };
    }
    const existing = await db
      .select({ ordinal: reviewRounds.ordinal })
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, event.id))
      .orderBy(asc(reviewRounds.ordinal));
    await db.insert(reviewRounds).values({
      id: crypto.randomUUID(),
      eventId: event.id,
      name,
      ordinal: (existing.at(-1)?.ordinal ?? 0) + 1,
      rubric: { criteria: DEFAULT_RUBRIC.criteria },
      opensAt,
      closesAt: parsedCloses,
    });
    return redirect(PAGE);
  }

  if (intent === "save-round-dates") {
    const roundId = String(form.get("roundId") ?? "");
    const round = await roundInEvent(event.id, roundId);
    if (!round) return { ok: false as const, error: "That review round does not belong to this event." };
    const opensAt = roundDate(String(form.get("opensAt") ?? "").trim(), event.timezone, false);
    const closesAt = roundDate(String(form.get("closesAt") ?? "").trim(), event.timezone, true);
    if (opensAt === undefined || closesAt === undefined) {
      return { ok: false as const, error: "Enter valid review-round dates." };
    }
    if (invalidRoundWindow(opensAt, closesAt)) {
      return { ok: false as const, error: "The close date must be after the open date." };
    }
    await db
      .update(reviewRounds)
      .set({ opensAt, closesAt, updatedAt: new Date() })
      .where(and(eq(reviewRounds.id, round.id), eq(reviewRounds.eventId, event.id)));
    return redirect(PAGE);
  }

  if (intent === "save-rubric") {
    const roundId = String(form.get("roundId") ?? "");
    const round = await roundInEvent(event.id, roundId);
    if (!round) return { ok: false as const, error: "That review round does not belong to this event." };
    const submitted = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.roundId, roundId), isNotNull(reviews.submittedAt)))
      .limit(1);
    if (submitted.length) {
      return { ok: false as const, error: "A rubric cannot change after a reviewer has submitted a score." };
    }
    const parsed = parseRubricEditor({
      keys: values(form, "criterionKey"),
      labels: values(form, "criterionLabel"),
      mins: values(form, "criterionMin"),
      maxes: values(form, "criterionMax"),
      weights: values(form, "criterionWeight"),
      types: values(form, "criterionType"),
      options: values(form, "criterionOptions"),
      removes: values(form, "criterionRemove"),
    });
    if (!parsed.ok) return { ok: false as const, error: parsed.error };
    await db
      .update(reviewRounds)
      .set({
        rubric: { ...(round.rubric ?? {}), criteria: parsed.rubric.criteria },
        updatedAt: new Date(),
      })
      .where(eq(reviewRounds.id, round.id));
    return redirect(PAGE);
  }

  if (intent === "set-round-blinding") {
    const roundId = String(form.get("roundId") ?? "");
    const round = await roundInEvent(event.id, roundId);
    if (!round) return { ok: false as const, error: "That review round does not belong to this event." };
    await db
      .update(reviewRounds)
      .set({
        rubric: withRoundBlind(round.rubric, form.get("blind") === "on"),
        updatedAt: new Date(),
      })
      .where(and(eq(reviewRounds.id, roundId), eq(reviewRounds.eventId, event.id)));
    return redirect(PAGE);
  }

  if (intent === "assign-team") {
    const roundId = String(form.get("roundId") ?? "");
    const teamId = String(form.get("teamId") ?? "");
    const sessionIds = Array.from(new Set(values(form, "sessionId").filter(Boolean)));
    if (!(await roundInEvent(event.id, roundId))) {
      return { ok: false as const, error: "That review round does not belong to this event." };
    }
    if (!(await teamInEvent(event.id, teamId))) {
      return { ok: false as const, error: "That review team does not belong to this event." };
    }
    if (!sessionIds.length) return { ok: false as const, error: "Select at least one submission." };

    if (!(await scopeSessionIdsToEvent(event.id, sessionIds))) {
      return { ok: false as const, error: "One or more selected submissions do not belong to this event." };
    }

    const rows = sessionIds.map((sessionId) => ({
      id: crypto.randomUUID(),
      roundId,
      sessionId,
      teamId,
    }));
    for (const chunk of chunkForBind(rows, 4)) {
      await db.insert(reviewAssignments).values(chunk).onConflictDoNothing();
    }
    return redirect(PAGE);
  }

  if (intent === "assign-reviewer") {
    const roundId = String(form.get("roundId") ?? "");
    const personId = String(form.get("personId") ?? "");
    const sessionIds = Array.from(new Set(values(form, "sessionId").filter(Boolean)));
    if (!(await roundInEvent(event.id, roundId))) {
      return { ok: false as const, error: "That review round does not belong to this event." };
    }
    const person = await reviewerCandidate(event.id, personId);
    if (!person) {
      return { ok: false as const, error: "That person is not a reviewer, organizer, or admin on this event." };
    }
    if (!sessionIds.length) return { ok: false as const, error: "Select at least one submission." };
    if (!(await scopeSessionIdsToEvent(event.id, sessionIds))) {
      return { ok: false as const, error: "One or more selected submissions do not belong to this event." };
    }

    const label = (person.fullName ?? "").trim() || person.email;
    let teamName = `Solo · ${label}`;
    let soloTeam = await db.query.reviewTeams.findFirst({
      where: and(eq(reviewTeams.eventId, event.id), eq(reviewTeams.name, teamName)),
    });
    if (soloTeam) {
      const members = await db
        .select({ personId: reviewTeamMembers.personId })
        .from(reviewTeamMembers)
        .where(eq(reviewTeamMembers.teamId, soloTeam.id));
      if (members.length !== 1 || members[0]?.personId !== personId) {
        teamName = `Solo · ${person.email}`;
        soloTeam = await db.query.reviewTeams.findFirst({
          where: and(eq(reviewTeams.eventId, event.id), eq(reviewTeams.name, teamName)),
        });
      }
    }
    if (!soloTeam) {
      const id = crypto.randomUUID();
      await db.insert(reviewTeams).values({ id, eventId: event.id, name: teamName });
      soloTeam = await db.query.reviewTeams.findFirst({
        where: and(eq(reviewTeams.id, id), eq(reviewTeams.eventId, event.id)),
      });
    }
    if (!soloTeam) {
      return { ok: false as const, error: "The solo review team could not be created." };
    }
    await db
      .insert(reviewTeamMembers)
      .values({ teamId: soloTeam.id, personId })
      .onConflictDoNothing();

    const rows = sessionIds.map((sessionId) => ({
      id: crypto.randomUUID(),
      roundId,
      sessionId,
      teamId: soloTeam.id,
    }));
    for (const chunk of chunkForBind(rows, 4)) {
      await db.insert(reviewAssignments).values(chunk).onConflictDoNothing();
    }
    return redirect(PAGE);
  }

  if (intent === "remind-reviewers") {
    const roundId = String(form.get("roundId") ?? "");
    if (!(await roundInEvent(event.id, roundId))) {
      return { ok: false as const, error: "That review round does not belong to this event." };
    }
    const result = await sendReviewReminders({
      eventId: event.id,
      roundId,
      db,
      origin: appUrl(request),
    });
    return redirect(
      `${PAGE}?reminded=${result.sent}&reminderFailed=${result.failed}`,
    );
  }

  if (intent === "assign-all-matching") {
    const roundId = String(form.get("roundId") ?? "");
    const teamId = String(form.get("teamId") ?? "");
    if (!(await roundInEvent(event.id, roundId))) {
      return { ok: false as const, error: "That review round does not belong to this event." };
    }
    if (!(await teamInEvent(event.id, teamId))) {
      return { ok: false as const, error: "That review team does not belong to this event." };
    }

    const requestedTrack = String(form.get("assignTrack") ?? "");
    const scopedTrack = requestedTrack
      ? await db.query.tracks.findFirst({
          where: and(eq(tracks.id, requestedTrack), eq(tracks.eventId, event.id)),
        })
      : null;
    const assignTrack = scopedTrack?.id ?? null;
    const matching = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(assignableAbstractsInEvent(event.id, assignTrack));

    /*
     * ABS-06: the write was always happening and the screen never said so, which
     * is indistinguishable from a no-op — the organizer filtered 13 abstracts
     * down to 2, pressed the button, and got a bare redirect back to an
     * unchanged-looking page.
     *
     * Counting the rows we SEND would be the easy number and the wrong one:
     * `onConflictDoNothing` makes this idempotent, so pressing the button twice
     * would claim to have assigned everything twice. Reading the team's existing
     * rows for this round first is what lets the notice distinguish "assigned 2"
     * from "those 2 were already assigned". Fetched whole rather than by
     * `inArray(matchingIds)` so the query cannot grow past SQLite's bind limit
     * on a large event.
     */
    const already = new Set(
      (
        await db
          .select({ sessionId: reviewAssignments.sessionId })
          .from(reviewAssignments)
          .where(
            and(eq(reviewAssignments.roundId, roundId), eq(reviewAssignments.teamId, teamId)),
          )
      ).map((row) => row.sessionId),
    );

    const rows = matching
      .filter((submission) => !already.has(submission.id))
      .map((submission) => ({
        id: crypto.randomUUID(),
        roundId,
        sessionId: submission.id,
        teamId,
      }));
    // Kept as the race guard it always was, now that the count no longer leans
    // on it: two organizers pressing the button at once must not 500.
    for (const chunk of chunkForBind(rows, 4)) {
      await db.insert(reviewAssignments).values(chunk).onConflictDoNothing();
    }
    return redirect(`${PAGE}?assigned=${rows.length}&matched=${matching.length}`);
  }

  if (intent === "unassign-team") {
    const assignmentId = String(form.get("assignmentId") ?? "");
    const scoped = await db
      .select({ id: reviewAssignments.id })
      .from(reviewAssignments)
      .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssignments.roundId))
      .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
      .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
      .where(
        and(
          eq(reviewAssignments.id, assignmentId),
          eq(reviewRounds.eventId, event.id),
          eq(reviewTeams.eventId, event.id),
          eq(sessions.eventId, event.id),
        ),
      )
      .limit(1);
    if (!scoped.length) {
      return { ok: false as const, error: "That assignment does not belong to this event." };
    }
    await db.delete(reviewAssignments).where(eq(reviewAssignments.id, assignmentId));
    return redirect(PAGE);
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

function roundDateInput(iso: string | null, timeZone: string): string {
  return iso ? epochToZonedInput(new Date(iso), timeZone).slice(0, 10) : "";
}

function roundDateLabel(opensAt: string | null, closesAt: string | null, timeZone: string): string {
  if (!opensAt && !closesAt) return "No dates set";
  const format = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  if (opensAt && closesAt) return `Open ${format(opensAt)} – ${format(closesAt)}`;
  if (opensAt) return `Open ${format(opensAt)}`;
  return `Closes ${format(closesAt!)}`;
}

export type ReviewActionData =
  | { ok: false; error: string }
  | {
      ok: true;
      invited: {
        name: string;
        email: string;
        magicLink: string | null;
        delivery: MagicLinkDelivery;
      };
    };

/**
 * One sentence per delivery state, and none of them overclaims.
 *
 * Only `"sent"` names an email, and only a driver that observed a provider
 * accepting the message can produce that state. The other three say what
 * actually happened and what the organizer should do about it, because the
 * organizer's next move differs in each case: nothing (sent), copy the link out
 * of the log or off this page (logged), fix the address (rejected), check
 * before retrying (unknown).
 */
function deliveryCopy(delivery: MagicLinkDelivery): { text: string; warn: boolean } {
  switch (delivery.state) {
    case "sent":
      return { text: "A sign-in link was emailed to them.", warn: false };
    case "logged":
      return {
        text:
          `No email was sent: this deployment's mail driver is "${delivery.driver}", ` +
          "which writes the message to the server log. Send them the sign-in link yourself, " +
          "or have them request one from the sign-in page.",
        warn: false,
      };
    case "failed":
      return {
        // "No delivery was confirmed", not "it was refused": a transport error
        // and a provider rejection arrive here as the same `ok: false`, and
        // only the second one is anybody saying no.
        text:
          "No delivery was confirmed — the send failed" +
          `${delivery.error ? ` (${delivery.error})` : ""}. ` +
          "Resend it from the sign-in page.",
        warn: true,
      };
    case "unknown":
      return {
        text:
          "The sign-in link may not have gone out — the send failed before it reached the " +
          "mailer. Ask them to request a link from the sign-in page.",
        warn: true,
      };
  }
}

export function ReviewOperationsView({
  event,
  teams,
  rounds,
  reviewers,
  submissions,
  assignments,
  recusals,
  tracks,
  assignTrack,
  notice,
  actionData,
}: Awaited<ReturnType<typeof loader>> & {
  actionData?: ReviewActionData;
}) {
  if (!event) {
    return <p className="rounded border border-gray-200 p-4">Create an event before configuring review operations.</p>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Review operations"
        description={`Set up reviewer teams, rubrics, and submission assignments for ${event.name}.`}
      />

      {actionData && actionData.ok === false ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{actionData.error}</p>
      ) : null}
      {actionData?.ok ? (
        <div role="status" className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          <p>Added {actionData.invited.name || actionData.invited.email} as a reviewer on this event.</p>
          {(() => {
            const copy = deliveryCopy(actionData.invited.delivery);
            return (
              <p className={copy.warn ? "text-amber-700 dark:text-amber-300" : undefined}>
                {copy.text}
              </p>
            );
          })()}
          {actionData.invited.magicLink ? (
            <>
              <p>
                Sign-in link: {" "}
                <a href={actionData.invited.magicLink} className="break-all underline">
                  {actionData.invited.magicLink}
                </a>
              </p>
              <p>Shown only because this deployment reveals sign-in links.</p>
            </>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">{notice}</p>
      ) : null}

      {/*
        * Both top-level sections now open with a ruled head that says what the
        * section is FOR. This screen is six stacked control groups, and every
        * one of them was announced by a bare `font-semibold` line the same size
        * as the body text beside it — so the page read as one undifferentiated
        * form and a judge had to parse controls to find the stage they wanted.
        */}
      <section id="reviewer-teams" className={SECTION}>
        <div className="mb-4 border-b border-gray-200 pb-4 dark:border-gray-800">
          <h3 className="text-lg font-semibold tracking-tight">Committees (shared across rounds)</h3>
          <p className="mt-1 max-w-prose text-sm leading-6 text-gray-600 dark:text-gray-400">
            A round&apos;s reviewer pool is whichever committees hold that round&apos;s assignments — so a round-1 reviewer is not automatically a round-2 reviewer.
          </p>
        </div>
        <form method="post" className="flex flex-wrap gap-2">
          <input type="hidden" name="intent" value="create-team" />
          <input name="name" required maxLength={80} placeholder="Team name" className={FIELD} />
          <button className={BUTTON}>Create team</button>
        </form>
        <h4 className="mt-5 text-sm font-semibold">Add reviewer</h4>
        <p className="mt-1 text-xs text-gray-500">
          Creates a reviewer-only identity, or promotes an existing person by email. Reviewers do not get organizer access.
        </p>
        <form method="post" className="mt-2 flex flex-wrap gap-2">
          <input type="hidden" name="intent" value="invite-reviewer" />
          <input name="name" maxLength={120} placeholder="Full name" aria-label="Reviewer name" className={FIELD} />
          <input name="email" type="email" required placeholder="reviewer@example.com" aria-label="Reviewer email" className={FIELD} />
          <select name="teamId" aria-label="Add reviewer to team" className={FIELD}>
            <option value="">No team yet</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
          <button className={BUTTON}>Add reviewer</button>
        </form>
        {teams.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
            <p className="text-sm font-medium">No reviewer teams yet.</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
              Name a team above — &ldquo;Program committee&rdquo; is a fine start — then add
              reviewers to it and hand it a batch of submissions.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {teams.map((team) => (
              <article key={team.id} className="min-w-0 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <form method="post" className="flex gap-2">
                  <input type="hidden" name="intent" value="rename-team" />
                  <input type="hidden" name="teamId" value={team.id} />
                  <input name="name" defaultValue={team.name} required maxLength={80} className={`${FIELD} min-w-0 flex-1`} />
                  <button className={GHOST}>Rename</button>
                </form>
                <ul className="mt-3 space-y-2 text-sm">
                  {team.members.length === 0 ? <li className="text-gray-500">No reviewers assigned. Choose a reviewer below to add them to this team.</li> : team.members.map((member) => (
                    <li key={member.personId} className="flex items-center justify-between gap-2">
                      <span>{member.name ?? member.email}</span>
                      <form method="post">
                        <input type="hidden" name="intent" value="remove-member" />
                        <input type="hidden" name="teamId" value={team.id} />
                        <input type="hidden" name="personId" value={member.personId} />
                        <button className="text-xs underline">Remove</button>
                      </form>
                    </li>
                  ))}
                </ul>
                <form method="post" className="mt-3 flex gap-2">
                  <input type="hidden" name="intent" value="add-member" />
                  <input type="hidden" name="teamId" value={team.id} />
                  <select name="personId" required className={`${FIELD} min-w-0 flex-1`}>
                    <option value="">Choose reviewer…</option>
                    {reviewers.map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>
                        {reviewer.name ?? reviewer.email}
                        {/* `isReviewer` too, not just the role: a speaker granted
                            reviewer capability keeps `event_role = "speaker"`,
                            and reading the role alone would list them unlabelled
                            beside the organizers. */}
                        {reviewer.eventRole === "reviewer" || reviewer.isReviewer
                          ? ` · reviewer${reviewer.eventRole === "speaker" ? " (also speaker)" : ""}`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <button className={GHOST}>Add</button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={SECTION}>
        <div className="mb-4 border-b border-gray-200 pb-4 dark:border-gray-800">
          <h3 className="text-lg font-semibold tracking-tight">Rounds and rubrics</h3>
          <p className="mt-1 max-w-prose text-sm leading-6 text-gray-600 dark:text-gray-400">
            How they review. A round carries its own dates, scoring criteria,
            blinding setting and the submissions handed to each team.
          </p>
        </div>
        <form method="post" className="flex flex-wrap gap-2">
          <input type="hidden" name="intent" value="create-round" />
          <input name="name" required maxLength={80} placeholder="Round name" className={FIELD} />
          <input type="date" name="opensAt" aria-label="New round opens" className={FIELD} />
          <input type="date" name="closesAt" aria-label="New round closes" className={FIELD} />
          <button className={BUTTON}>Create round</button>
        </form>

        <div className="mt-4 space-y-5">
          {rounds.map((round) => {
            const ownAssignments = assignments.filter((assignment) => assignment.roundId === round.id);
            const assignedTeamIds = new Set(ownAssignments.map((assignment) => assignment.teamId));
            const roundTeams = teams.filter((team) => assignedTeamIds.has(team.id));
            return (
              /*
               * The round is the container for five separate control groups —
               * dates, progress, blinding, rubric, assignment — and it opened
               * with a `font-medium` line indistinguishable from the labels
               * inside it. A tinted, ruled band makes the round's own edge
               * visible when two of them are stacked.
               */
              <article key={round.id} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-950/60">
                  <h4 className="text-base font-semibold tracking-tight">Round {round.ordinal} · {round.name}</h4>
                  <span className="text-xs tabular-nums text-gray-600 dark:text-gray-400">{round.submittedReviews} submitted review{round.submittedReviews === 1 ? "" : "s"}</span>
                  <p className="w-full text-sm text-gray-600 dark:text-gray-400">
                    {roundDateLabel(round.opensAt, round.closesAt, event.timezone)}
                  </p>
                  <div className="mt-2 flex w-full flex-wrap items-center gap-3">
                    {round.progress.expectedReviews > 0 ? (
                      <p className="text-sm font-medium tabular-nums">
                        {round.progress.completedReviews} / {round.progress.expectedReviews} reviews complete · {round.progress.remainingReviews} left
                      </p>
                    ) : null}
                    {round.progress.unstaffedAssignments > 0 ? (
                      <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">
                        {round.progress.unstaffedAssignments} team assignment{round.progress.unstaffedAssignments === 1 ? " has" : "s have"} no reviewers.
                      </p>
                    ) : null}
                    <form method="post" className="sm:ml-auto">
                      <input type="hidden" name="intent" value="remind-reviewers" />
                      <input type="hidden" name="roundId" value={round.id} />
                      <button
                        disabled={round.progress.remainingReviews === 0}
                        className={GHOST}
                      >
                        Remind reviewers
                      </button>
                    </form>
                  </div>
                </div>

                {/*
                  * Deliberately OUTSIDE the "Dates, committees & rubric" details
                  * and ahead of it in source order: mobile-organizer.spec.ts
                  * asserts this heading is VISIBLE the moment a round exists, not
                  * merely present in the markup, and the provisioning test slices
                  * the rendered HTML between this literal heading text and
                  * "Reviewer progress" — both requirements mean this block stays
                  * always-open and stays right here.
                  */}
                <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                  <h5 className="text-sm font-semibold">Round {round.ordinal} reviewer pool</h5>
                  {roundTeams.length ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      {roundTeams.map((team) => (
                        <li key={team.id}>
                          {team.name} — {team.members.length
                            ? team.members.map((member) => member.name ?? member.email).join(", ")
                            : "no reviewers on this committee yet"}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-gray-500">No committee is assigned to this round yet. A committee appears here after you assign submissions to a reviewer team.</p>
                  )}
                  <a href="#reviewer-teams" className="text-xs underline">Manage committee membership</a>
                </div>

                {/*
                  * Blinding sits OUTSIDE any details, same reasoning as the
                  * reviewer-pool block above it: review-blinding.spec.ts checks
                  * this box and clicks "Save blinding" immediately after
                  * navigating to this page, with nothing opened first.
                  */}
                <form method="post" className="space-y-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                  <input type="hidden" name="intent" value="set-round-blinding" />
                  <input type="hidden" name="roundId" value={round.id} />
                  <p className={eyebrowClass}>Blinding</p>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="blind" defaultChecked={round.blind} />
                    Blind this round for reviewers
                  </label>
                  <p className="text-xs text-gray-500">
                    Reviewers see the abstract without the speaker&apos;s name, email, or affiliation. Organizers always see both.
                  </p>
                  <button className={GHOST}>Save blinding</button>
                </form>

                <details className="group border-b border-gray-200 dark:border-gray-700">
                  <summary className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 ${eyebrowClass}`}>
                    <span>Dates &amp; rubric</span>
                    <span aria-hidden="true" className="text-xs text-gray-400 dark:text-gray-500">▾</span>
                  </summary>
                  <div className="px-4 pb-4">
                <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
                  Setup controls are usually configured once; the rubric locks after the first submitted review.
                </p>
                <form method="post" className="flex flex-wrap gap-2">
                  <input type="hidden" name="intent" value="save-round-dates" />
                  <input type="hidden" name="roundId" value={round.id} />
                  <input
                    type="date"
                    name="opensAt"
                    aria-label={`Round ${round.ordinal} opens`}
                    defaultValue={roundDateInput(round.opensAt, event.timezone)}
                    className={FIELD}
                  />
                  <input
                    type="date"
                    name="closesAt"
                    aria-label={`Round ${round.ordinal} closes`}
                    defaultValue={roundDateInput(round.closesAt, event.timezone)}
                    className={FIELD}
                  />
                  <button className={GHOST}>Save dates</button>
                </form>

                <form method="post" className="mt-5 space-y-2 border-t border-gray-200 pt-4 dark:border-gray-700">
                  <input type="hidden" name="intent" value="save-rubric" />
                  <input type="hidden" name="roundId" value={round.id} />
                  <p className={`mb-3 ${eyebrowClass}`}>Scoring rubric</p>
                  {/*
                    * `aria-hidden` on purpose: every input below already carries
                    * its own `aria-label`, so this row is a VISUAL affordance for
                    * a sighted organizer staring at five unlabelled boxes. Exposed
                    * to the a11y tree it would be a second, competing name.
                    * Same grid template as the rows, or the columns do not line up.
                    */}
                  <div aria-hidden="true" className={`hidden gap-2 ${eyebrowClass} sm:grid sm:grid-cols-[6rem_1fr_1.5fr_4.5rem_4.5rem_4.5rem_6rem]`}>
                    <span>Type</span>
                    <span>Key</span>
                    <span>Label</span>
                    <span>Min</span>
                    <span>Max</span>
                    <span>Weight</span>
                    <span>Options / row</span>
                  </div>
                  {[...round.rubric.criteria, null].map((criterion) => {
                    const isSelect = criterion ? isSelectCriterion(criterion) : false;
                    const isText = criterion ? isTextCriterion(criterion) : false;
                    const isUnscored = criterion ? isUnscoredCriterion(criterion) : false;
                    return (
                      <div key={criterion?.key ?? "__new"} className="space-y-1">
                        <div className="grid gap-2 sm:grid-cols-[6rem_1fr_1.5fr_4.5rem_4.5rem_4.5rem_6rem]">
                          <select name="criterionType" aria-label="Criterion type" defaultValue={isText ? "text" : isSelect ? "select" : "number"} className={FIELD}>
                            <option value="number">Number</option>
                            <option value="select">Dropdown</option>
                            <option value="text">Free text</option>
                          </select>
                          <input name="criterionKey" aria-label="Criterion key" defaultValue={criterion?.key ?? ""} className={FIELD} />
                          <input name="criterionLabel" aria-label="Criterion label" defaultValue={criterion?.label ?? ""} className={FIELD} />
                          <input name="criterionMin" aria-label="Minimum" type="number" defaultValue={isUnscored ? 0 : (criterion?.min ?? 1)} className={FIELD_NUM} />
                          <input name="criterionMax" aria-label="Maximum" type="number" defaultValue={isUnscored ? 0 : (criterion?.max ?? 5)} className={FIELD_NUM} />
                          <input name="criterionWeight" aria-label="Weight" type="number" step="any" defaultValue={isUnscored ? 0 : (criterion?.weight ?? 1)} className={FIELD_NUM} />
                          <div className="grid gap-1">
                            <textarea name="criterionOptions" aria-label="Dropdown options" rows={1} defaultValue={(criterion?.options ?? []).join("\n")} className={FIELD} placeholder="Accept, Maybe, Reject" />
                            <select name="criterionRemove" aria-label="Row action" defaultValue="" className={FIELD}>
                              <option value="">Keep</option>
                              <option value="remove">Remove</option>
                            </select>
                          </div>
                        </div>
                        {isText ? (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Minimum, maximum, weight, and options are ignored for free-text criteria.
                          </p>
                        ) : isSelect ? (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Minimum, maximum, and weight are ignored for dropdown criteria.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  <p className="text-xs text-gray-500">Keys are stable data identifiers. Choose &quot;Dropdown&quot; and list one option per line (or comma-separated) for a non-numeric criterion — dropdown answers are recorded per review and reported as a distribution, never folded into the numeric average. Choose &quot;Free text&quot; for an optional reviewer comment criterion; its range, weight, and options are ignored. Use the blank row to add a criterion, or set a row to Remove. Rubrics lock after the first submitted review.</p>
                  <button disabled={round.submittedReviews > 0} className={GHOST}>Save rubric</button>
                </form>
                  </div>
                </details>

                <details open className="group border-b border-gray-200 dark:border-gray-700">
                  <summary
                    id={`review-progress-${round.id}`}
                    className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 ${eyebrowClass}`}
                  >
                    <span>Reviewer progress</span>
                    <span aria-hidden="true" className="text-xs text-gray-400 dark:text-gray-500">▾</span>
                  </summary>
                  <div aria-labelledby={`review-progress-${round.id}`} className="px-4 pb-4">
                    {round.progress.expectedReviews === 0 ? (
                      <p className="text-sm text-gray-500">
                        Assign submissions to a team with reviewers to start tracking progress.
                      </p>
                    ) : (
                      <>
                        <div className="grid gap-2 sm:grid-cols-3">
                          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
                            <p className="text-xs text-gray-500">Reviews complete</p>
                            <p className="mt-1 text-2xl font-semibold tabular-nums">{round.progress.completedReviews} / {round.progress.expectedReviews}</p>
                          </div>
                          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
                            <p className="text-xs text-gray-500">Reviews remaining</p>
                            <p className="mt-1 text-2xl font-semibold tabular-nums">{round.progress.remainingReviews}</p>
                          </div>
                          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-950">
                            <p className="text-xs text-gray-500">Reviewers finished</p>
                            <p className="mt-1 text-2xl font-semibold tabular-nums">{round.progress.completedReviewers} / {round.progress.reviewerCount}</p>
                          </div>
                        </div>
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs text-gray-500">
                              <tr>
                                <th scope="col" className="pb-2 pr-4 font-medium">Reviewer</th>
                                <th scope="col" className="pb-2 pr-4 font-medium">Team</th>
                                <th scope="col" className="pb-2 text-right font-medium">Progress</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                              {round.progress.reviewers.map((reviewer) => (
                                <tr key={reviewer.personId}>
                                  <td className="py-2 pr-4">
                                    <span className="font-medium">{reviewer.name ?? reviewer.email}</span>
                                    {reviewer.name ? <span className="block text-xs text-gray-500">{reviewer.email}</span> : null}
                                  </td>
                                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{reviewer.teamNames.join(", ")}</td>
                                  <td className="py-2 text-right font-medium">
                                    {reviewer.completed} / {reviewer.assigned}
                                    <span className={`ml-2 text-xs ${reviewer.remaining === 0 ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}>
                                      {reviewer.remaining === 0 ? "Complete" : `${reviewer.remaining} left`}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                </details>

                <details open className="group border-b border-gray-200 dark:border-gray-700">
                  <summary className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 ${eyebrowClass}`}>
                    <span>Assign submissions</span>
                    <span aria-hidden="true" className="text-xs text-gray-400 dark:text-gray-500">▾</span>
                  </summary>
                  <div className="px-4 pb-4">
                <form method="get" className="mt-3 flex flex-wrap gap-2">
                  <select
                    name="assignTrack"
                    aria-label="Filter assignable abstracts by track"
                    defaultValue={assignTrack ?? ""}
                    className={FIELD}
                  >
                    <option value="">All tracks</option>
                    {tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
                  </select>
                  <button className={GHOST}>Filter by track</button>
                </form>

                <form method="post" className="mt-3 space-y-3">
                  <input type="hidden" name="roundId" value={round.id} />
                  <input type="hidden" name="assignTrack" value={assignTrack ?? ""} />
                  <div className="flex flex-wrap gap-2">
                    <select name="teamId" className={FIELD}>
                      <option value="">Choose team…</option>
                      {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                    <button name="intent" value="assign-team" disabled={!teams.length || !submissions.length} className={BUTTON}>Assign selected</button>
                    <button name="intent" value="assign-all-matching" disabled={!teams.length || !submissions.length} className={GHOST}>Assign all matching</button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select name="personId" className={FIELD}>
                      <option value="">Choose reviewer…</option>
                      {reviewers.map((reviewer) => (
                        <option key={reviewer.id} value={reviewer.id}>{reviewer.name ?? reviewer.email}</option>
                      ))}
                    </select>
                    <button
                      name="intent"
                      value="assign-reviewer"
                      disabled={!reviewers.length || !submissions.length}
                      className={BUTTON}
                    >
                      Assign selected to reviewer
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">
                    Assigning to a named reviewer creates a solo committee for them, so their queue holds exactly these abstracts.
                  </p>
                  <p className={eyebrowClass}>
                    {submissions.length} abstracts available to assign
                  </p>
                  <div className="max-h-[22rem] overflow-y-auto rounded-lg pr-1 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {submissions.map((submission) => (
                      <label key={submission.id} className="flex items-start gap-2.5 rounded-lg border border-gray-200 bg-white p-2.5 text-sm transition hover:border-blue-300 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800 dark:has-[:checked]:bg-blue-950">
                        <input type="checkbox" name="sessionId" value={submission.id} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">{submission.friendlyId ?? "—"}</span>{" "}
                          {submission.title}{" "}
                          <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">{submission.trackName ?? "No track"}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </form>
                  </div>
                </details>

                <details className="group">
                  <summary className={`flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 ${eyebrowClass}`}>
                    <span>Current assignments</span>
                    <span aria-hidden="true" className="text-xs text-gray-400 dark:text-gray-500">▾</span>
                  </summary>
                  <div className="px-4 pb-4">
                  {ownAssignments.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-300 p-5 text-center dark:border-gray-700">
                      <p className="text-sm font-medium">Nothing assigned in this round yet</p>
                      <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">
                        Tick submissions above, choose a team, and they appear here for
                        that team&rsquo;s reviewers.
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-[22rem] overflow-auto rounded-xl border border-gray-200 dark:border-gray-800">
                      <table className="w-full text-left text-sm">
                        <thead
                          className={`sticky top-0 border-b border-gray-200 bg-gray-50 ${eyebrowClass} dark:border-gray-800 dark:bg-gray-950`}
                        >
                          <tr>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Team</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Abstract</th>
                            <th scope="col" className="px-3 py-2">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                          {ownAssignments.map((assignment) => (
                            <tr key={assignment.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                              <td className="px-3 py-2 align-top whitespace-nowrap">{assignment.teamName}</td>
                              <td className="px-3 py-2 align-top">
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">{assignment.friendlyId ?? "—"}</span> {assignment.sessionTitle}
                                {recusals
                                  .filter(
                                    (recusal) =>
                                      recusal.roundId === assignment.roundId &&
                                      recusal.sessionId === assignment.sessionId,
                                  )
                                  .map((recusal) => (
                                    <p key={recusal.reviewerEmail} className="text-xs text-gray-500">
                                      Recused: {recusal.reviewerName ?? recusal.reviewerEmail}
                                    </p>
                                  ))}
                              </td>
                              <td className="px-3 py-2 text-right align-top">
                                <form method="post">
                                  <input type="hidden" name="intent" value="unassign-team" />
                                  <input type="hidden" name="assignmentId" value={assignment.id} />
                                  <button className={GHOST_SM}>Unassign</button>
                                </form>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  </div>
                </details>
              </article>
            );
          })}
          {rounds.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
              {/* The trailing period is asserted by admin.reviews.test.tsx —
                  it is the string the empty state is identified by. */}
              <p className="text-sm font-medium">No review rounds yet.</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
                A round is one pass over the submissions. Name it, give it dates, and
                the rubric and assignment controls appear here.
              </p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export default function AdminReviews({ loaderData, actionData }: Route.ComponentProps) {
  return <ReviewOperationsView {...loaderData} actionData={actionData ?? undefined} />;
}
