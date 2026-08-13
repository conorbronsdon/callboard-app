import { describe, expect, it } from "vitest";

import { fieldLabels } from "./field-labels";

const FIELDS = [
  { key: "title", label: "Session title" },
  { key: "takeaways", label: "Audience takeaways" },
  { key: "abstract", label: "Abstract" },
];

describe("fieldLabels", () => {
  it("must fire: names fields by label, never by key", () => {
    const labels = fieldLabels(["title", "takeaways"], FIELDS);
    expect(labels).toEqual(["Session title", "Audience takeaways"]);
    // The exact leak the walkthrough caught: "(combined across title, takeaways)".
    expect(labels.join(", ")).toBe("Session title, Audience takeaways");
    expect(labels).not.toContain("title");
    expect(labels).not.toContain("takeaways");
  });

  it("keeps the order the rule declared, not the field registry's", () => {
    expect(fieldLabels(["takeaways", "title"], FIELDS)).toEqual([
      "Audience takeaways",
      "Session title",
    ]);
  });

  it("must NOT fire: an unknown key falls back to itself instead of disappearing", () => {
    // A rule pointing at a deleted field is a misconfiguration to surface, not
    // to hide — the list length must still match the rule.
    expect(fieldLabels(["title", "deleted_field"], FIELDS)).toEqual([
      "Session title",
      "deleted_field",
    ]);
  });

  it("handles an empty rule and an empty registry", () => {
    expect(fieldLabels([], FIELDS)).toEqual([]);
    expect(fieldLabels(["title"], [])).toEqual(["title"]);
  });
});
