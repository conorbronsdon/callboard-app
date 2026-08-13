import { isSelectCriterion, type Rubric, type RubricCriterion } from "./scoring";

export type RubricEditorResult =
  | { ok: true; rubric: Rubric }
  | { ok: false; error: string };

function numberAt(values: string[], index: number): number | null {
  const value = Number(values[index]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Strict parser for the organizer's rubric editor. Unlike persisted-rubric
 * parsing, this never falls back: a malformed edit must not silently replace a
 * real rubric with defaults.
 */
export function parseRubricEditor(input: {
  keys: string[];
  labels: string[];
  mins: string[];
  maxes: string[];
  weights: string[];
  types?: string[];
  options?: string[];
  removes?: string[];
}): RubricEditorResult {
  const count = input.keys.length;
  if (
    [input.labels, input.mins, input.maxes, input.weights].some(
      (values) => values.length !== count,
    )
  ) {
    return { ok: false, error: "Every criterion needs a key, label, range, and weight." };
  }

  const rows = input.keys
    .map((key, index) => ({
      key: key.trim(),
      label: input.labels[index].trim(),
      min: input.mins[index],
      max: input.maxes[index],
      weight: input.weights[index],
      type: input.types?.[index] ?? "number",
      options: input.options?.[index] ?? "",
      remove: input.removes?.[index] ?? "",
    }))
    .filter((row) => !row.remove.trim() && (row.key || row.label));

  if (rows.length < 1 || rows.length > 8) {
    return { ok: false, error: "A rubric needs between 1 and 8 criteria." };
  }

  const criteria: RubricCriterion[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { key, label } = row;

    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
      return {
        ok: false,
        error: "Criterion keys use lowercase letters, numbers, and underscores (32 characters max).",
      };
    }
    if (seen.has(key)) return { ok: false, error: `Criterion key "${key}" is duplicated.` };
    if (!label || label.length > 80) {
      return { ok: false, error: "Criterion labels are required and capped at 80 characters." };
    }

    if (row.type === "select") {
      const options = [...new Set(row.options.split(/[\n,]/).map((option) => option.trim()))].filter(
        Boolean,
      );
      if (options.length < 2 || options.length > 12) {
        return { ok: false, error: `${label} needs between 2 and 12 dropdown options.` };
      }
      seen.add(key);
      criteria.push({ key, label, min: 0, max: 0, weight: 0, type: "select", options });
      continue;
    }

    const min = numberAt([row.min], 0);
    const max = numberAt([row.max], 0);
    const weight = numberAt([row.weight], 0);
    if (min === null || max === null || min >= max || min < 0 || max > 100) {
      return { ok: false, error: `${label} needs a valid 0–100 range with min below max.` };
    }
    if (weight === null || weight <= 0 || weight > 10) {
      return { ok: false, error: `${label} needs a weight greater than 0 and at most 10.` };
    }

    seen.add(key);
    criteria.push({ key, label, min, max, weight });
  }

  /*
   * At least one scored criterion. Dropdowns are normalised to weight 0, so a
   * rubric made only of them has a weight total of 0 and can never produce a
   * score: `reviewAverage` returns null for every review in it, the CSV and the
   * submissions list show no aggregate, and the round cannot rank anything.
   * Rejected here rather than accepted and rendered as an empty column later.
   */
  if (criteria.every(isSelectCriterion)) {
    return {
      ok: false,
      error:
        "A rubric needs at least one scored criterion — dropdowns are recorded but not scored, so an all-dropdown rubric can never produce an aggregate.",
    };
  }

  return { ok: true, rubric: { criteria } };
}
