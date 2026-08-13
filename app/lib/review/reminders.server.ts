/**
 * The organizer's "chase the lagging reviewers" action (ABS-09).
 *
 * The copy below is a module constant rather than a sixth entry in
 * `TEMPLATE_KEYS`, and that is deliberate: the template registry is the set of
 * emails an admin can EDIT in `/admin/templates`, and this one is an internal
 * nudge to staff, not speaker-facing copy anybody has asked to customise.
 * Registering it would also add a sixth row to a screen whose contract is
 * asserted at five. It still renders through the same pure `renderTemplate` /
 * `mergeContext` helpers, and it still sends through `withCommLog`, so the
 * "every send is logged" property holds exactly as it does for the rest.
 *
 * Recusals are not outstanding work. A reviewer who declared a conflict cannot
 * act on that abstract, so chasing them for it would be noise they can do
 * nothing about — `buildRoundProgress` drops recused assignments from the
 * denominator and this module inherits that.
 */
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import {
  events,
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  sessions,
} from "~/db/schema";
import { withCommLog } from "~/lib/comms/comm-log.server";
import { mergeContext, renderTemplate } from "~/lib/comms/templates";
import { appUrl } from "~/lib/env.server";
import { getMailer } from "~/lib/mail/mailer.server";
import type { Mailer } from "~/lib/mail/mailer";

import { buildRoundProgress } from "./progress";

const REMINDER_SUBJECT = "{{review.count}} review(s) outstanding for {{event.name}}";
const REMINDER_BODY = [
  "Hi {{reviewer.name}},",
  "",
  "You have {{review.count}} review(s) outstanding for {{event.name}} in {{review.round}}.",
  "",
  "Pending abstracts:",
  "{{review.list}}",
  "",
  "Open your review queue:",
  "{{review.url}}",
].join("\n");

export interface ReviewReminderResult {
  candidates: number;
  sent: number;
  failed: number;
  recipients: string[];
}

export async function sendReviewReminders({
  eventId,
  roundId,
  db = getDb(),
  mailer = getMailer(),
  now = new Date(),
  origin,
}: {
  eventId: string;
  roundId: string;
  db?: DB;
  mailer?: Mailer;
  now?: Date;
  origin?: string;
}): Promise<ReviewReminderResult> {
  const [scope] = await db
    .select({
      eventId: events.id,
      eventName: events.name,
      roundId: reviewRounds.id,
      roundName: reviewRounds.name,
    })
    .from(reviewRounds)
    .innerJoin(events, eq(events.id, reviewRounds.eventId))
    .where(and(eq(reviewRounds.id, roundId), eq(reviewRounds.eventId, eventId)))
    .limit(1);
  if (!scope) return { candidates: 0, sent: 0, failed: 0, recipients: [] };

  const [memberRows, assignmentRows, resolvedRows] = await Promise.all([
    db
      .select({
        teamId: reviewTeamMembers.teamId,
        personId: people.id,
        name: people.fullName,
        email: people.email,
      })
      .from(reviewTeamMembers)
      .innerJoin(reviewTeams, eq(reviewTeams.id, reviewTeamMembers.teamId))
      .innerJoin(people, eq(people.id, reviewTeamMembers.personId))
      .where(eq(reviewTeams.eventId, eventId)),
    db
      .select({
        roundId: reviewAssignments.roundId,
        teamId: reviewAssignments.teamId,
        sessionId: reviewAssignments.sessionId,
        sessionTitle: sessions.title,
      })
      .from(reviewAssignments)
      .innerJoin(reviewTeams, eq(reviewTeams.id, reviewAssignments.teamId))
      .innerJoin(sessions, eq(sessions.id, reviewAssignments.sessionId))
      .where(
        and(
          eq(reviewAssignments.roundId, roundId),
          eq(reviewTeams.eventId, eventId),
          eq(sessions.eventId, eventId),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      ),
    db
      .select({
        roundId: reviews.roundId,
        sessionId: reviews.sessionId,
        reviewerId: reviews.reviewerId,
        submittedAt: reviews.submittedAt,
        recusedAt: reviews.recusedAt,
      })
      .from(reviews)
      .innerJoin(sessions, eq(sessions.id, reviews.sessionId))
      .where(
        and(
          eq(reviews.roundId, roundId),
          eq(sessions.eventId, eventId),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
          or(isNotNull(reviews.submittedAt), isNotNull(reviews.recusedAt)),
        ),
      ),
  ]);

  const teamRows = await db
    .select({ id: reviewTeams.id, name: reviewTeams.name })
    .from(reviewTeams)
    .where(eq(reviewTeams.eventId, eventId));
  const progress = buildRoundProgress({
    roundId,
    members: memberRows,
    assignments: assignmentRows,
    submittedReviews: resolvedRows.filter((review) => review.submittedAt !== null),
    excludedReviews: resolvedRows.filter((review) => review.recusedAt !== null),
    teamNames: new Map(teamRows.map((team) => [team.id, team.name])),
  });
  const candidates = progress.reviewers.filter((reviewer) => reviewer.remaining > 0);
  if (candidates.length === 0) {
    return { candidates: 0, sent: 0, failed: 0, recipients: [] };
  }

  const reviewUrl = new URL("/review", origin ?? appUrl(null)).toString();
  const titleById = new Map(
    assignmentRows.map((assignment) => [assignment.sessionId, assignment.sessionTitle]),
  );
  const result: ReviewReminderResult = {
    candidates: candidates.length,
    sent: 0,
    failed: 0,
    recipients: [],
  };

  for (const reviewer of candidates) {
    const context = mergeContext({
      "reviewer.name": reviewer.name ?? reviewer.email,
      "event.name": scope.eventName,
      "review.round": scope.roundName,
      "review.count": String(reviewer.remaining),
      "review.list": (progress.remainingSessionIdsByReviewer.get(reviewer.personId) ?? [])
        .map((sessionId) => `- ${titleById.get(sessionId) ?? "Untitled abstract"}`)
        .join("\n"),
      "review.url": reviewUrl,
    });
    const message = {
      to: reviewer.email,
      subject: renderTemplate(REMINDER_SUBJECT, context),
      text: renderTemplate(REMINDER_BODY, context),
    };
    const loggedMailer = withCommLog(mailer, {
      db,
      now,
      eventId,
      personId: reviewer.personId,
      templateKey: "review_reminder",
      meta: { roundId, outstandingCount: reviewer.remaining },
    });
    const sent = await loggedMailer.send(message);
    result.recipients.push(reviewer.email);
    if (sent.ok) result.sent += 1;
    else result.failed += 1;
  }

  return result;
}
