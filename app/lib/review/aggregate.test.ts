import { describe, expect, it } from "vitest";

import {
  CONTESTED_FRACTION,
  aggregateByRound,
  aggregateFor,
  choiceSummaries,
  disagreementFor,
  isContested,
  reviewAverage,
  rubricMaxTotal,
  rubricSpanTotal,
  rubricWeightTotal,
  weightedAggregateByRound,
  weightedAggregateFor,
} from "./aggregate";
import { scoreRubric, type Rubric } from "./scoring";

const WEIGHTED_RUBRIC: Rubric = {
  criteria: [
    { key: "originality", label: "Originality", min: 1, max: 5, weight: 2 },
    { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
  ],
};

const ROUND_ONE = "round-one";
const ROUND_TWO = "round-two";

describe("review score aggregates", () => {
  it("converts a weighted sum back to the criterion scale", () => {
    const scored = scoreRubric(WEIGHTED_RUBRIC, { originality: 4, relevance: 2 });
    expect(scored.ok).toBe(true);
    if (!scored.ok) throw new Error(scored.error);

    expect(rubricWeightTotal(WEIGHTED_RUBRIC)).toBe(3);
    expect(scored.totalScore).toBe(10);
    expect(reviewAverage(scored.totalScore, WEIGHTED_RUBRIC)).toBeCloseTo(10 / 3);
    expect(reviewAverage(scored.totalScore, WEIGHTED_RUBRIC)).not.toBe(3);
    expect(reviewAverage(null, WEIGHTED_RUBRIC)).toBeNull();
  });

  it("averages genuine submitted reviews across rounds", () => {
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, WEIGHTED_RUBRIC],
    ]);
    const rows = [
      {
        roundId: ROUND_ONE,
        totalScore: 10,
        submittedAt: new Date("2026-08-12T12:00:00Z"),
        recusedAt: null,
      },
      {
        roundId: ROUND_TWO,
        totalScore: 15,
        submittedAt: new Date("2026-08-12T13:00:00Z"),
        recusedAt: null,
      },
    ];

    expect(aggregateFor(rows, rubricByRound)).toEqual({
      average: (10 / 3 + 5) / 2,
      reviewCount: 2,
    });
    expect(aggregateByRound(rows, rubricByRound)).toEqual(
      new Map([
        [ROUND_ONE, { average: 10 / 3, reviewCount: 1 }],
        [ROUND_TWO, { average: 5, reviewCount: 1 }],
      ]),
    );
  });

  it("excludes null scores, recusals, unsubmitted rows, and unknown rounds", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    const rows = [
      {
        roundId: ROUND_ONE,
        totalScore: 12,
        submittedAt: new Date("2026-08-12T12:00:00Z"),
        recusedAt: null,
      },
      {
        roundId: ROUND_ONE,
        totalScore: null,
        submittedAt: new Date("2026-08-12T12:01:00Z"),
        recusedAt: null,
      },
      {
        roundId: ROUND_ONE,
        totalScore: 15,
        submittedAt: new Date("2026-08-12T12:02:00Z"),
        recusedAt: new Date("2026-08-12T12:03:00Z"),
      },
      { roundId: ROUND_ONE, totalScore: 15, submittedAt: null, recusedAt: null },
      {
        roundId: "unknown-round",
        totalScore: 15,
        submittedAt: new Date("2026-08-12T12:04:00Z"),
        recusedAt: null,
      },
    ];

    expect(aggregateFor(rows, rubricByRound)).toEqual({ average: 4, reviewCount: 1 });
    expect(aggregateByRound(rows, rubricByRound).get(ROUND_ONE)).toEqual({
      average: 4,
      reviewCount: 1,
    });
  });

  it("MUST FIRE: an all-dropdown rubric reports the true review count with a null average", () => {
    /*
     * The rubric a legacy round can hold and `parseRubricEditor` used to
     * accept: every criterion is a select, so `rubricWeightTotal` is 0 and no
     * review can produce a number. The count must still be the number of
     * reviews, because that is what the Reviews screen and the reviewer both
     * see — the CSV writing 0 here made a fully reviewed submission look
     * untouched.
     */
    const selectOnly: Rubric = {
      criteria: [
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Reject"],
        },
      ],
    };
    const rubricByRound = new Map([[ROUND_ONE, selectOnly]]);
    expect(rubricWeightTotal(selectOnly)).toBe(0);

    const rows = [
      {
        roundId: ROUND_ONE,
        totalScore: 0,
        submittedAt: new Date("2026-08-12T12:00:00Z"),
        recusedAt: null,
      },
      {
        roundId: ROUND_ONE,
        totalScore: 0,
        submittedAt: new Date("2026-08-12T12:05:00Z"),
        recusedAt: null,
      },
    ];

    expect(aggregateFor(rows, rubricByRound)).toEqual({ average: null, reviewCount: 2 });
    expect(aggregateByRound(rows, rubricByRound).get(ROUND_ONE)).toEqual({
      average: null,
      reviewCount: 2,
    });
  });

  it("MUST NOT FIRE: an unscorable rubric does not start counting recusals, drafts, or foreign rounds", () => {
    const selectOnly: Rubric = {
      criteria: [
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Reject"],
        },
      ],
    };
    const rubricByRound = new Map([[ROUND_ONE, selectOnly]]);
    const at = (minute: number) => new Date(`2026-08-12T12:0${minute}:00Z`);

    expect(
      aggregateFor(
        [
          { roundId: ROUND_ONE, totalScore: 0, submittedAt: at(1), recusedAt: at(2) },
          { roundId: ROUND_ONE, totalScore: 0, submittedAt: null, recusedAt: null },
          { roundId: ROUND_ONE, totalScore: null, submittedAt: at(3), recusedAt: null },
          { roundId: "unknown-round", totalScore: 0, submittedAt: at(4), recusedAt: null },
        ],
        rubricByRound,
      ),
    ).toEqual({ average: null, reviewCount: 0 });
  });

  it("MUST FIRE: a mixed rubric keeps counting only the reviews it averages", () => {
    // The complement of the case above: when the weights are real, decoupling
    // the count must not inflate it — a null-score row still does not count.
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    expect(
      aggregateFor(
        [
          {
            roundId: ROUND_ONE,
            totalScore: 12,
            submittedAt: new Date("2026-08-12T12:00:00Z"),
            recusedAt: null,
          },
          {
            roundId: ROUND_ONE,
            totalScore: null,
            submittedAt: new Date("2026-08-12T12:01:00Z"),
            recusedAt: null,
          },
        ],
        rubricByRound,
      ),
    ).toEqual({ average: 4, reviewCount: 1 });
  });

  it("returns the explicit unscored state", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    expect(aggregateFor([], rubricByRound)).toEqual({ average: null, reviewCount: 0 });
    expect(aggregateByRound([], rubricByRound).get(ROUND_ONE)).toEqual({
      average: null,
      reviewCount: 0,
    });
  });

  it("must fire: tallies every dropdown option and breaks modal ties by rubric order", () => {
    const rubric: Rubric = {
      criteria: [
        ...WEIGHTED_RUBRIC.criteria,
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Maybe", "Reject"],
        },
      ],
    };
    const included = (value: string) => ({
      scores: { recommendation: value },
      submittedAt: new Date("2026-08-12T12:00:00Z"),
      recusedAt: null,
    });
    const summaries = choiceSummaries(rubric, [
      included("Accept"),
      included("Maybe"),
      included("Unknown"),
      { ...included("Accept"), submittedAt: null },
      { ...included("Maybe"), recusedAt: new Date("2026-08-12T13:00:00Z") },
    ]);

    expect(summaries).toEqual([
      {
        key: "recommendation",
        label: "Recommendation",
        tallies: [
          { option: "Accept", count: 1 },
          { option: "Maybe", count: 1 },
          { option: "Reject", count: 0 },
        ],
        modal: "Accept",
      },
    ]);
  });

  it("must NOT fire: empty and numeric-only choices produce no modal or summaries", () => {
    const selectOnly: Rubric = {
      criteria: [
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Reject"],
        },
      ],
    };

    expect(choiceSummaries(selectOnly, [])).toEqual([
      {
        key: "recommendation",
        label: "Recommendation",
        tallies: [
          { option: "Accept", count: 0 },
          { option: "Reject", count: 0 },
        ],
        modal: null,
      },
    ]);
    expect(choiceSummaries(WEIGHTED_RUBRIC, [])).toEqual([]);
    expect(reviewAverage(0, selectOnly)).toBeNull();
  });

  it("must fire: free text cannot move totals or become a choice summary", () => {
    const textCriterion = {
      key: "reviewer_note",
      label: "Reviewer note",
      min: -50,
      max: 100,
      weight: 7,
      type: "text" as const,
    };
    const withText: Rubric = {
      criteria: [...WEIGHTED_RUBRIC.criteria, textCriterion],
    };
    const selectOnly: Rubric = {
      criteria: [
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select",
          options: ["Accept", "Reject"],
        },
      ],
    };
    const selectAndText: Rubric = {
      criteria: [...selectOnly.criteria, textCriterion],
    };

    expect(rubricWeightTotal(withText)).toBe(rubricWeightTotal(WEIGHTED_RUBRIC));
    expect(rubricMaxTotal(withText)).toBe(rubricMaxTotal(WEIGHTED_RUBRIC));
    expect(rubricSpanTotal(withText)).toBe(rubricSpanTotal(WEIGHTED_RUBRIC));
    expect(choiceSummaries(selectAndText, [])).toEqual(choiceSummaries(selectOnly, []));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Weighted presentation (ABS-10) and reviewer disagreement.
 *
 * `WEIGHTED_RUBRIC` above: originality ×2 and relevance ×1, both scored 1-5.
 * So its weight total is 3 and its MAX total is 5×2 + 5×1 = 15, and every
 * number below is hand-computed against those two constants.
 */
const BALANCED_RUBRIC: Rubric = {
  criteria: [
    { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
    { key: "depth", label: "Depth", min: 1, max: 5, weight: 1 },
  ],
};

const SELECT_ONLY: Rubric = {
  criteria: [
    {
      key: "recommendation",
      label: "Recommendation",
      min: 0,
      max: 0,
      weight: 0,
      type: "select",
      options: ["Accept", "Reject"],
    },
  ],
};

const submitted = (roundId: string, totalScore: number | null, extra = {}) => ({
  roundId,
  totalScore,
  submittedAt: new Date("2026-08-12T12:00:00Z"),
  recusedAt: null,
  ...extra,
});

describe("weighted aggregate (the number the detail page prints)", () => {
  it("MUST FIRE: per-round values stay in weighted points rather than criterion averages", () => {
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, WEIGHTED_RUBRIC],
    ]);
    const rows = [
      submitted(ROUND_ONE, 12),
      submitted(ROUND_ONE, 6),
      submitted(ROUND_TWO, 15),
    ];

    expect(aggregateByRound(rows, rubricByRound).get(ROUND_ONE)?.average).toBe(3);
    expect(weightedAggregateByRound(rows, rubricByRound)).toEqual(
      new Map([
        [ROUND_ONE, { average: 9, max: 15 }],
        [ROUND_TWO, { average: 15, max: 15 }],
      ]),
    );
  });

  it("MUST NOT FIRE: per-round weighting excludes recusals, drafts and foreign rounds", () => {
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, WEIGHTED_RUBRIC],
    ]);
    const rows = [
      submitted(ROUND_ONE, 9),
      submitted(ROUND_ONE, 15, { recusedAt: new Date("2026-08-12T12:01:00Z") }),
      { roundId: ROUND_ONE, totalScore: 15, submittedAt: null, recusedAt: null },
      submitted("foreign-round", 15),
      submitted(ROUND_TWO, null),
    ];

    expect(weightedAggregateByRound(rows, rubricByRound)).toEqual(
      new Map([
        [ROUND_ONE, { average: 9, max: 15 }],
        [ROUND_TWO, { average: null, max: null }],
      ]),
    );
  });

  it("MUST FIRE: averages the reviewers' weighted totals over the rubric's own maximum", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);

    expect(rubricMaxTotal(WEIGHTED_RUBRIC)).toBe(15);
    expect(
      weightedAggregateFor([submitted(ROUND_ONE, 15), submitted(ROUND_ONE, 9)], rubricByRound),
    ).toEqual({ average: 12, max: 15 });
    // A single review is its own average, so list and detail print one string.
    expect(weightedAggregateFor([submitted(ROUND_ONE, 10)], rubricByRound)).toEqual({
      average: 10,
      max: 15,
    });
  });

  it("MUST FIRE: the maximum matches the detail page's own reduce, select criteria included", () => {
    /*
     * The detail page computes `criteria.reduce((sum, c) => sum + c.max * c.weight, 0)`
     * over EVERY criterion. Select criteria parse to max 0 / weight 0, so the
     * two formulas must agree — this is the assertion that keeps the list's
     * denominator equal to the detail page's after either side is edited.
     */
    const mixed: Rubric = { criteria: [...WEIGHTED_RUBRIC.criteria, ...SELECT_ONLY.criteria] };
    const detailFormula = (rubric: Rubric) =>
      rubric.criteria.reduce((sum, criterion) => sum + criterion.max * criterion.weight, 0);

    for (const rubric of [WEIGHTED_RUBRIC, BALANCED_RUBRIC, SELECT_ONLY, mixed]) {
      expect(rubricMaxTotal(rubric)).toBe(detailFormula(rubric));
    }
    expect(rubricMaxTotal(mixed)).toBe(15);
    expect(rubricMaxTotal(SELECT_ONLY)).toBe(0);

    /*
     * MUST NOT FIRE: a dropdown criterion contributes nothing even when it
     * arrives carrying a max and a weight. `parseRubric` zeroes both, so every
     * rubric loaded from the database makes the select branch look redundant —
     * this is the fixture that makes it load-bearing, and it is deliberately
     * hand-built rather than parsed. `rubricWeightTotal` has always behaved
     * this way; the maximum has to agree with it or the two halves of the same
     * fraction would count different criteria.
     */
    const unparsedSelect: Rubric = {
      criteria: [
        { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
        {
          key: "recommendation",
          label: "Recommendation",
          min: 1,
          max: 5,
          weight: 2,
          type: "select",
          options: ["Accept", "Reject"],
        },
      ],
    };
    expect(rubricWeightTotal(unparsedSelect)).toBe(1);
    expect(rubricMaxTotal(unparsedSelect)).toBe(5);
    expect(rubricMaxTotal(unparsedSelect)).not.toBe(detailFormula(unparsedSelect));
  });

  it("MUST NOT FIRE: no shared denominator means no weighted number, never a blended one", () => {
    // Round one is out of 15 and round two out of 10. Averaging 15 and 10 would
    // print a total against a maximum no rubric has.
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, BALANCED_RUBRIC],
    ]);
    expect(
      weightedAggregateFor([submitted(ROUND_ONE, 15), submitted(ROUND_TWO, 10)], rubricByRound),
    ).toEqual({ average: null, max: null });

    // An unscorable rubric has no maximum to divide by, and an empty list has
    // no reviews — both stay the explicit unscored state.
    expect(
      weightedAggregateFor([submitted(ROUND_ONE, 0)], new Map([[ROUND_ONE, SELECT_ONLY]])),
    ).toEqual({ average: null, max: null });
    expect(weightedAggregateFor([], rubricByRound)).toEqual({ average: null, max: null });
  });

  it("MUST NOT FIRE: recusals, drafts and foreign rounds stay out of the weighted number", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    const rows = [
      submitted(ROUND_ONE, 9),
      submitted(ROUND_ONE, 15, { recusedAt: new Date("2026-08-12T12:01:00Z") }),
      { roundId: ROUND_ONE, totalScore: 15, submittedAt: null, recusedAt: null },
      submitted(ROUND_TWO, 15),
      submitted(ROUND_ONE, null),
    ];
    expect(weightedAggregateFor(rows, rubricByRound)).toEqual({ average: 9, max: 15 });
  });
});

