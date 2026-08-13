/**
 * Capture on behalf of a speaker — the talks that arrive as an email, a DM, or
 * a hallway conversation instead of through the CFP form.
 *
 * The rule that shapes every function here: capture is a RECORDING, not a
 * submission event. An organizer pasting somebody else's words into Callboard
 * has not asked that person for anything, so nothing may be sent — no
 * confirmation, no magic link, no portal tasks. Those all belong to paths the
 * organizer takes later and deliberately (`commitQueues`, the comms screen).
 *
 * Everything is optional on purpose. A pitch that arrives as three sentences in
 * a DM has no title, no track and frequently no email; demanding them is how a
 * capture box turns back into the form the speaker already did not fill in.
 *
 * No I/O: the route owns the database, this owns the rules, so the derivation
 * and the provenance shape unit-test without a database.
 */

/**
 * Reserved key for the provenance block inside `sessions.answers`.
 *
 * `__`-prefixed for the same reason as the wizard's `__content`: registry field
 * keys are normalised to `[a-z0-9_]` with leading underscores stripped
 * (admin.forms.edit.tsx `create-field`), so a `__` key can never collide with a
 * real answer. `admin.submission.tsx` already skips `__` keys when it lists
 * off-schema answers, and `app/lib/api/serialize.ts` skips them in
 * `custom_fields` — provenance is an internal record, not a CFP answer.
 */
export const CAPTURE_KEY = "__capture";

/** Where the pitch actually came from. Free text would not group or filter. */
export const CAPTURE_SOURCES = ["email", "dm", "hallway", "other"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const CAPTURE_SOURCE_LABELS: Record<CaptureSource, string> = {
  email: "Email",
  dm: "DM",
  hallway: "Hallway conversation",
  other: "Somewhere else",
};

export function isCaptureSource(value: unknown): value is CaptureSource {
  return (CAPTURE_SOURCES as readonly unknown[]).includes(value);
}

/**
 * What "captured by an organizer" means on the record.
 *
 * `byPersonId` is the organizer, never the speaker — attributing a capture to
 * the person who did not make it is the failure mode this block exists to stop.
 * `byName` is denormalised on purpose: it is what the organizer was called at
 * the moment of capture, and a later profile rename must not rewrite history.
 *
 * The pasted text is NOT stored here. It goes to `sessions.description`, which
 * is where every other surface already reads a submission's prose from; keeping
 * a second copy would guarantee the two drift.
 */
export interface CaptureProvenance {
  source: CaptureSource;
  /** Epoch ms. */
  capturedAt: number;
  byPersonId: string;
  byName: string;
  /**
   * Name typed for a speaker we could NOT link to a person row, because no
   * email was given. Never matched against `people.full_name`: matching humans
   * on names is how one speaker becomes three.
   */
  contactName: string | null;
  /** Present only when the capture failed to attach; normally null. */
  contactNote: string | null;
}

/** Read the provenance block back off a `sessions.answers` blob. */
export function captureProvenance(answers: unknown): CaptureProvenance | null {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  const raw = (answers as Record<string, unknown>)[CAPTURE_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const block = raw as Record<string, unknown>;
  if (typeof block.byPersonId !== "string" || !block.byPersonId) return null;
  if (typeof block.capturedAt !== "number" || !Number.isFinite(block.capturedAt)) return null;

  return {
    source: isCaptureSource(block.source) ? block.source : "other",
    capturedAt: block.capturedAt,
    byPersonId: block.byPersonId,
    byName: typeof block.byName === "string" ? block.byName : "",
    contactName: typeof block.contactName === "string" && block.contactName ? block.contactName : null,
    contactNote: typeof block.contactNote === "string" && block.contactNote ? block.contactNote : null,
  };
}

export const CAPTURE_TITLE_FALLBACK = "Untitled capture";
export const CAPTURE_TITLE_MAX = 120;

/**
 * A title for a record whose author never gave one.
 *
 * An explicit title wins. Otherwise the first non-blank line of the pasted text
 * stands in — an email's subject line or a DM's opening sentence is nearly
 * always the right answer, and it keeps the abstracts table readable without
 * pretending to have parsed anything. A truly empty capture still gets a row:
 * the organizer is recording that a pitch exists, and refusing the write would
 * push them back to the notebook this feature replaces.
 */
export function deriveCaptureTitle(title: string, pasted: string): string {
  const explicit = title.trim();
  if (explicit) return explicit.slice(0, CAPTURE_TITLE_MAX);

  const firstLine = pasted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return CAPTURE_TITLE_FALLBACK;

  return firstLine.length > CAPTURE_TITLE_MAX
    ? `${firstLine.slice(0, CAPTURE_TITLE_MAX - 1).trimEnd()}…`
    : firstLine;
}

export interface CaptureInput {
  title: string;
  pasted: string;
  source: string;
  speakerEmail: string;
  speakerName: string;
}

export interface CapturePlan {
  title: string;
  /** Stored exactly as pasted — trailing whitespace only is trimmed. */
  description: string | null;
  source: CaptureSource;
  /** Normalised address, or null when no usable email was supplied. */
  speakerEmail: string | null;
  speakerName: string | null;
}

export type CapturePlanResult =
  | { ok: true; plan: CapturePlan }
  | { ok: false; error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Turn the posted capture form into the write plan.
 *
 * The only rejection is a malformed email, and only when one was actually
 * typed: a blank address is a capture with no linkable person, which is a
 * normal outcome, while `sam@` is a typo that would silently create a person
 * nobody can ever email.
 */
export function planCapture(input: CaptureInput): CapturePlanResult {
  const pasted = input.pasted.trim();
  const email = input.speakerEmail.trim().toLowerCase();
  if (email && !EMAIL.test(email)) {
    return { ok: false, error: `"${input.speakerEmail.trim()}" is not a valid email address.` };
  }

  const title = deriveCaptureTitle(input.title, pasted);
  if (title.length > 255) return { ok: false, error: "Title is capped at 255 characters." };

  return {
    ok: true,
    plan: {
      title,
      description: pasted || null,
      source: isCaptureSource(input.source) ? input.source : "other",
      speakerEmail: email || null,
      speakerName: input.speakerName.trim() || null,
    },
  };
}

/**
 * The provenance block to store, given a plan and who is doing the capturing.
 *
 * `attached` is the route's answer to "did we end up with a person row?" — it
 * is not re-derived from the plan, because a valid email that resolves to an
 * existing person and a valid email that creates one are the same case here but
 * a blank email is not.
 */
export function captureProvenanceFor(input: {
  plan: CapturePlan;
  byPersonId: string;
  byName: string;
  capturedAt: number;
  attached: boolean;
}): CaptureProvenance {
  return {
    source: input.plan.source,
    capturedAt: input.capturedAt,
    byPersonId: input.byPersonId,
    byName: input.byName,
    contactName: input.attached ? null : input.plan.speakerName,
    contactNote: input.attached
      ? null
      : "No email was given, so this pitch is not linked to a speaker record yet.",
  };
}
