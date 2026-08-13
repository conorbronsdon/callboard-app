import { describe, expect, it } from "vitest";

import { parseRubricEditor } from "./review-operations";

const valid = {
  keys: ["fit", "depth"],
  labels: ["Programme fit", "Technical depth"],
  mins: ["1", "1"],
  maxes: ["5", "5"],
  weights: ["2", "3"],
};

describe("parseRubricEditor", () => {
  it("must fire: returns a complete ordered rubric", () => {
    expect(parseRubricEditor(valid)).toEqual({
      ok: true,
      rubric: {
        criteria: [
          { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
          { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 3 },
        ],
      },
    });
  });

  it("must NOT fire: rejects partial, duplicate, unsafe, and invalid criteria", () => {
    expect(parseRubricEditor({ ...valid, labels: ["Only one"] })).toMatchObject({ ok: false });
    expect(parseRubricEditor({ ...valid, keys: ["fit", "fit"] })).toMatchObject({ ok: false });
    expect(parseRubricEditor({ ...valid, keys: ["Fit!", "depth"] })).toMatchObject({ ok: false });
    expect(parseRubricEditor({ ...valid, maxes: ["1", "5"] })).toMatchObject({ ok: false });
    expect(parseRubricEditor({ ...valid, weights: ["0", "3"] })).toMatchObject({ ok: false });
  });

  it("must NOT fire: rejects empty and oversized rubrics", () => {
    expect(parseRubricEditor({ keys: [], labels: [], mins: [], maxes: [], weights: [] })).toMatchObject({ ok: false });
    const nine = Array.from({ length: 9 }, (_, index) => `criterion_${index}`);
    expect(parseRubricEditor({
      keys: nine,
      labels: nine,
      mins: nine.map(() => "1"),
      maxes: nine.map(() => "5"),
      weights: nine.map(() => "1"),
    })).toMatchObject({ ok: false });
  });

  it("must fire: parses comma- and newline-separated dropdown options", () => {
    expect(parseRubricEditor({
      keys: ["fit", "recommendation"],
      labels: ["Programme fit", "Recommendation"],
      mins: ["1", "0"],
      maxes: ["5", "0"],
      weights: ["2", "0"],
      types: ["number", "select"],
      options: ["", "Accept, Maybe\nReject, Accept"],
      removes: ["", ""],
    })).toEqual({
      ok: true,
      rubric: {
        criteria: [
          { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
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
      },
    });
  });

  it("must NOT fire: rejects a dropdown row with only one usable option", () => {
    expect(parseRubricEditor({
      keys: ["fit", "recommendation"],
      labels: ["Programme fit", "Recommendation"],
      mins: ["1", "0"],
      maxes: ["5", "0"],
      weights: ["2", "0"],
      types: ["number", "select"],
      options: ["", "Accept, Accept"],
    })).toEqual({
      ok: false,
      error: "Recommendation needs between 2 and 12 dropdown options.",
    });
  });

  it("must fire: accepts text beside a scored criterion and ignores numeric garbage", () => {
    expect(parseRubricEditor({
      keys: ["fit", "reviewer_note"],
      labels: ["Programme fit", "Reviewer note"],
      mins: ["1", "abc"],
      maxes: ["5", "-50"],
      weights: ["2", "999"],
      types: ["number", "text"],
      options: ["", "this is ignored too"],
    })).toEqual({
      ok: true,
      rubric: {
        criteria: [
          { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
          {
            key: "reviewer_note",
            label: "Reviewer note",
            min: 0,
            max: 0,
            weight: 0,
            type: "text",
          },
        ],
      },
    });
  });

  it("must NOT fire: rejects a rubric made only of text criteria", () => {
    const result = parseRubricEditor({
      keys: ["reviewer_note"],
      labels: ["Reviewer note"],
      mins: ["abc"],
      maxes: ["-50"],
      weights: ["999"],
      types: ["text"],
      options: ["ignored"],
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("at least one scored criterion");

    expect(parseRubricEditor({
      keys: ["recommendation", "reviewer_note"],
      labels: ["Recommendation", "Reviewer note"],
      mins: ["0", "abc"],
      maxes: ["0", "-50"],
      weights: ["0", "999"],
      types: ["select", "text"],
      options: ["Accept, Reject", "ignored"],
    })).toMatchObject({ ok: false });
  });

  it("must NOT fire: rejects a rubric made only of dropdowns", () => {
    /*
     * The case the suite lacked. Every other dropdown test adds a select
     * ALONGSIDE the numeric defaults, so none of them could reach the state
     * where the weight total is 0 — the state that made a fully reviewed
     * submission report zero reviews.
     */
    const allSelect = parseRubricEditor({
      keys: ["recommendation", "confidence"],
      labels: ["Recommendation", "Confidence"],
      mins: ["0", "0"],
      maxes: ["0", "0"],
      weights: ["0", "0"],
      types: ["select", "select"],
      options: ["Accept, Reject", "High, Low"],
      removes: ["", ""],
    });
    expect(allSelect).toMatchObject({ ok: false });
    expect((allSelect as { error: string }).error).toContain("at least one scored criterion");

    // A single dropdown on its own is the same defect, one row smaller.
    expect(parseRubricEditor({
      keys: ["recommendation"],
      labels: ["Recommendation"],
      mins: ["0"],
      maxes: ["0"],
      weights: ["0"],
      types: ["select"],
      options: ["Accept, Maybe, Reject"],
      removes: [""],
    })).toMatchObject({ ok: false });

    // MUST STILL FIRE: one numeric criterion is enough to make the same rows
    // valid, so the rejection is the missing weight and not the dropdowns.
    expect(parseRubricEditor({
      keys: ["fit", "recommendation", "confidence"],
      labels: ["Programme fit", "Recommendation", "Confidence"],
      mins: ["1", "0", "0"],
      maxes: ["5", "0", "0"],
      weights: ["2", "0", "0"],
      types: ["number", "select", "select"],
      options: ["", "Accept, Reject", "High, Low"],
      removes: ["", "", ""],
    })).toMatchObject({ ok: true });
  });

  it("must fire: drops removed and trailing all-blank rows", () => {
    expect(parseRubricEditor({
      keys: ["fit", "depth", ""],
      labels: ["Programme fit", "Technical depth", ""],
      mins: ["1", "1", "1"],
      maxes: ["5", "5", "5"],
      weights: ["2", "3", "1"],
      removes: ["", "remove", ""],
    })).toEqual({
      ok: true,
      rubric: {
        criteria: [{ key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 }],
      },
    });
  });

  it("must NOT fire: rejects removal of every row", () => {
    expect(parseRubricEditor({
      keys: ["fit"],
      labels: ["Programme fit"],
      mins: ["1"],
      maxes: ["5"],
      weights: ["2"],
      removes: ["remove"],
    })).toEqual({ ok: false, error: "A rubric needs between 1 and 8 criteria." });
  });

  it("must NOT fire: new parallel arrays do not change numeric criterion shape", () => {
    const result = parseRubricEditor({
      ...valid,
      types: ["number", "anything-else"],
      options: ["ignored, values", "Accept, Reject"],
      removes: ["", ""],
    });
    expect(result).toEqual({
      ok: true,
      rubric: {
        criteria: [
          { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
          { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 3 },
        ],
      },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.rubric.criteria[0]).not.toHaveProperty("type");
    expect(result.rubric.criteria[0]).not.toHaveProperty("options");
  });
});
