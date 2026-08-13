import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { chunkForBind, getDb } from "~/db/client.server";
import { aiTriage, people, reviewRounds, reviews, sessions, tracks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import { buildScoreCsv } from "~/lib/review/score-export";
import { parseRubric } from "~/lib/review/scoring";
import type { Route } from "./+types/admin.submissions.scores.csv";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();

  const [submissionRows, roundRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        friendlyId: sessions.friendlyId,
        title: sessions.title,
        trackName: tracks.name,
        status: sessions.status,
      })
      .from(sessions)
      .leftJoin(tracks, eq(tracks.id, sessions.trackId))
      .where(
        and(
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, true),
          isNull(sessions.deletedAt),
        ),
      )
      .orderBy(asc(sessions.friendlyId), asc(sessions.title)),
    db
      .select({
        id: reviewRounds.id,
        name: reviewRounds.name,
        rubric: reviewRounds.rubric,
      })
      .from(reviewRounds)
      .where(eq(reviewRounds.eventId, event.id))
      .orderBy(asc(reviewRounds.ordinal)),
  ]);

  const ids = submissionRows.map((submission) => submission.id);
  const reviewRows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select({
            roundId: reviews.roundId,
            sessionId: reviews.sessionId,
            scores: reviews.scores,
            totalScore: reviews.totalScore,
            submittedAt: reviews.submittedAt,
            recusedAt: reviews.recusedAt,
            comment: reviews.comment,
            reviewerName: people.fullName,
          })
          .from(reviews)
          .innerJoin(reviewRounds, eq(reviewRounds.id, reviews.roundId))
          .leftJoin(people, eq(people.id, reviews.reviewerId))
          .where(
            and(
              inArray(reviews.sessionId, chunk),
              eq(reviewRounds.eventId, event.id),
            ),
          ),
      ),
    )
  ).flat();

  const reviewsBySession = new Map<string, typeof reviewRows>();
  for (const review of reviewRows) {
    const list = reviewsBySession.get(review.sessionId) ?? [];
    list.push(review);
    reviewsBySession.set(review.sessionId, list);
  }

  /*
   * A SEPARATE query into a SEPARATE map, joined to the row only at the point
   * where the advisory columns are written. It is never merged into
   * `reviewsBySession`, so `aggregateFor` cannot see it.
   */
  const triageRows = await db
    .select({
      sessionId: aiTriage.sessionId,
      score: aiTriage.score,
      recommendation: aiTriage.recommendation,
      status: aiTriage.status,
    })
    .from(aiTriage)
    .where(eq(aiTriage.eventId, event.id));
  const triageBySession = new Map(
    triageRows
      .filter((row) => row.status === "ok")
      .map((row) => [row.sessionId, { score: row.score, recommendation: row.recommendation }]),
  );

  const csv = buildScoreCsv(
    submissionRows.map((submission) => ({
      friendlyId: submission.friendlyId,
      title: submission.title,
      trackName: submission.trackName,
      status: submission.status,
      reviews: reviewsBySession.get(submission.id) ?? [],
      aiTriage: triageBySession.get(submission.id) ?? null,
    })),
    roundRows.map((round) => ({
      id: round.id,
      name: round.name,
      rubric: parseRubric(round.rubric),
    })),
  );

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${event.slug}-review-scores.csv"`,
      "cache-control": "no-store",
    },
  });
}
