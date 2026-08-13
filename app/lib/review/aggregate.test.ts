import { describe, expect, it } from "vitest";

import {
  aggregateByRound,
  aggregateFor,
  choiceSummaries,
  reviewAverage,
  rubricWeightTotal,
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
});
