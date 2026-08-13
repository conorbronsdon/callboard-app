import { isSelectCriterion, type Rubric } from "./scoring";

export interface AggregateReview {
  roundId: string;
  totalScore: number | null;
  submittedAt: Date | string | number | null;
  recusedAt: Date | string | number | null;
}

export interface ReviewAggregate {
  average: number | null;
  reviewCount: number;
}

export interface ChoiceTally {
  option: string;
  count: number;
}

export interface ChoiceSummary {
  key: string;
  label: string;
  tallies: ChoiceTally[];
  modal: string | null;
}

export function rubricWeightTotal(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (total, criterion) => total + (isSelectCriterion(criterion) ? 0 : criterion.weight),
    0,
  );
}

export function reviewAverage(totalScore: number | null, rubric: Rubric): number | null {
  if (totalScore === null) return null;
  const weightTotal = rubricWeightTotal(rubric);
  return weightTotal <= 0 ? null : totalScore / weightTotal;
}

export function choiceSummaries(
  rubric: Rubric,
  reviews: readonly {
    scores?: Record<string, number | string> | null;
    submittedAt: Date | string | number | null;
    recusedAt: Date | string | number | null;
  }[],
): ChoiceSummary[] {
  return rubric.criteria.filter(isSelectCriterion).map((criterion) => {
    const options = criterion.options ?? [];
    const counts = new Map(options.map((option) => [option, 0]));
    for (const review of reviews) {
      if (review.submittedAt === null || review.recusedAt !== null) continue;
      const value = review.scores?.[criterion.key];
      if (typeof value === "string" && counts.has(value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const tallies = options.map((option) => ({ option, count: counts.get(option) ?? 0 }));
    const highest = Math.max(0, ...tallies.map((tally) => tally.count));
    return {
      key: criterion.key,
      label: criterion.label,
      tallies,
      modal: highest === 0 ? null : (tallies.find((tally) => tally.count === highest)?.option ?? null),
    };
  });
}

/**
 * Whether a review is a real, finished, in-scope one. Deliberately says nothing
 * about the rubric's weights: a rubric made only of dropdown criteria weighs 0,
 * so `reviewAverage` is null for every review inside it. Counting only reviews
 * that produced a number is what made a fully reviewed submission report "0
 * reviews" in the CSV and "—" in the submissions list, byte-identical to one
 * nobody had opened.
 */
function isCountedReview(
  review: AggregateReview,
  rubricByRound: ReadonlyMap<string, Rubric>,
): boolean {
  return (
    review.totalScore !== null &&
    review.submittedAt !== null &&
    review.recusedAt === null &&
    rubricByRound.has(review.roundId)
  );
}

function includedAverage(
  review: AggregateReview,
  rubricByRound: ReadonlyMap<string, Rubric>,
): number | null {
  if (!isCountedReview(review, rubricByRound)) return null;
  const rubric = rubricByRound.get(review.roundId);
  return rubric ? reviewAverage(review.totalScore, rubric) : null;
}

export function aggregateFor(
  reviews: readonly AggregateReview[],
  rubricByRound: ReadonlyMap<string, Rubric>,
): ReviewAggregate {
  let total = 0;
  let scoredCount = 0;
  let reviewCount = 0;

  for (const review of reviews) {
    if (!isCountedReview(review, rubricByRound)) continue;
    reviewCount += 1;

    const average = includedAverage(review, rubricByRound);
    if (average === null) continue;
    total += average;
    scoredCount += 1;
  }

  return {
    // The average still comes only from reviews that produced a number; the
    // count is now independent of it, so an unscorable rubric reports a null
    // average against a true count rather than an empty cell.
    average: scoredCount === 0 ? null : total / scoredCount,
    reviewCount,
  };
}

export function aggregateByRound(
  reviews: readonly AggregateReview[],
  rubricByRound: ReadonlyMap<string, Rubric>,
): Map<string, ReviewAggregate> {
  const reviewsByRound = new Map<string, AggregateReview[]>();
  for (const roundId of rubricByRound.keys()) reviewsByRound.set(roundId, []);

  for (const review of reviews) {
    const list = reviewsByRound.get(review.roundId);
    if (list) list.push(review);
  }

  return new Map(
    [...reviewsByRound].map(([roundId, roundReviews]) => [
      roundId,
      aggregateFor(roundReviews, rubricByRound),
    ]),
  );
}
