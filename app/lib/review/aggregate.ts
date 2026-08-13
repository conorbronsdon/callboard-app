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

/**
 * The denominator a reviewer actually sees: every criterion at its maximum,
 * weighted. The submission detail page has always printed "15.0 / 25" from its
 * own inline reduce over `max * weight`; this is that reduce, named, so the
 * list can print the same string. Select criteria parse to max 0 / weight 0 and
 * so contribute nothing to either formula.
 */
export function rubricMaxTotal(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (total, criterion) =>
      total + (isSelectCriterion(criterion) ? 0 : criterion.max * criterion.weight),
    0,
  );
}

/**
 * How far apart two reviewers of the same rubric can possibly land, weighted.
 *
 * NOT the same as `rubricMaxTotal`, and the difference is the whole reason this
 * exists: a criterion scored 90-100 has a maximum of 100 but a span of 10, so
 * describing a ten-point disagreement as "10 of 100" would report total
 * deadlock as a rounding error. Scores are measured against the maximum;
 * disagreements are measured against the span.
 */
export function rubricSpanTotal(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (total, criterion) =>
      total +
      (isSelectCriterion(criterion) ? 0 : (criterion.max - criterion.min) * criterion.weight),
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

/* ------------------------------------------- the weighted view (ABS-10) */

export interface WeightedAggregate {
  /** Mean of the reviewers' weighted totals — the numerator the detail prints. */
  average: number | null;
  /** The shared denominator, or null when there isn't one. */
  max: number | null;
}

const NO_WEIGHTED: WeightedAggregate = { average: null, max: null };

/**
 * The same number, in the same units, as the submission detail page.
 *
 * The list used to print `aggregateFor().average` — a weighted sum divided by
 * the weight total, so a 15-of-25 review rendered as "3.00" — directly beside a
 * detail page reading "15.0 / 25". Nothing was wrong with either number and
 * nothing labelled them, so the pair read as a scoring bug (ABS-10).
 *
 * Returns null for BOTH fields unless every counted review shares one maximum.
 * Reviews from rounds whose rubrics differ have no common denominator, and
 * averaging 15-of-25 with 8-of-10 would print a total against a maximum no
 * rubric has. `aggregateFor().average` stays the cross-round comparable number
 * and remains the sort key; this is the display number.
 */
export function weightedAggregateFor(
  reviews: readonly AggregateReview[],
  rubricByRound: ReadonlyMap<string, Rubric>,
): WeightedAggregate {
  let total = 0;
  let count = 0;
  let max: number | null = null;

  for (const review of reviews) {
    if (!isCountedReview(review, rubricByRound)) continue;
    const rubric = rubricByRound.get(review.roundId);
    if (!rubric) continue;

    const rubricMax = rubricMaxTotal(rubric);
    // An unscorable rubric has no maximum to divide by. The cell keeps its
    // em-dash-plus-count rendering, which is a different fact from "unreviewed".
    if (rubricMax <= 0) return NO_WEIGHTED;
    if (max === null) max = rubricMax;
    else if (max !== rubricMax) return NO_WEIGHTED;

    total += review.totalScore ?? 0;
    count += 1;
  }

  return count === 0 || max === null ? NO_WEIGHTED : { average: total / count, max };
}

/* ----------------------------------------------------- disagreement */

/**
 * How far apart reviewers must land before a row is worth an agenda slot, as a
 * FRACTION of what the rubric makes possible.
 *
 * A fixed number of points cannot work here. An organizer may build any 0-100
 * range (`review-operations.ts` enforces only `min < max`), so "1.5 points
 * apart" is total deadlock on a 0-1 rubric, unreachable on it in fact, and
 * noise on a 0-100 one. Three eighths of the span is the same threshold the
 * seeded 1-5 rubrics started with — a gap of 1.5 on a span of 4 — and it now
 * means the same thing on every rubric instead of only on those.
 *
 * Advisory only: nothing about a submission's status depends on it.
 */
export const CONTESTED_FRACTION = 0.375;

export interface Disagreement {
  /**
   * Widest gap between two reviewers of the SAME round, on the criterion scale.
   * Null when no single round has two counted, numeric reviews.
   */
  gap: number | null;
  /** The same spread in that round's weighted points, for display. */
  gapWeighted: number | null;
  /** The widest gap that round's rubric ALLOWS, weighted — the honest denominator. */
  weightedSpan: number | null;
  /** `gap` as a fraction of what the rubric allows: comparable across rubrics. */
  severity: number | null;
  /** Counted reviews in the round the gap came from; 0 when there is no gap. */
  reviewCount: number;
  /** Which round produced it, for the badge's tooltip. */
  roundId: string | null;
}

const NO_DISAGREEMENT: Disagreement = {
  gap: null,
  gapWeighted: null,
  weightedSpan: null,
  severity: null,
  reviewCount: 0,
  roundId: null,
};

/**
 * Reviewer disagreement, per submission.
 *
 * THE METRIC: max minus min of the per-reviewer averages — the plain range —
 * computed WITHIN a single round and never across rounds, reporting whichever
 * round is widest.
 *
 * Why the range and not a standard deviation: a committee has two or three
 * reviewers per abstract. At n = 2 the two differ only by a constant factor; at
 * n = 3 the answer depends on a population-versus-sample choice that no
 * organizer can audit from the badge. The range is the number a human reads off
 * the row ("she said 5, he said 2"), and it is the number this file can pin to
 * hand-computed fixtures.
 *
 * Why within a round: two rounds scoring a submission differently is the
 * committee changing its mind between rounds, which is progression, not
 * dispute — and their rubrics may not even share a scale. `isCountedReview`
 * supplies the same recusal/draft/unknown-round exclusions the averages use, so
 * a recusal can never manufacture a disagreement.
 */
export function disagreementFor(
  reviews: readonly AggregateReview[],
  rubricByRound: ReadonlyMap<string, Rubric>,
): Disagreement {
  const byRound = new Map<string, number[]>();
  for (const review of reviews) {
    const average = includedAverage(review, rubricByRound);
    if (average === null) continue;
    const list = byRound.get(review.roundId) ?? [];
    list.push(average);
    byRound.set(review.roundId, list);
  }

  let widest = NO_DISAGREEMENT;
  for (const [roundId, averages] of byRound) {
    if (averages.length < 2) continue;

    const rubric = rubricByRound.get(roundId) as Rubric;
    const weightTotal = rubricWeightTotal(rubric);
    const weightedSpan = rubricSpanTotal(rubric);
    // A rubric nobody can disagree within (every criterion pinned to one value)
    // has no denominator, so it raises no dispute rather than dividing by zero.
    if (weightTotal <= 0 || weightedSpan <= 0) continue;

    const gap = Math.max(...averages) - Math.min(...averages);
    const severity = gap / (weightedSpan / weightTotal);
    /*
     * Rounds are ranked by SEVERITY, not by raw gap. Ranking by points would
     * let five points of quibbling on a 0-100 round outrank a first round whose
     * panel disagreed as completely as its 1-5 rubric permits.
     */
    if (widest.severity !== null && severity <= widest.severity) continue;

    widest = {
      gap,
      // Back to the units the row prints. `includedAverage` divided by the
      // weight total, so multiplying by it recovers the weighted spread exactly.
      gapWeighted: gap * weightTotal,
      weightedSpan,
      severity,
      reviewCount: averages.length,
      roundId,
    };
  }

  return widest;
}

export function isContested(disagreement: Disagreement): boolean {
  return disagreement.severity !== null && disagreement.severity >= CONTESTED_FRACTION;
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