describe("reviewer disagreement", () => {
  it("MUST FIRE: two reviewers a full band apart report the spread in both scales", () => {
    // 15/15 is 5.00 on the criterion scale, 6/15 is 2.00. Gap 3.00, or 9 of 15.
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    expect(
      disagreementFor([submitted(ROUND_ONE, 15), submitted(ROUND_ONE, 6)], rubricByRound),
    ).toEqual({
      gap: 3,
      gapWeighted: 9,
      weightedSpan: 12,
      severity: 0.75,
      reviewCount: 2,
      roundId: ROUND_ONE,
    });
  });

  it("MUST FIRE: three reviewers report max minus min, not the adjacent gaps", () => {
    // 5.00, 3.00, 2.00 — the widest pair is 3.00 apart. A mean-of-gaps metric
    // would report 1.50 here and quietly halve every three-reviewer panel.
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    const result = disagreementFor(
      [submitted(ROUND_ONE, 15), submitted(ROUND_ONE, 9), submitted(ROUND_ONE, 6)],
      rubricByRound,
    );
    expect(result).toEqual({
      gap: 3,
      gapWeighted: 9,
      weightedSpan: 12,
      severity: 0.75,
      reviewCount: 3,
      roundId: ROUND_ONE,
    });
    expect(isContested(result)).toBe(true);
  });

  it("pins the threshold at both sides of its boundary", () => {
    // BALANCED_RUBRIC weighs 2 and maxes at 10, so a 1.50 criterion-scale gap
    // is exactly 3 weighted points: 10/10 = 5.00 against 7/10 = 3.50.
    const rubricByRound = new Map([[ROUND_ONE, BALANCED_RUBRIC]]);
    const atThreshold = disagreementFor(
      [submitted(ROUND_ONE, 10), submitted(ROUND_ONE, 7)],
      rubricByRound,
    );
    expect(atThreshold.gap).toBe(1.5);
    expect(CONTESTED_FRACTION).toBe(0.375);
    expect(atThreshold.severity).toBe(CONTESTED_FRACTION);
    expect(isContested(atThreshold)).toBe(true);

    // 8/10 = 4.00 against 10/10 = 5.00 is 1.00 apart: reviewers who broadly
    // agree must not be sent to the committee call as a dispute.
    const below = disagreementFor(
      [submitted(ROUND_ONE, 10), submitted(ROUND_ONE, 8)],
      rubricByRound,
    );
    expect(below.gap).toBe(1);
    expect(isContested(below)).toBe(false);
  });

  it("MUST NOT FIRE: one review is not a disagreement", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    const single = disagreementFor([submitted(ROUND_ONE, 15)], rubricByRound);
    expect(single).toEqual({
      gap: null,
      gapWeighted: null,
      weightedSpan: null,
      severity: null,
      reviewCount: 0,
      roundId: null,
    });
    expect(isContested(single)).toBe(false);
    expect(isContested(disagreementFor([], rubricByRound))).toBe(false);
  });

  it("MUST NOT FIRE: two reviews in DIFFERENT rounds are a progression, not a dispute", () => {
    // Round one scored it 5.00 and round two scored it 2.00. That is the
    // committee changing its mind between rounds; comparing across rubrics is
    // exactly the arithmetic this metric refuses to do.
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, WEIGHTED_RUBRIC],
    ]);
    expect(
      disagreementFor([submitted(ROUND_ONE, 15), submitted(ROUND_TWO, 6)], rubricByRound).gap,
    ).toBeNull();
  });

  it("MUST FIRE: with several rounds in play it reports the widest single round", () => {
    const rubricByRound = new Map([
      [ROUND_ONE, WEIGHTED_RUBRIC],
      [ROUND_TWO, WEIGHTED_RUBRIC],
    ]);
    const result = disagreementFor(
      [
        submitted(ROUND_ONE, 15),
        submitted(ROUND_ONE, 12), // 5.00 vs 4.00 → 1.00
        submitted(ROUND_TWO, 15),
        submitted(ROUND_TWO, 6), // 5.00 vs 2.00 → 3.00
      ],
      rubricByRound,
    );
    expect(result).toEqual({
      gap: 3,
      gapWeighted: 9,
      weightedSpan: 12,
      severity: 0.75,
      reviewCount: 2,
      roundId: ROUND_TWO,
    });
  });

  it("MUST NOT FIRE: recusals, drafts, null scores and unscorable rubrics raise no dispute", () => {
    const rubricByRound = new Map([[ROUND_ONE, WEIGHTED_RUBRIC]]);
    // One genuine 5.00 review beside three rows that must not count.
    expect(
      disagreementFor(
        [
          submitted(ROUND_ONE, 15),
          submitted(ROUND_ONE, 3, { recusedAt: new Date("2026-08-12T12:01:00Z") }),
          { roundId: ROUND_ONE, totalScore: 3, submittedAt: null, recusedAt: null },
          submitted(ROUND_ONE, null),
        ],
        rubricByRound,
      ).gap,
    ).toBeNull();

    // Two real reviews under a rubric that cannot produce a number at all.
    expect(
      disagreementFor(
        [submitted(ROUND_ONE, 0), submitted(ROUND_ONE, 0)],
        new Map([[ROUND_ONE, SELECT_ONLY]]),
      ),
    ).toEqual({
      gap: null,
      gapWeighted: null,
      weightedSpan: null,
      severity: null,
      reviewCount: 0,
      roundId: null,
    });
  });
});

