/** Public CFP field keys that map submitted names onto normalized metadata. */
export const FORMAT_ANSWER_KEYS = ["format"] as const;

/** Deliberately short: these are the supported level keys, not guessed synonyms. */
export const LEVEL_ANSWER_KEYS = ["level", "audience_level", "experience_level"] as const;

type NamedRow = Readonly<{ id: string; name: string }>;

/**
 * Return the first present answer without coercing it.
 *
 * Presence, rather than truthiness, is intentional: an invalid value at the
 * canonical key must not fall through to a later alias and silently change the
 * meaning of the submission.
 */
export function readNamedOptionAnswer(
  answers: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(answers, candidate));
  if (!key) return null;

  const answer = answers[key];
  return typeof answer === "string" && answer.trim() ? answer : null;
}

/**
 * Resolve a submitted option name to exactly one row id.
 *
 * Names are trimmed and compared case-insensitively. Unknown, blank, or
 * non-string answers return null. Duplicate matching names are ambiguous and
 * also return null—choosing the first row would be worse than leaving the
 * normalized column unset.
 */
export function resolveNamedOption(answer: unknown, rows: readonly NamedRow[]): string | null {
  if (typeof answer !== "string") return null;

  const normalizedAnswer = answer.trim().toLowerCase();
  if (!normalizedAnswer) return null;

  const matches = rows.filter((row) => row.name.trim().toLowerCase() === normalizedAnswer);
  return matches.length === 1 ? matches[0].id : null;
}

export function resolveFormatAndLevel(input: {
  answers: Record<string, unknown>;
  formats: readonly NamedRow[];
  levels: readonly NamedRow[];
}): { formatId: string | null; levelId: string | null } {
  return {
    formatId: resolveNamedOption(
      readNamedOptionAnswer(input.answers, FORMAT_ANSWER_KEYS),
      input.formats,
    ),
    levelId: resolveNamedOption(
      readNamedOptionAnswer(input.answers, LEVEL_ANSWER_KEYS),
      input.levels,
    ),
  };
}
