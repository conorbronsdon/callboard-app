import type { SessionStatus } from "~/db/schema";
import { csvDocument } from "~/lib/integrations/accelevents-csv";
import {
  aggregateByRound,
  aggregateFor,
  choiceSummaries,
  type AggregateReview,
} from "./aggregate";
import { tabFor } from "./pipeline";
import { isSelectCriterion, isTextCriterion, type Rubric } from "./scoring";

export interface ScoreExportRound {
  id: string;
  name: string;
  rubric: Rubric;
}

/** A review row for export: the aggregate fields, plus the human parts the
 *  organizer-facing CSV is allowed to carry. */
export interface ScoreExportReview extends AggregateReview {
  reviewerName?: string | null;
  comment?: string | null;
  /** Raw per-criterion answers used by dropdown tallies and free-text columns. */
  scores?: Record<string, number | string> | null;
}

export interface ScoreExportSubmission {
  friendlyId: string | null;
  title: string;
  trackName: string | null;
  status: SessionStatus;
  reviews: readonly ScoreExportReview[];
  /**
   * The advisory AI first pass, if there is one. Deliberately its OWN pair of
   * trailing columns: it is never summed into `Reviews`, `Aggregate score` or
   * any per-round column, and it arrives on a separate field so a spreadsheet
   * sort on "Aggregate score" can never pick up a model's opinion by accident.
   */
  aiTriage?: { score: number | null; recommendation: string | null } | null;
}

function formattedScore(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export function buildScoreCsv(
  submissions: readonly ScoreExportSubmission[],
  rounds: readonly ScoreExportRound[],
): string {
  const rubricByRound = new Map(rounds.map((round) => [round.id, round.rubric] as const));
  const ordered = [...submissions].sort(
    (left, right) =>
      (left.friendlyId ?? "").localeCompare(right.friendlyId ?? "") ||
      left.title.localeCompare(right.title),
  );
  const choiceColumns = rounds.flatMap((round) =>
    round.rubric.criteria
      .filter(isSelectCriterion)
      .map((criterion) => ({ round, criterion })),
  );
  const textColumns = rounds.flatMap((round) =>
    round.rubric.criteria
      .filter(isTextCriterion)
      .map((criterion) => ({ round, criterion })),
  );

  return csvDocument(
    [
      "ID",
      "Title",
      "Track",
      "Status",
      "Reviews",
      "Aggregate score",
      ...rounds.map((round) => round.name),
      ...choiceColumns.map(({ round, criterion }) => `${round.name} — ${criterion.label}`),
      ...textColumns.map(({ round, criterion }) => `${round.name} — ${criterion.label}`),
      "Reviewer comments",
      // LAST, and named so nobody mistakes them for committee columns. Every
      // human column — counts, aggregates, per-round averages, dropdown
      // distributions, free text and reviewer comments (CFP-11) — is to the
      // left of this pair and computed without it.
      "AI triage score (advisory)",
      "AI triage recommendation (advisory)",
    ],
    ordered.map((submission) => {
      const aggregate = aggregateFor(submission.reviews, rubricByRound);
      const byRound = aggregateByRound(submission.reviews, rubricByRound);
      const roundOrder = new Map(rounds.map((round, index) => [round.id, index] as const));
      const roundNames = new Map(rounds.map((round) => [round.id, round.name] as const));
      const comments = submission.reviews
        .filter(
          (review) =>
            review.submittedAt !== null &&
            review.recusedAt === null &&
            (review.comment ?? "").trim() !== "",
        )
        .sort(
          (left, right) =>
            (roundOrder.get(left.roundId) ?? rounds.length) -
              (roundOrder.get(right.roundId) ?? rounds.length) ||
            (left.reviewerName || "Unknown reviewer").localeCompare(
              right.reviewerName || "Unknown reviewer",
            ),
        )
        .map(
          (review) =>
            `${review.reviewerName || "Unknown reviewer"} (${roundNames.get(review.roundId) ?? review.roundId}): ${review.comment!.trim()}`,
        )
        .join(" | ");
      return [
        submission.friendlyId,
        submission.title,
        submission.trackName,
        tabFor(submission.status).label,
        aggregate.reviewCount,
        formattedScore(aggregate.average),
        ...rounds.map((round) => formattedScore(byRound.get(round.id)?.average ?? null)),
        ...choiceColumns.map(({ round, criterion }) => {
          const summary = choiceSummaries(
            round.rubric,
            submission.reviews.filter((review) => review.roundId === round.id),
          ).find((choice) => choice.key === criterion.key);
          return (summary?.tallies ?? [])
            .filter((tally) => tally.count > 0)
            .map((tally) => `${tally.option} ×${tally.count}`)
            .join("; ");
        }),
        ...textColumns.map(({ round, criterion }) =>
          submission.reviews
            .filter(
              (review) =>
                review.roundId === round.id &&
                review.submittedAt !== null &&
                review.recusedAt === null &&
                typeof review.scores?.[criterion.key] === "string" &&
                String(review.scores[criterion.key]).trim() !== "",
            )
            .sort(
              (left, right) =>
                (roundOrder.get(left.roundId) ?? rounds.length) -
                  (roundOrder.get(right.roundId) ?? rounds.length) ||
                (left.reviewerName || "Unknown reviewer").localeCompare(
                  right.reviewerName || "Unknown reviewer",
                ),
            )
            .map(
              (review) =>
                `${review.reviewerName || "Unknown reviewer"} (${roundNames.get(review.roundId) ?? review.roundId}): ${String(review.scores?.[criterion.key]).trim()}`,
            )
            .join(" | "),
        ),
        comments,
        submission.aiTriage?.score ?? "",
        submission.aiTriage?.recommendation ?? "",
      ];
    }),
  );
}
