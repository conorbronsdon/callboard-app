/**
 * The FIVE-step public submission wizard — the parts WS1a's form contract does
 * not own.
 *
 *   ① Welcome → ② Account → ③ Submission → ④ Participant → ⑤ Review
 *
 * Deliberately NOT the admin 7-step wizard (research/screenshot-ui-notes.md §3):
 * admin steps 1/5/6/7 are configuration, not pages, and the public flow inserts
 * `Account` and appends `Review`, neither of which the admin wizard configures.
 *
 * Validation, conditional visibility, combined counters and routing all come
 * from `./contract` (WS1a). What lives here is the step model, the chrome copy,
 * the live participant-role indicators, and the abstract-vs-video block.
 *
 * No I/O — pure functions of data the loader already fetched, so this unit-tests
 * without a database and runs identically on the server and in the browser.
 */
import {
  effectiveSubmissionLimit,
  type AnswerValue,
  type FormAnswers,
  type FormDefinition,
  type FormSettings,
  type ParticipantAnswers,
  type ParticipantRoleConfig,
} from "./contract";
import { formatInZone } from "~/lib/zoned-time";

/* ------------------------------------------------------------------ steps */

export const WIZARD_STEPS = [
  "welcome",
  "account",
  "submission",
  "participant",
  "review",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Fallback public step labels. Sessionboard sources three of them from the
 * admin "Page Heading" fields (15-char max, which is what that cap is FOR);
 * `Account` and `Review` have no admin-side config, so they are fixed.
 */
export const DEFAULT_STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Welcome!",
  account: "Account",
  submission: "Submission",
  participant: "Participant",
  review: "Review",
};

export const STEP_HEADING_MAX = 15;

export function isWizardStep(value: unknown): value is WizardStep {
  return (WIZARD_STEPS as readonly unknown[]).includes(value);
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  return stepIndex(step) === 0 ? null : (WIZARD_STEPS[stepIndex(step) - 1] ?? null);
}

export function stepPath(eventSlug: string, formId: string, step: WizardStep): string {
  return `/submit/${eventSlug}/${formId}/step/${step}`;
}

/** Stepper labels, taken from the admin page headings and capped at 15 chars. */
export function stepLabels(settings: FormSettings): Record<WizardStep, string> {
  const pick = (value: string | undefined, fallback: string) => {
    const trimmed = (value ?? "").trim();
    return trimmed ? trimmed.slice(0, STEP_HEADING_MAX) : fallback;
  };
  return {
    welcome: pick(settings?.welcome?.heading, DEFAULT_STEP_LABELS.welcome),
    account: DEFAULT_STEP_LABELS.account,
    submission: pick(settings?.abstract?.heading, DEFAULT_STEP_LABELS.submission),
    participant: pick(settings?.participant?.heading, DEFAULT_STEP_LABELS.participant),
    review: DEFAULT_STEP_LABELS.review,
  };
}

/**
 * Which step a visitor may actually be on. Account gates everything after it —
 * a submission needs an owner — so a logged-out visitor asking for `review`
 * lands on `account` rather than a 403.
 */
export function resolveStep(input: {
  requested: string | undefined;
  signedIn: boolean;
  hasDraft: boolean;
}): WizardStep {
  const requested = isWizardStep(input.requested) ? input.requested : "welcome";
  if (!input.signedIn && stepIndex(requested) > stepIndex("account")) return "account";
  if (!input.hasDraft && stepIndex(requested) > stepIndex("submission")) return "submission";
  return requested;
}

/** Chrome shared by every step. Declared here (not in a `.server` module) so the
 *  client components can import the type without dragging in server code. */
export interface WizardChrome {
  labels: Record<WizardStep, string>;
  closeSentence: string | null;
  limitSentence: string | null;
  /** Highest step the visitor may click back to. */
  furthest: WizardStep;
}

/* ----------------------------------------------------------- close gating */

/**
 * `no_eligible_tracks` is not a date or a status — it is the form being
 * unsubmittable for a reason the submitter cannot fix. See
 * `unsubmittableReason` in draft.server.ts, which is where it is decided; it
 * lives in this union so it renders through the SAME closed presentation
 * instead of inventing a second one.
 */
export type ClosedReason = "not_open" | "past_close_date" | "no_eligible_tracks" | null;

/**
 * Why the form is closed, or null when it accepts submissions.
 *
 * WS1a's `isFormOpen` answers the yes/no; the public page needs to say WHICH,
 * because "we haven't opened yet" and "you missed the deadline" are different
 * messages to a submitter who just followed a link.
 */
export function closedReason(
  def: Pick<FormDefinition, "status" | "closesAt">,
  now: number = Date.now(),
): ClosedReason {
  if (def.status !== "open") return "not_open";
  if (def.closesAt === null || def.closesAt === undefined) return null;
  return now > def.closesAt ? "past_close_date" : null;
}

