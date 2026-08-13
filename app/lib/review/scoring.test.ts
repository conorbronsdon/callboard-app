import { describe, expect, it } from "vitest";

import { reviewAverage, rubricWeightTotal } from "./aggregate";
import { DEFAULT_RUBRIC, parseRubric, scoreRubric } from "./scoring";

describe("parseRubric", () => {
  it("keeps valid, uniquely keyed weighted criteria", () => {
    expect(
      parseRubric({
        criteria: [
          { key: "fit", label: "Programme fit", min: 0, max: 10, weight: 3 },
          { key: "fit", label: "Duplicate", min: 1, max: 5, weight: 1 },
          { key: "bad", label: "Bad", min: 5, max: 1, weight: 1 },
        ],
      }).criteria,
    ).toEqual([{ key: "fit", label: "Programme fit", min: 0, max: 10, weight: 3 }]);
  });

  it("falls back when persisted JSON has no usable criteria", () => {
    expect(parseRubric(null)).toEqual(DEFAULT_RUBRIC);
    expect(parseRubric({ criteria: [{ key: "", min: 1, max: 5, weight: 1 }] })).toEqual(
      DEFAULT_RUBRIC,
    );
  });

  it("must fire: keeps a select criterion and normalises its numeric fields", () => {
    expect(
      parseRubric({
        criteria: [
          {
            key: "recommendation",
            label: "Recommendation",
            min: 1,
            max: 5,
            weight: 2,
            type: "select",
            options: [" Accept ", "Maybe", "Accept", "", "Reject"],
          },
        ],
      }).criteria,
    ).toEqual([
      {
        key: "recommendation",
        label: "Recommendation",
        min: 0,
        max: 0,
        weight: 0,
        type: "select",
        options: ["Accept", "Maybe", "Reject"],
      },
    ]);
  });

  it("must NOT fire: drops select criteria without two usable array options", () => {
    const parsed = parseRubric({
      criteria: [
        { key: "fit", label: "Fit", min: 1, max: 5, weight: 1 },
        {
          key: "too_short",
          label: "Too short",
          type: "select",
          options: ["Accept", " Accept ", ""],
        },
        { key: "not_array", label: "Not array", type: "select", options: "Accept,Reject" },
      ],
    });

    expect(parsed.criteria).toEqual([
      { key: "fit", label: "Fit", min: 1, max: 5, weight: 1 },
    ]);
  });
});

describe("scoreRubric", () => {
  it("must fire: calculates the weighted score only when every criterion is present", () => {
    expect(scoreRubric(DEFAULT_RUBRIC, { relevance: 4, depth: 5, speaker: 3 })).toEqual({
      ok: true,
      scores: { relevance: 4, depth: 5, speaker: 3 },
      totalScore: 21,
      maxScore: 25,
    });
  });

  it("must NOT fire: rejects missing, nonnumeric and out-of-range scores", () => {
    expect(scoreRubric(DEFAULT_RUBRIC, { relevance: 4, depth: 5 })).toMatchObject({
      ok: false,
    });
    expect(
      scoreRubric(DEFAULT_RUBRIC, { relevance: "nope", depth: 5, speaker: 3 }),
    ).toMatchObject({ ok: false });
    expect(scoreRubric(DEFAULT_RUBRIC, { relevance: 6, depth: 5, speaker: 3 })).toEqual({
      ok: false,
      error: "Relevance must be between 1 and 5.",
    });
  });

  it("must fire: stores a dropdown answer outside the numeric weighted total", () => {
    const rubric = {
      criteria: [
        { key: "fit", label: "Fit", min: 1, max: 5, weight: 2 },
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select" as const,
          options: ["Accept", "Maybe", "Reject"],
        },
      ],
    };

    expect(scoreRubric(rubric, { fit: 4, recommendation: "Accept" })).toEqual({
      ok: true,
      scores: { fit: 4, recommendation: "Accept" },
      totalScore: 8,
      maxScore: 10,
    });
  });

  it("must NOT fire: rejects missing and unknown dropdown answers", () => {
    const rubric = {
      criteria: [
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select" as const,
          options: ["Accept", "Reject"],
        },
      ],
    };

    expect(scoreRubric(rubric, {})).toEqual({
      ok: false,
      error: "Recommendation needs a selection.",
    });
    expect(scoreRubric(rubric, { recommendation: "Maybe" })).toEqual({
      ok: false,
      error: "Recommendation must be one of: Accept, Reject.",
    });
  });

  it("mutation control: dropdown criteria cannot change numeric totals or averages", () => {
    const answers = { relevance: 4, depth: 5, speaker: 3 };
    const withSelect = {
      criteria: [
        ...DEFAULT_RUBRIC.criteria,
        {
          key: "recommendation",
          label: "Recommendation",
          min: 0,
          max: 0,
          weight: 0,
          type: "select" as const,
          options: ["Accept", "Maybe", "Reject"],
        },
      ],
    };
    const withNumeric = {
      criteria: [
        ...DEFAULT_RUBRIC.criteria,
        { key: "confidence", label: "Confidence", min: 1, max: 5, weight: 1 },
      ],
    };
    const base = scoreRubric(DEFAULT_RUBRIC, answers);
    const selected = scoreRubric(withSelect, { ...answers, recommendation: "Accept" });
    const numeric = scoreRubric(withNumeric, { ...answers, confidence: 5 });
    expect(base.ok).toBe(true);
    expect(selected.ok).toBe(true);
    expect(numeric.ok).toBe(true);
    if (!base.ok || !selected.ok || !numeric.ok) throw new Error("Expected valid scores");

    expect(selected.totalScore).toBe(base.totalScore);
    expect(selected.maxScore).toBe(base.maxScore);
    expect(rubricWeightTotal(withSelect)).toBe(rubricWeightTotal(DEFAULT_RUBRIC));
    expect(reviewAverage(selected.totalScore, withSelect)).toBe(
      reviewAverage(base.totalScore, DEFAULT_RUBRIC),
    );
    expect(numeric.maxScore).not.toBe(base.maxScore);
  });
});