/*
 * ─────────────────────────────────── disagreement across unfamiliar rubrics ──
 *
 * `review-operations.ts` accepts any 0-100 range with `min < max` and any
 * weight up to 10, so the seeded 1-5 rubrics are a convention, not a contract.
 * A threshold expressed in POINTS is therefore unusable: 1.5 points cannot be
 * reached at all on a 0-1 rubric, and is noise on a 0-100 one. These are the
 * counterexamples that forced the metric to be a fraction of the span.
 */
const NARROW_RUBRIC: Rubric = {
  criteria: [{ key: "yes", label: "Include", min: 0, max: 1, weight: 1 }],
};

const WIDE_RUBRIC: Rubric = {
  criteria: [{ key: "score", label: "Overall", min: 0, max: 100, weight: 1 }],
};

const OFFSET_RUBRIC: Rubric = {
  criteria: [{ key: "band", label: "Band", min: 90, max: 100, weight: 1 }],
};

describe("disagreement is measured against what the rubric allows", () => {
  it("MUST FIRE: total deadlock on a 0-1 rubric is contested", () => {
    // One reviewer said 0, the other said 1. There is no wider disagreement
    // this rubric can express, and a fixed 1.5-point threshold could never see
    // it: the whole scale is one point wide.
    const rubricByRound = new Map([[ROUND_ONE, NARROW_RUBRIC]]);
    const result = disagreementFor(
      [submitted(ROUND_ONE, 1), submitted(ROUND_ONE, 0)],
      rubricByRound,
    );

    expect(result.gap).toBe(1);
    expect(result.severity).toBe(1);
    expect(isContested(result)).toBe(true);
  });

  it("MUST NOT FIRE: 1.5 points apart on a 0-100 rubric is agreement", () => {
    // 62 against 63.5 is a rounding difference between two reviewers who agree.
    // The old points threshold would have badged it as a dispute.
    const rubricByRound = new Map([[ROUND_ONE, WIDE_RUBRIC]]);
    const result = disagreementFor(
      [submitted(ROUND_ONE, 63.5), submitted(ROUND_ONE, 62)],
      rubricByRound,
    );

    expect(result.gap).toBe(1.5);
    expect(result.severity).toBe(0.015);
    expect(isContested(result)).toBe(false);
  });

  it("MUST FIRE: the widest round is the most severe one, not the one with most points", () => {
    /*
     * Round one is scored 1-5 and its panel disagreed as completely as it can
     * (5 against 1: four points, the entire span). Round two is scored 0-100
     * and its reviewers are five points apart — more points, almost no
     * disagreement. Ranking by raw points would report round two.
     */
    const rubricByRound = new Map([
      [ROUND_ONE, BALANCED_RUBRIC],
      [ROUND_TWO, WIDE_RUBRIC],
    ]);
    const result = disagreementFor(
      [
        submitted(ROUND_ONE, 10), // 5.00
        submitted(ROUND_ONE, 2), // 1.00 → gap 4.00 of a 4.00 span
        submitted(ROUND_TWO, 70),
        submitted(ROUND_TWO, 65), // gap 5 of a 100 span
      ],
      rubricByRound,
    );

    expect(result.roundId).toBe(ROUND_ONE);
    expect(result.gap).toBe(4);
    expect(result.severity).toBe(1);
    expect(isContested(result)).toBe(true);
  });

  it("MUST FIRE: the gap is reported against the span, not against the maximum", () => {
    /*
     * A 90-100 criterion has a maximum of 100 and a span of 10. Two reviewers
     * at the ends of it disagree completely, and reporting "10 of 100" would
     * present that as a ten-percent quibble. The score keeps the maximum as its
     * denominator; the disagreement gets the span.
     */
    expect(rubricMaxTotal(OFFSET_RUBRIC)).toBe(100);
    expect(rubricSpanTotal(OFFSET_RUBRIC)).toBe(10);

    const rubricByRound = new Map([[ROUND_ONE, OFFSET_RUBRIC]]);
    const result = disagreementFor(
      [submitted(ROUND_ONE, 100), submitted(ROUND_ONE, 90)],
      rubricByRound,
    );

    expect(result).toEqual({
      gap: 10,
      gapWeighted: 10,
      weightedSpan: 10,
      severity: 1,
      reviewCount: 2,
      roundId: ROUND_ONE,
    });
    // The score for the same submission still reads against the maximum.
    expect(weightedAggregateFor(
      [submitted(ROUND_ONE, 100), submitted(ROUND_ONE, 90)],
      rubricByRound,
    )).toEqual({ average: 95, max: 100 });
  });

  it("MUST NOT FIRE: a rubric with no room to disagree divides by nothing", () => {
    // Hand-built rather than parsed — `parseRubric` rejects `min >= max`, and
    // this is the fixture that proves the guard is not load-bearing on it.
    const pinned: Rubric = {
      criteria: [{ key: "fixed", label: "Fixed", min: 3, max: 3, weight: 1 }],
    };
    expect(rubricSpanTotal(pinned)).toBe(0);

    const result = disagreementFor(
      [submitted(ROUND_ONE, 3), submitted(ROUND_ONE, 3)],
      new Map([[ROUND_ONE, pinned]]),
    );
    expect(result.severity).toBeNull();
    expect(result.gap).toBeNull();
    expect(isContested(result)).toBe(false);
  });
});