/**
 * "Form submissions will be accepted until September 15, 2026 at 11:59 PM PDT."
 *
 * Rendered in the EVENT timezone (screenshot p15_1), as prose, above the fold.
 * The formatting goes through `formatInZone` — the same helper the admin close-
 * date field uses — so the deadline a submitter reads and the deadline an admin
 * typed can never disagree about which day it is.
 */
export function closeDateSentence(
  closesAt: number | null,
  timezone: string,
): string | null {
  const formatted = formatInZone(closesAt, timezone);
  if (!formatted) return null;
  return `Form submissions will be accepted until ${formatted}.`;
}

/* -------------------------------------------------------- submission limit */

export interface LimitCheck {
  limit: number | null;
  used: number;
  remaining: number | null;
  reached: boolean;
  /** True when the cap came from the event default rather than the form. */
  fromEvent: boolean;
}

/**
 * Two-level cap (screenshot p13_2, pill "Event max: 3 — applies when no
 * form-level limit is set"). `used` counts saved drafts AND submitted sessions,
 * per the same screenshot; withdrawn rows are excluded by the caller's query.
 */
export function checkSubmissionLimit(input: {
  formLimit: number | null;
  eventLimit: number | null;
  used: number;
}): LimitCheck {
  const limit = effectiveSubmissionLimit({ submissionLimit: input.formLimit }, input.eventLimit);
  const fromEvent = input.formLimit === null || input.formLimit === undefined;
  if (limit === null) {
    return { limit: null, used: input.used, remaining: null, reached: false, fromEvent };
  }
  return {
    limit,
    used: input.used,
    remaining: Math.max(0, limit - input.used),
    reached: input.used >= limit,
    fromEvent,
  };
}

export function submissionLimitSentence(check: LimitCheck): string | null {
  if (check.limit === null) return null;
  return `Submission Limit: ${check.limit} submission${check.limit === 1 ? "" : "s"} per user`;
}

/* ----------------------------------------------------------- participants */

/**
 * One participant as the public wizard edits them: identity fields the product
 * always collects, plus their answers to any participant-scope fields the form
 * defines. `role` matches a {@link ParticipantRoleConfig.key}.
 */
export interface DraftParticipant {
  role: string;
  firstName: string;
  lastName: string;
  email: string;
  bio?: string;
  /** The submitter. Exactly one participant is primary. */
  isPrimary?: boolean;
  /** Answers to participant-scope fields, when the form defines any. */
  answers?: Record<string, AnswerValue>;
}

export interface RoleState {
  role: string;
  label: string;
  min: number;
  max: number | null;
  added: number;
  /** "Speaker: 2–4 required · 1 added" */
  indicator: string;
  /** Red inline hint under the role select, or null when satisfied. */
  hint: string | null;
  satisfied: boolean;
}

export interface ParticipantCheck {
  roles: RoleState[];
  total: number;
  maxTotal: number | null;
  /** Blocking messages. Empty means the participant step may be left. */
  errors: string[];
  ok: boolean;
}

/** The roles a submitter may pick, in the order the builder listed them. */
export function enabledRoles(def: FormDefinition): ParticipantRoleConfig[] {
  return def.participants.roles.filter((role) => role.enabled);
}

export function roleLabel(def: FormDefinition, key: string): string {
  return def.participants.roles.find((role) => role.key === key)?.label ?? key;
}

/** "Speaker: 2–4 required · 1 added" — the exact pattern from the walkthrough. */
export function roleIndicator(role: ParticipantRoleConfig, added: number): string {
  const range =
    role.max === null
      ? `${role.min}+`
      : role.min === role.max
        ? `${role.min}`
        : `${role.min}–${role.max}`;
  return `${role.label}: ${range} required · ${added} added`;
}

/**
 * Live participant state: the summary indicators, the red inline hint per role,
 * and the blocking errors. One pure function so the SSR render and the
 * client-side live update cannot drift.
 *
 * Role bounds duplicate what WS1a's `validate()` reports as `role_min`/
 * `role_max` issues — deliberately. `validate()` is the authoritative gate at
 * submit; this produces the LIVE copy shown while typing, which needs the
 * "add 1 more" phrasing and a per-role breakdown that an issue list cannot give.
 */
