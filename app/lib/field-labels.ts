/**
 * Field keys are internal handles. Anything a human reads names fields by their
 * LABEL — the words printed above the input they are typing in.
 *
 * Shared by the public wizard's combined-character counter ("combined across
 * Session title, Audience takeaways") and the admin rule chips, so the two can
 * never drift into showing different vocabularies for the same rule.
 */

/** The minimum a field must expose to be named. */
export interface LabelledField {
  key: string;
  label: string;
}

/**
 * Labels for `keys`, in the order given.
 *
 * A key with no matching field falls back to the key itself rather than
 * vanishing: a rule that outlives the field it points at is a real state, and
 * silently dropping it from the list would hide the misconfiguration.
 */
export function fieldLabels(keys: readonly string[], fields: readonly LabelledField[]): string[] {
  const byKey = new Map(fields.map((field) => [field.key, field.label]));
  return keys.map((key) => byKey.get(key) ?? key);
}
