export type RubricCriterionType = "number" | "select" | "text";

export interface RubricCriterion {
  key: string;
  label: string;
  min: number;
  max: number;
  weight: number;
  type?: RubricCriterionType;
  options?: string[];
}

export interface Rubric {
  criteria: RubricCriterion[];
}

export const DEFAULT_RUBRIC: Rubric = {
  criteria: [
    { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 2 },
    { key: "depth", label: "Technical depth", min: 1, max: 5, weight: 2 },
    { key: "speaker", label: "Speaker signal", min: 1, max: 5, weight: 1 },
  ],
};

/** Per-round blinding rides in the rubric JSON so no migration is needed. */
export function isRoundBlind(rubricJson: unknown): boolean {
  return Boolean(
    rubricJson &&
      typeof rubricJson === "object" &&
      !Array.isArray(rubricJson) &&
      (rubricJson as Record<string, unknown>).blind === true,
  );
}

/** Merge blinding into a rubric payload without dropping its other keys. */
export function withRoundBlind(
  rubricJson: unknown,
  blind: boolean,
): Record<string, unknown> {
  const rubric =
    rubricJson && typeof rubricJson === "object" && !Array.isArray(rubricJson)
      ? (rubricJson as Record<string, unknown>)
      : {};
  return { ...rubric, blind };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSelectCriterion(c: RubricCriterion): boolean {
  return c.type === "select";
}

export function isTextCriterion(c: RubricCriterion): boolean {
  return c.type === "text";
}

export function isUnscoredCriterion(c: RubricCriterion): boolean {
  return isSelectCriterion(c) || isTextCriterion(c);
}

/**
 * Turns persisted JSON into a safe rubric. Invalid criteria are ignored and a
 * completely invalid rubric falls back to the small, seeded default.
 */
export function parseRubric(value: unknown): Rubric {
  if (!value || typeof value !== "object") return DEFAULT_RUBRIC;
  const raw = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(raw)) return DEFAULT_RUBRIC;

  const seen = new Set<string>();
  const criteria: RubricCriterion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const key = String(candidate.key ?? "").trim();
    const label = String(candidate.label ?? "").trim();
    if (candidate.type === "text") {
      if (!key || !label || seen.has(key)) continue;
      seen.add(key);
      criteria.push({ key, label, min: 0, max: 0, weight: 0, type: "text" });
      continue;
    }
    if (candidate.type === "select") {
      if (!key || !label || seen.has(key) || !Array.isArray(candidate.options)) continue;
      const options = [...new Set(candidate.options.map((option) => String(option).trim()))].filter(
        Boolean,
      );
      if (options.length < 2 || options.length > 12) continue;
      seen.add(key);
      criteria.push({ key, label, min: 0, max: 0, weight: 0, type: "select", options });
      continue;
    }
    const min = finiteNumber(candidate.min);
    const max = finiteNumber(candidate.max);
    const weight = finiteNumber(candidate.weight);
    if (
      !key ||
      !label ||
      seen.has(key) ||
      min === null ||
      max === null ||
      weight === null ||
      min >= max ||
      weight <= 0
    ) {
      continue;
    }
    seen.add(key);
    criteria.push({ key, label, min, max, weight });
  }

  return criteria.length > 0 ? { criteria } : DEFAULT_RUBRIC;
}

export type ScoreResult =
  | { ok: true; scores: Record<string, number | string>; totalScore: number; maxScore: number }
  | { ok: false; error: string };

/**
 * Strictly validates every criterion and calculates the persisted weighted sum.
 * Unscored criteria are recorded but deliberately excluded from the weighted numeric total.
 */
export function scoreRubric(
  rubric: Rubric,
  input: Record<string, unknown>,
): ScoreResult {
  const scores: Record<string, number | string> = {};
  let totalScore = 0;
  let maxScore = 0;

  for (const criterion of rubric.criteria) {
    if (isTextCriterion(criterion)) {
      const value = String(input[criterion.key] ?? "").trim();
      // Free text is an optional comment; unlike a dropdown, an empty answer is meaningful.
      scores[criterion.key] = value;
      continue;
    }
    if (isSelectCriterion(criterion)) {
      const value = String(input[criterion.key] ?? "").trim();
      if (!value) {
        return { ok: false, error: `${criterion.label} needs a selection.` };
      }
      if (!criterion.options?.includes(value)) {
        return {
          ok: false,
          error: `${criterion.label} must be one of: ${(criterion.options ?? []).join(", ")}.`,
        };
      }
      scores[criterion.key] = value;
      continue;
    }
    const value = finiteNumber(input[criterion.key]);
    if (value === null) {
      return { ok: false, error: `${criterion.label} requires a numeric score.` };
    }
    if (value < criterion.min || value > criterion.max) {
      return {
        ok: false,
        error: `${criterion.label} must be between ${criterion.min} and ${criterion.max}.`,
      };
    }
    scores[criterion.key] = value;
    totalScore += value * criterion.weight;
    maxScore += criterion.max * criterion.weight;
  }

  return { ok: true, scores, totalScore, maxScore };
}