export function checkParticipants(input: {
  def: FormDefinition;
  participants: DraftParticipant[];
}): ParticipantCheck {
  const { def } = input;
  const errors: string[] = [];

  const roles: RoleState[] = enabledRoles(def).map((role) => {
    const added = input.participants.filter((p) => p.role === role.key).length;
    let hint: string | null = null;
    if (added < role.min) {
      hint = `Add ${role.min - added} more ${role.label} (minimum ${role.min}).`;
      errors.push(hint);
    } else if (role.max !== null && added > role.max) {
      hint = `Remove ${added - role.max} ${role.label} (maximum ${role.max}).`;
      errors.push(hint);
    }
    return {
      role: role.key,
      label: role.label,
      min: role.min,
      max: role.max,
      added,
      indicator: roleIndicator(role, added),
      hint,
      satisfied: hint === null,
    };
  });

  const total = input.participants.length;
  const maxTotal = def.participants.maxTotal;
  if (maxTotal !== null && total > maxTotal) {
    errors.push(`This form allows at most ${maxTotal} participants in total.`);
  }
  if (def.participants.minTotal !== null && total < def.participants.minTotal) {
    errors.push(`This form needs at least ${def.participants.minTotal} participants.`);
  }

  const emails = input.participants.map((p) => p.email.trim().toLowerCase());
  const duplicate = emails.find((email, index) => email && emails.indexOf(email) !== index);
  if (duplicate) {
    errors.push(`${duplicate} is listed twice — each participant needs their own email.`);
  }

  if (input.participants.some((p) => !p.firstName.trim() || !p.lastName.trim())) {
    errors.push("Every participant needs a first and last name.");
  }
  const badEmail = input.participants.find(
    (p) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim()),
  );
  if (badEmail) {
    errors.push(`"${badEmail.email || "(blank)"}" is not a valid email address.`);
  }

  return { roles, total, maxTotal, errors, ok: errors.length === 0 };
}

/** Whether another participant may be added (drives the `+ Add` button state). */
export function canAddParticipant(check: ParticipantCheck): boolean {
  if (check.maxTotal !== null && check.total >= check.maxTotal) return false;
  return check.roles.some((role) => role.max === null || role.added < role.max);
}

/* -------------------------------------------------- answers <-> contract */

/** Bridge the wizard's draft shape into the `FormAnswers` the evaluator takes. */
export function toFormAnswers(
  fields: Record<string, AnswerValue>,
  participants: DraftParticipant[],
): FormAnswers {
  return {
    fields,
    participants: participants.map<ParticipantAnswers>((participant) => ({
      role: participant.role,
      answers: participant.answers ?? {},
    })),
  };
}

/* --------------------------------------------------- submission content */

export type ContentMode = "abstract" | "video";

/**
 * Reserved key for the submission-format block inside the draft's answers blob.
 * `__`-prefixed so it can never collide with a registry field key, and stripped
 * out of `sessions.answers` at submit time.
 */
export const CONTENT_KEY = "__content";

/**
 * Reserved key for the submitter's eligible-track choice inside the draft blob.
 * Same `__`-prefix rule as {@link CONTENT_KEY}: it is wizard scaffolding, not an
 * answer, so it lives beside the answers rather than among them and never
 * reaches `sessions.answers` at submit — the choice is written to the real
 * `sessions.track_id` column instead.
 */
export const TRACK_KEY = "__track";

/** The submission-format block: prose, a link, or an uploaded file. */
export interface DraftContent {
  mode: ContentMode;
  videoUrl: string;
  uploadKey: string | null;
  uploadName: string | null;
  uploadSize: number | null;
}

export const EMPTY_CONTENT: DraftContent = {
  mode: "abstract",
  videoUrl: "",
  uploadKey: null,
  uploadName: null,
  uploadSize: null,
};

export interface ContentCheck {
  mode: ContentMode;
  error: string | null;
}

const HTTP_URL = /^https?:\/\/[^\s.]+\.[^\s]+$/i;

/**
 * "Abstract text OR video link/upload" (PLAN §4 WS1b). A video submission needs
 * either a link or an uploaded file; an abstract submission needs prose.
 * `allowed` comes from the form; `either` leaves the choice to the submitter.
 *
 * `collectsAbstract` is load-bearing: plenty of real forms never ask for prose
 * at all (a title-and-track form, or one with no questions yet). Demanding "an
 * abstract" from a form that has no abstract field is an unsatisfiable error —
 * there is no box to type it in. When the form does not collect one, its own
 * required fields are the whole contract and this check stands down.
 */
export function checkContent(input: {
  allowed: ContentMode | "either";
  /** True when the form has a field the abstract text would go in. */
  collectsAbstract: boolean;
  mode: string | undefined;
  abstract: string;
  videoUrl: string;
  uploadKey: string | null;
}): ContentCheck {
  const mode: ContentMode =
    input.allowed === "either" ? (input.mode === "video" ? "video" : "abstract") : input.allowed;

  if (mode === "video") {
    if (!input.videoUrl.trim() && !input.uploadKey) {
      return { mode, error: "Add a video link or upload a file." };
    }
    if (input.videoUrl.trim() && !HTTP_URL.test(input.videoUrl.trim())) {
      return { mode, error: "The video link must start with http:// or https://." };
    }
    return { mode, error: null };
  }

  if (input.collectsAbstract && !input.abstract.trim()) {
    return { mode, error: "Write an abstract, or switch to a video submission." };
  }
  return { mode, error: null };
}
