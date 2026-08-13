import type { SessionStatus } from "~/db/schema";
import type { EditDeadlinePolicy } from "~/lib/form-schema";

export const SPEAKER_EDITABLE_STATUSES = ["pending", "accepted"] as const satisfies readonly SessionStatus[];

export function canSpeakerEditSubmission(status: SessionStatus): boolean {
  return (SPEAKER_EDITABLE_STATUSES as readonly SessionStatus[]).includes(status);
}

export type SpeakerEditLockReason =
  | "review_advanced"
  | "past_close_date"
  | "past_edit_deadline"
  | null;

/**
 * Pending corrections stay open until the owning CFP closes. Accepted speakers
 * may keep title/abstract/video accurate after acceptance; programme placement
 * and decision fields remain outside this helper and organizer-owned.
 *
 * The strict `now > closesAt` comparison for pending proposals deliberately
 * matches the public CFP gate. Accepted corrections ignore the CFP deadline
 * because acceptance normally happens after submissions close.
 *
 * ── Configurable deadlines (issue #1) ───────────────────────────────────────
 * `policy` makes that default CONFIGURABLE rather than adding a second lock
 * beside it. There is one date gate in the product and this is it; the policy
 * only chooses which date it reads:
 *
 *   `cfp_close` (default, and what an absent policy means) — exactly the
 *      behaviour above. Every form built before this existed keeps it.
 *   `custom`  — the operator's own date, applied to pending AND accepted
 *      corrections. It replaces the CFP close date rather than stacking with
 *      it: an operator who says "edits close March 1st" has said something
 *      complete, and silently also enforcing an earlier CFP deadline would make
 *      their setting a lie in the strict direction.
 *   `open`    — no date gate at all. Status still governs, so a declined or
 *      staged proposal is as locked as ever.
 */
export function speakerEditLockReason(input: {
  status: SessionStatus;
  closesAt: number | null | undefined;
  now?: number;
  policy?: EditDeadlinePolicy;
}): SpeakerEditLockReason {
  if (!canSpeakerEditSubmission(input.status)) return "review_advanced";

  const now = input.now ?? Date.now();
  const mode = input.policy?.mode ?? "cfp_close";

  if (mode === "open") return null;

  if (mode === "custom") {
    const at = input.policy?.at;
    if (at !== null && at !== undefined && now > at) return "past_edit_deadline";
    return null;
  }

  if (input.status === "accepted") return null;
  if (input.closesAt !== null && input.closesAt !== undefined) {
    if (now > input.closesAt) return "past_close_date";
  }
  return null;
}

export interface SubmissionEditInput {
  title: string;
  abstract: string;
  videoUrl: string;
}

export type SubmissionEditResult =
  | { ok: true; value: SubmissionEditInput }
  | { ok: false; errors: Partial<Record<keyof SubmissionEditInput, string>> };

export function validateSubmissionEdit(input: SubmissionEditInput): SubmissionEditResult {
  const value = {
    title: input.title.trim(),
    abstract: input.abstract.trim(),
    videoUrl: input.videoUrl.trim(),
  };
  const errors: Partial<Record<keyof SubmissionEditInput, string>> = {};

  if (!value.title) errors.title = "Give your submission a title.";
  if (value.title.length > 120) errors.title = "Keep the title to 120 characters or fewer.";
  if (!value.abstract && !value.videoUrl) {
    errors.abstract = "Add an abstract or a video link.";
  }
  if (value.videoUrl) {
    try {
      const url = new URL(value.videoUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.videoUrl = "Use an http or https video link.";
      }
    } catch {
      errors.videoUrl = "Enter a complete video link.";
    }
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/**
 * What the speaker is told, per reason.
 *
 * Deliberately phrased as REVIEW-PROCESS state, never decision state. A speaker
 * whose proposal is staged for a decision must not learn that a decision has
 * been staged — that is intent leaking ahead of the organizer's own "inform"
 * step, and the wording is the only thing standing between the two.
 */
export const SPEAKER_EDIT_LOCK_COPY: Record<
  Exclude<SpeakerEditLockReason, null>,
  string
> = {
  review_advanced: "Editing is closed while the programme team reviews this proposal.",
  past_close_date: "Editing is closed because this CFP deadline has passed.",
  past_edit_deadline: "Editing is closed because the deadline for changes has passed.",
};

export const PROGRAMME_MISSING_COPY =
  "This accepted talk is missing its connected programme session. Contact the programme team.";

export const PARTICIPANT_CONFLICT_COPY =
  "Adding this co-author would double-book a speaker on a session that's already scheduled and public. Contact the programme team to resolve it.";
