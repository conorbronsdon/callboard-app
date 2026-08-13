/**
 * Form definitions + the pure evaluator behind them. WS1a owns this file; WS1b
 * (public submission wizard) and WS2 (routing into review) consume it.
 *
 * PURE. No I/O, no bindings, no DB reads — everything the evaluator needs is in
 * the `FormDefinition` handed to it. That is what makes the rules unit-testable
 * and what lets the public wizard run the SAME validation server-side on submit
 * and client-side while typing.
 *
 * ── Where this lives in the database ────────────────────────────────────────
 * `forms` has real columns for the scalars an admin list/query needs
 * (`name`, `target`, `status`, `closes_at`, `submission_limit`,
 * `min_speakers`, `max_speakers`, `max_participants_total`,
 * `allow_multiple_drafts`, `welcome_*`, `thank_you_body`). Those columns stay
 * the single source of truth — they are NOT duplicated into JSON.
 *
 * `forms.schema` (JSON) holds a {@link FormSchema}: the ordered field refs and
 * the four rule families (conditional logic, cross-field combined limits,
 * category routing, participant roles).
 * `forms.settings` (JSON) holds a {@link FormSettings}: wizard copy, success
 * page behaviour, and notification config.
 *
 * `toFormDefinition(row)` splices a form row + its two JSON blobs into the flat
 * {@link FormDefinition} the evaluator takes. Persist with
 * `formSchemaOf(def)` / `formSettingsOf(def)` plus the scalar columns.
 *
 * ── Rule precedence (documented because it is the part that surprises) ──────
 * Visibility: a field is visible by default. A field that is the TARGET of at
 * least one `show` rule is hidden by default and appears only when one of its
 * `show` rules fires. Any firing `hide` rule wins over any firing `show` rule.
 * Requiredness: base `required` on the field ref, then a firing `require` rule
 * forces required, then a firing `optional` rule clears it (optional wins —
 * it is the escape hatch).
 * Hidden fields are never required, are never validated, and never count
 * toward a combined character limit. A rule cannot make an invisible answer
 * block a submission.
 */
import type { FieldType, FormStatus, FormTarget } from "~/db/schema";

export type { FieldType, FormStatus, FormTarget };

/** Current shape version, bumped when a migration of the JSON blob is needed. */
export const FORM_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ values */

export type AnswerValue = string | number | boolean | string[] | null | undefined;

/** One participant's role plus their answers to the participant-scope fields. */
export type ParticipantAnswers = {
  /** Role key, e.g. "speaker" — matches a {@link ParticipantRoleConfig.key}. */
  role: string;
  answers: Record<string, AnswerValue>;
};

/**
 * Everything a submitter has entered. `fields` are the submission-scope
 * answers (wizard step "Abstract Information"); `participants` repeat the
 * participant-scope fields once per person.
 */
export type FormAnswers = {
  fields: Record<string, AnswerValue>;
  participants: ParticipantAnswers[];
};

/** Which half of the form a field or rule applies to. */
export type FieldScope = "submission" | "participant";

/* ------------------------------------------------------------------ fields */

/** Per-field validation. Overlays (and may tighten) the registry constraints. */
export type FieldValidation = {
  required?: boolean;
  /** Text length, measured in characters after HTML is stripped from wysiwyg. */
  minLength?: number;
  maxLength?: number;
  /** Numeric bounds (number fields). */
  min?: number;
  max?: number;
  /** Regex source, applied to the string form of the answer. */
  pattern?: string;
  patternMessage?: string;
  /** Allowed values for select/radio/multiselect. Empty/absent = anything. */
  options?: string[];
  /** Selection count bounds for multiselect. */
  minSelected?: number;
  maxSelected?: number;
};

/**
 * A field ON a form. References the per-event registry (`fields.id`) and
 * denormalises `key`/`type`/`options` so the evaluator stays pure — the public
 * form never has to join back to the registry to validate an answer.
 */
export type FormFieldRef = {
  /** `fields.id` in the per-event registry. */
  fieldId: string;
  /** `fields.key` — the key this answer is stored under. */
  key: string;
  /** Registry type. Immutable after the registry field is created. */
  type: FieldType;
  /** Registry label, or a per-form override. */
  label: string;
  helpText?: string;
  scope: FieldScope;
  order: number;
  required: boolean;
  /** System field: reorderable, never deletable, Required toggle disabled-on. */
  locked?: boolean;
  validation?: FieldValidation;
};

/* ------------------------------------------------------- conditional logic */

export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
  "in",
  "not_in",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that ignore `value` entirely — the rule editor hides the input. */
export const VALUELESS_OPERATORS: readonly ConditionOperator[] = ["is_empty", "is_not_empty"];

export type Condition = {
  /** Key of the field being tested. */
  fieldKey: string;
  op: ConditionOperator;
  value?: AnswerValue;
};

export const RULE_ACTIONS = ["show", "hide", "require", "optional"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** "when <field> <op> <value> then <action> <fields>" — the visual rule editor. */
export type ConditionalRule = {
  id: string;
  /** Human label shown in the admin list of rules. Optional. */
  label?: string;
  /** `all` = AND across conditions, `any` = OR. */
  match: "all" | "any";
  when: Condition[];
  action: RuleAction;
  /** Field keys the action applies to. */
  targetKeys: string[];
  /** Participant-scope rules resolve conditions against that participant first. */
  scope?: FieldScope;
  enabled?: boolean;
};

/* --------------------------------------------------- cross-field limits */

/**
 * Cross-field combined character limit — red-marked "make sure this works" in the buyer's brief.
 * Caps the COMBINED length of several text fields (a printed-program block).
 * Submitters see one live counter for the group; participant-scope rules apply
 * separately to each participant.
 */
export type CombinedLimitRule = {
  id: string;
  label: string;
  fieldKeys: string[];
  maxChars: number;
  scope: FieldScope;
  enabled?: boolean;
};

/** One live counter, as rendered next to the group on the public form. */
export type CombinedCounter = {
  ruleId: string;
  label: string;
  scope: FieldScope;
  /** null for submission scope; the participant index for participant scope. */
  participantIndex: number | null;
  /** Keys actually counted — hidden fields are excluded. */
  countedKeys: string[];
  used: number;
  max: number;
  remaining: number;
  over: boolean;
};

/* -------------------------------------------------------- category routing */

/**
 * "when <conditions> then file it under track X" — first match in `order` wins.
 *
 * TRACKS ARE THE CATEGORY MODEL (DECISIONS.md #25). There is no separate
 * category entity: a routing rule carries a typed `tracks.id`, which is the
 * same id the abstracts table, the agenda and the embeds already render. The
 * brief's "category-based routing" is this.
 */
export type RoutingRule = {
  id: string;
  label?: string;
  match: "all" | "any";
  when: Condition[];
  /** `tracks.id` for this event. */
  trackId: string;
  /** Optional downstream hint for WS2's batch assignment. */
  reviewTeamKey?: string;
  order: number;
  enabled?: boolean;
};

export type RoutingConfig = {
  rules: RoutingRule[];
  /** `tracks.id` applied when no rule matches. null = leave the track unset. */
  defaultTrackId: string | null;
  defaultReviewTeamKey?: string | null;
};

export type RoutingOutcome = {
  /** `tracks.id`, ready to write straight to `sessions.track_id`. */
  trackId: string | null;
  reviewTeamKey: string | null;
  /** The rule that decided this, or null when the default applied. */
  ruleId: string | null;
};

/* -------------------------------------------------------- eligible tracks */

/**
 * The producer-friendly alternative to routing rules (issue #1, buyer note: "add a
 * producer-friendly 'eligible tracks' control instead of relying on advanced
 * routing rules").
 *
 * Routing answers "given these answers, which track does this belong in?" —
 * powerful, and the wrong question for the common case, which is "this call
 * takes Agents and Infrastructure talks, let the submitter say which". An
 * `eligibleTrackIds` list turns that into one checkbox column in the builder
 * and one select on the public form.
 *
 * EMPTY MEANS OFF. A form with no eligible tracks behaves exactly as it did
 * before this existed: no picker, and routing decides the track. That is what
 * keeps this additive rather than a change of behaviour for every form already
 * built.
 */
export type EligibleTrackCheck =
  | { ok: true; trackId: string | null }
  | { ok: false; error: string };

export const ELIGIBLE_TRACK_UNSET_ERROR = "Choose a track for this submission.";
export const ELIGIBLE_TRACK_INVALID_ERROR =
  "That track is not open to this form. Choose one of the listed tracks.";

/**
 * Is `chosen` an acceptable track for a form with this eligible list?
 *
 * Pure and shared: the wizard step, the review step and the write inside
 * `submitDraft` all call this, so "the UI hid it" and "the server refused it"
 * cannot drift into different answers. A membership test on an allowlist is
 * also the only shape that stays safe when the caller is a hand-rolled POST —
 * there is no path where an id the organizer never picked becomes acceptable
 * because it happens to be a real track.
 */
export function checkEligibleTrack(input: {
  eligibleTrackIds: readonly string[];
  chosen: string | null | undefined;
}): EligibleTrackCheck {
  const chosen = (input.chosen ?? "").trim();
  if (input.eligibleTrackIds.length === 0) {
    // Control is off. The submitter has no picker, so anything they posted is
    // noise from a hand-built request and is discarded rather than honoured.
    return { ok: true, trackId: null };
  }
  if (!chosen) return { ok: false, error: ELIGIBLE_TRACK_UNSET_ERROR };
  if (!input.eligibleTrackIds.includes(chosen)) {
    return { ok: false, error: ELIGIBLE_TRACK_INVALID_ERROR };
  }
  return { ok: true, trackId: chosen };
}

/**
 * The track a submission actually lands in.
 *
 * The submitter's choice wins when the form offers one — the whole point of
 * asking is that the answer is used. Routing still decides for forms that never
 * turned the control on, and still fills in a track for an eligible-tracks form
 * only if somehow no choice survived (it cannot, given the check above, but a
 * silent null here would strand the row outside every track filter).
 */
export function resolveSubmittedTrack(input: {
  eligibleTrackIds: readonly string[];
  chosen: string | null | undefined;
  routed: string | null;
}): string | null {
  if (input.eligibleTrackIds.length === 0) return input.routed;
  const chosen = (input.chosen ?? "").trim();
  if (chosen && input.eligibleTrackIds.includes(chosen)) return chosen;
  return input.routed;
}

/* ------------------------------------------------------------ participants */

/**
 * A selectable participant role with per-role bounds.
 * DECISIONS.md #7: `min` defaults to 1 — a min of 2 broke the incumbent product's demo on camera.
 */
export type ParticipantRoleConfig = {
  key: string;
  label: string;
  enabled: boolean;
  min: number;
  max: number | null;
};

export type ParticipantsConfig = {
  /** Wizard step 4 exists only when this is true (step-1 Participants toggle). */
  collect: boolean;
  roles: ParticipantRoleConfig[];
  /** Cap across ALL roles combined. null = no overall cap. */
  maxTotal: number | null;
  minTotal: number | null;
};

/* --------------------------------------------------------------- settings */

export type NotificationSettings = {
  /** Red-marked "must have": confirmation email to the submitter. */
  confirmationEmail: { enabled: boolean; subject: string; body: string };
  /** Draft-reminder nudge; only meaningful when a close date is set. */
  reminderEmail: { enabled: boolean; daysBeforeClose: number; subject: string; body: string };
  /** Red-marked "nice to have": admin alert routing. */
  notifyOnNew: string[];
  notifyOnUpdate: string[];
};

/** Per-step copy. Page headings are the labels of the PUBLIC 5-step stepper. */
export type StepCopy = {
  /** Section title shown above the questions. */
  title: string;
  /** ≤15 chars — this is what the public stepper renders. */
  heading: string;
  /** Rich-text intro. */
  body: string;
};

/**
 * When a speaker may still correct a submission they already sent (issue #1,
 * buyer note: "add configurable post-submit edit deadlines if an operator needs
 * them").
 *
 * This CONFIGURES the existing CFP-close edit lock rather than adding a rival
 * one — `app/lib/portal/submission-edit.ts` owns the single date gate and this
 * only picks which date it reads. `cfp_close` is the default and is exactly
 * what shipped before, so a form that never touches this setting is unchanged.
 */
export type EditDeadlineMode = "cfp_close" | "custom" | "open";

export type EditDeadlinePolicy = {
  mode: EditDeadlineMode;
  /** Epoch ms. Meaningful only for `custom`. */
  at: number | null;
};

export type FormSettings = {
  welcome: StepCopy;
  abstract: StepCopy;
  participant: StepCopy;
  /** Success page (red-marked "make sure this works"). */
  autoRedirectToPortal: boolean;
  successMessage: string;
  notifications: NotificationSettings;
  editDeadline: EditDeadlinePolicy;
};

/* ------------------------------------------------ persisted JSON + runtime */

/** Exactly what lives in `forms.schema`. */
export type FormSchema = {
  version: typeof FORM_SCHEMA_VERSION;
  fields: FormFieldRef[];
  rules: ConditionalRule[];
  combinedLimits: CombinedLimitRule[];
  routing: RoutingConfig;
  /** `tracks.id` list this form accepts. Empty = control off; see above. */
  eligibleTrackIds: string[];
  participants: ParticipantsConfig;
};

/** The flat shape every evaluator function takes. */
export type FormDefinition = FormSchema & {
  id: string;
  name: string;
  target: FormTarget;
  status: FormStatus;
  /** Epoch ms. null = never closes. */
  closesAt: number | null;
  /** Per-person cap; null falls back to `events.submission_limit`. */
  submissionLimit: number | null;
  allowMultipleDrafts: boolean;
  settings: FormSettings;
};

/* ------------------------------------------------------------- defaults */

export const DEFAULT_PARTICIPANT_ROLES: ParticipantRoleConfig[] = [
  { key: "speaker", label: "Speaker", enabled: true, min: 1, max: null },
  { key: "co_speaker", label: "Co-speaker", enabled: false, min: 0, max: null },
  { key: "chairperson", label: "Chairperson", enabled: false, min: 0, max: null },
  { key: "moderator", label: "Moderator", enabled: false, min: 0, max: null },
  { key: "panelist", label: "Panelist", enabled: false, min: 0, max: null },
];

export function emptyFormSchema(): FormSchema {
  return {
    version: FORM_SCHEMA_VERSION,
    fields: [],
    rules: [],
    combinedLimits: [],
    routing: { rules: [], defaultTrackId: null },
    eligibleTrackIds: [],
    participants: {
      collect: true,
      roles: DEFAULT_PARTICIPANT_ROLES.map((role) => ({ ...role })),
      maxTotal: null,
      minTotal: null,
    },
  };
}

export function emptyFormSettings(): FormSettings {
  return {
    welcome: { title: "", heading: "Welcome", body: "" },
    abstract: { title: "Tell us about your submission", heading: "Submission", body: "" },
    participant: { title: "Tell us about you", heading: "Participant", body: "" },
    autoRedirectToPortal: true,
    successMessage:
      "Thanks — you'll get a confirmation email shortly with a link to your speaker portal.",
    notifications: {
      confirmationEmail: {
        enabled: true,
        subject: "We got your submission",
        body: "Thanks for submitting. You can track it in your speaker portal.",
      },
      reminderEmail: {
        enabled: false,
        daysBeforeClose: 3,
        subject: "Your draft submission is still open",
        body: "You have a draft that has not been submitted yet.",
      },
      notifyOnNew: [],
      notifyOnUpdate: [],
    },
    editDeadline: { mode: "cfp_close", at: null },
  };
}

/* -------------------------------------------------- parse / serialise */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Tolerant parse of the `forms.schema` blob. Unknown/absent keys fall back to
 * the empty schema, so an older row never crashes the builder or the public
 * form — it just renders with defaults.
 */
export function parseFormSchema(raw: unknown): FormSchema {
  const base = emptyFormSchema();
  if (!isRecord(raw)) return base;

  const participants = isRecord(raw.participants) ? raw.participants : {};
  const routing = isRecord(raw.routing) ? raw.routing : {};

  return {
    version: FORM_SCHEMA_VERSION,
    // Tolerant on purpose: a ref written before this shape existed carries only
    // `{ fieldId, key }`. Fill in placeholders here and let `hydrateFieldRefs`
    // replace them with the registry's real label and type.
    fields: asArray<FormFieldRef>(raw.fields).map((field, index) => ({
      ...field,
      key: field.key ?? "",
      label: field.label || field.key || "Untitled field",
      type: field.type ?? "text",
      scope: field.scope === "participant" ? "participant" : "submission",
      order: typeof field.order === "number" ? field.order : index,
      required: Boolean(field.required),
    })),
    rules: asArray<ConditionalRule>(raw.rules),
    combinedLimits: asArray<CombinedLimitRule>(raw.combinedLimits),
    routing: {
      // A rule without a track id cannot route anywhere, so it is dropped
      // rather than kept as a rule that silently never assigns anything.
      rules: asArray<RoutingRule>(routing.rules).filter(
        (rule) => typeof rule.trackId === "string" && rule.trackId.length > 0,
      ),
      defaultTrackId: typeof routing.defaultTrackId === "string" ? routing.defaultTrackId : null,
      defaultReviewTeamKey:
        typeof routing.defaultReviewTeamKey === "string" ? routing.defaultReviewTeamKey : null,
    },
    // Deduplicated and blank-stripped: this list is an allowlist the public form
    // is checked against, so a stray "" would make "no track" acceptable on a
    // form that requires one.
    eligibleTrackIds: Array.from(
      new Set(
        asArray<unknown>(raw.eligibleTrackIds).filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ),
      ),
    ),
    participants: {
      collect: participants.collect === undefined ? true : Boolean(participants.collect),
      roles: asArray<ParticipantRoleConfig>(participants.roles).length
        ? asArray<ParticipantRoleConfig>(participants.roles).map((role) => ({
            ...role,
            min: Number.isFinite(role.min) ? Number(role.min) : 0,
            max: role.max === null || role.max === undefined ? null : Number(role.max),
            enabled: Boolean(role.enabled),
          }))
        : base.participants.roles,
      maxTotal:
        participants.maxTotal === null || participants.maxTotal === undefined
          ? null
          : Number(participants.maxTotal),
      minTotal:
        participants.minTotal === null || participants.minTotal === undefined
          ? null
          : Number(participants.minTotal),
    },
  };
}

/**
 * Tolerant parse of one edit-deadline policy.
 *
 * `custom` with no usable date collapses back to `cfp_close`. A half-saved
 * custom policy must not read as "no deadline": that would quietly REOPEN
 * editing on a form whose operator was in the middle of closing it, which is
 * the one direction a misconfiguration here must never fail in.
 */
export function parseEditDeadline(raw: unknown): EditDeadlinePolicy {
  if (!isRecord(raw)) return { mode: "cfp_close", at: null };

  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null;

  if (raw.mode === "open") return { mode: "open", at: null };
  if (raw.mode === "custom") {
    return at === null ? { mode: "cfp_close", at: null } : { mode: "custom", at };
  }
  return { mode: "cfp_close", at: null };
}

/** Tolerant parse of the `forms.settings` blob (same contract as above). */
export function parseFormSettings(raw: unknown): FormSettings {
  const base = emptyFormSettings();
  if (!isRecord(raw)) return base;
  const notifications = isRecord(raw.notifications) ? raw.notifications : {};

  const step = (value: unknown, fallback: StepCopy): StepCopy =>
    isRecord(value)
      ? {
          title: typeof value.title === "string" ? value.title : fallback.title,
          heading: typeof value.heading === "string" ? value.heading : fallback.heading,
          body: typeof value.body === "string" ? value.body : fallback.body,
        }
      : fallback;

  return {
    welcome: step(raw.welcome, base.welcome),
    abstract: step(raw.abstract, base.abstract),
    participant: step(raw.participant, base.participant),
    autoRedirectToPortal:
      raw.autoRedirectToPortal === undefined
        ? base.autoRedirectToPortal
        : Boolean(raw.autoRedirectToPortal),
    successMessage:
      typeof raw.successMessage === "string" ? raw.successMessage : base.successMessage,
    notifications: {
      confirmationEmail: isRecord(notifications.confirmationEmail)
        ? {
            ...base.notifications.confirmationEmail,
            ...(notifications.confirmationEmail as object),
          }
        : base.notifications.confirmationEmail,
      reminderEmail: isRecord(notifications.reminderEmail)
        ? { ...base.notifications.reminderEmail, ...(notifications.reminderEmail as object) }
        : base.notifications.reminderEmail,
      notifyOnNew: asArray<string>(notifications.notifyOnNew),
      notifyOnUpdate: asArray<string>(notifications.notifyOnUpdate),
    },
    editDeadline: parseEditDeadline(raw.editDeadline),
  };
}

/** Row shape needed to build a definition — a subset of `typeof forms.$inferSelect`. */
export type FormRowLike = {
  id: string;
  name: string;
  target: FormTarget;
  status: FormStatus;
  schema: unknown;
  settings: unknown;
  closesAt: Date | number | null;
  submissionLimit: number | null;
  allowMultipleDrafts: boolean;
};

const toEpoch = (value: Date | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
};

/** Splice a `forms` row + its JSON blobs into the evaluator's input. */
export function toFormDefinition(row: FormRowLike): FormDefinition {
  return {
    ...parseFormSchema(row.schema),
    id: row.id,
    name: row.name,
    target: row.target,
    status: row.status,
    closesAt: toEpoch(row.closesAt),
    submissionLimit: row.submissionLimit,
    allowMultipleDrafts: row.allowMultipleDrafts,
    settings: parseFormSettings(row.settings),
  };
}

/* ------------------------------------------------- registry hydration */

/** A `fields` row, narrowed to what a form ref needs. */
export type RegistryFieldLike = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  helpText?: string | null;
  constraints?: unknown;
  isLocked?: boolean | null;
};

/** Registry `constraints` JSON → the evaluator's per-field validation. */
export function validationFromConstraints(raw: unknown): FieldValidation | undefined {
  if (!isRecord(raw)) return undefined;
  const out: FieldValidation = {};
  for (const key of [
    "minLength",
    "maxLength",
    "min",
    "max",
    "minSelected",
    "maxSelected",
  ] as const) {
    if (typeof raw[key] === "number") out[key] = raw[key] as number;
  }
  if (typeof raw.pattern === "string") out.pattern = raw.pattern;
  if (Array.isArray(raw.options)) out.options = raw.options.map(String);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Refresh denormalised field data from the per-event registry.
 *
 * Adding a field to a form stores a REFERENCE, not a copy — "editing a Track
 * dropdown's options in the Library changes every form at once"
 * (research/screenshot-ui-notes.md §8). The ref carries `label`/`type` only so
 * the evaluator can stay pure; whenever the registry is at hand, this puts the
 * authoritative values back.
 *
 * `type` and `key` always come from the registry (a field's type is immutable
 * there). `label` prefers a per-form override. A ref whose registry row is gone
 * keeps its stored values rather than vanishing from the admin's form.
 */
export function hydrateFieldRefs(
  refs: FormFieldRef[],
  registry: RegistryFieldLike[],
): FormFieldRef[] {
  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  const byKey = new Map(registry.map((entry) => [entry.key, entry]));

  return refs.map((ref) => {
    const entry = byId.get(ref.fieldId) ?? byKey.get(ref.key);
    if (!entry) return ref;

    const fromRegistry = validationFromConstraints(entry.constraints);
    const registryRequired = isRecord(entry.constraints)
      ? Boolean(entry.constraints.required)
      : false;

    return {
      ...ref,
      fieldId: entry.id,
      key: entry.key,
      type: entry.type,
      label: ref.label && ref.label !== ref.key ? ref.label : entry.label,
      helpText: ref.helpText ?? entry.helpText ?? undefined,
      locked: entry.isLocked ?? ref.locked,
      required: ref.required || registryRequired || Boolean(entry.isLocked),
      validation: ref.validation ?? fromRegistry,
    };
  });
}

/** The half of a definition that belongs in `forms.schema`. */
export function formSchemaOf(def: FormDefinition): FormSchema {
  return {
    version: FORM_SCHEMA_VERSION,
    fields: def.fields,
    rules: def.rules,
    combinedLimits: def.combinedLimits,
    routing: def.routing,
    eligibleTrackIds: def.eligibleTrackIds,
    participants: def.participants,
  };
}

/** The half of a definition that belongs in `forms.settings`. */
export function formSettingsOf(def: FormDefinition): FormSettings {
  return def.settings;
}

/* ------------------------------------------------------------ primitives */

/**
 * Characters as a human counts them. Wysiwyg answers arrive as HTML, so the
 * markup is stripped before counting — otherwise `<p>hi</p>` costs 11 of a
 * 500-char budget. `&nbsp;` and friends collapse to one character.
 */
export function countChars(value: AnswerValue, type?: FieldType): number {
  return textOf(value, type).length;
}

const HTML_TYPES: readonly FieldType[] = ["wysiwyg"];

export function textOf(value: AnswerValue, type?: FieldType): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  const raw = String(value);
  if (type && HTML_TYPES.includes(type)) {
    return raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .trim();
  }
  return raw;
}

export function isBlank(value: AnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  return String(value).trim() === "";
}

const numberOf = (value: AnswerValue): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) ? n : null;
};

const sameValue = (a: AnswerValue, b: AnswerValue): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [String(a ?? "")];
    const right = Array.isArray(b) ? b : [String(b ?? "")];
    return left.length === right.length && left.every((item, i) => String(item) === String(right[i]));
  }
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a ?? "").trim() === String(b ?? "").trim();
};

/** Evaluate one condition against a lookup of answers. Pure, total, no throws. */
export function evaluateCondition(
  condition: Condition,
  lookup: (key: string) => AnswerValue,
): boolean {
  const answer = lookup(condition.fieldKey);
  const target = condition.value;

  switch (condition.op) {
    case "equals":
      return sameValue(answer, target);
    case "not_equals":
      return !sameValue(answer, target);
    case "is_empty":
      return isBlank(answer);
    case "is_not_empty":
      return !isBlank(answer);
    case "contains": {
      if (Array.isArray(answer)) return answer.some((item) => sameValue(item, target));
      return textOf(answer).toLowerCase().includes(String(target ?? "").toLowerCase());
    }
    case "not_contains": {
      if (Array.isArray(answer)) return !answer.some((item) => sameValue(item, target));
      return !textOf(answer).toLowerCase().includes(String(target ?? "").toLowerCase());
    }
    case "greater_than": {
      const a = numberOf(answer);
      const b = numberOf(target);
      return a !== null && b !== null && a > b;
    }
    case "less_than": {
      const a = numberOf(answer);
      const b = numberOf(target);
      return a !== null && b !== null && a < b;
    }
    case "in": {
      const list = Array.isArray(target) ? target : [target as AnswerValue];
      if (Array.isArray(answer)) return answer.some((item) => list.some((v) => sameValue(item, v)));
      return list.some((v) => sameValue(answer, v));
    }
    case "not_in": {
      const list = Array.isArray(target) ? target : [target as AnswerValue];
      if (Array.isArray(answer)) return !answer.some((item) => list.some((v) => sameValue(item, v)));
      return !list.some((v) => sameValue(answer, v));
    }
    default:
      return false;
  }
}

function matches(
  match: "all" | "any",
  conditions: Condition[],
  lookup: (key: string) => AnswerValue,
): boolean {
  // A rule with no conditions never fires. "Always show" is the default state,
  // so an empty rule is an unfinished rule, not an unconditional one.
  if (!conditions.length) return false;
  return match === "any"
    ? conditions.some((c) => evaluateCondition(c, lookup))
    : conditions.every((c) => evaluateCondition(c, lookup));
}

/**
 * Answer lookup for a given scope. Participant-scope lookups check that
 * participant's own answers first, then fall back to the submission answers —
 * so "when track = Workshops, require bio" works on a per-speaker field.
 */
function lookupFor(
  answers: FormAnswers,
  participantIndex: number | null,
): (key: string) => AnswerValue {
  if (participantIndex === null) return (key) => answers.fields?.[key];
  const own = answers.participants?.[participantIndex]?.answers ?? {};
  return (key) => (key in own ? own[key] : answers.fields?.[key]);
}

/* -------------------------------------------------- visibility + required */

export type FieldState = {
  visible: boolean;
  required: boolean;
};

function activeRules(def: FormDefinition, scope: FieldScope): ConditionalRule[] {
  return def.rules.filter(
    (rule) => rule.enabled !== false && (rule.scope ?? "submission") === scope,
  );
}

/**
 * Resolve visibility + requiredness for every field in a scope. See the
 * precedence note at the top of this file.
 */
export function fieldStates(
  answers: FormAnswers,
  def: FormDefinition,
  scope: FieldScope = "submission",
  participantIndex: number | null = null,
): Map<string, FieldState> {
  const lookup = lookupFor(answers, scope === "participant" ? (participantIndex ?? 0) : null);
  const rules = activeRules(def, scope);
  const scoped = def.fields.filter((field) => field.scope === scope);

  const showTargets = new Set<string>();
  for (const rule of rules) {
    if (rule.action === "show") for (const key of rule.targetKeys) showTargets.add(key);
  }

  const fired = { show: new Set<string>(), hide: new Set<string>(), require: new Set<string>(), optional: new Set<string>() };
  for (const rule of rules) {
    if (!matches(rule.match, rule.when, lookup)) continue;
    for (const key of rule.targetKeys) fired[rule.action].add(key);
  }

  const states = new Map<string, FieldState>();
  for (const field of scoped) {
    // Default visible, unless some rule claims the right to reveal it.
    let visible = showTargets.has(field.key) ? fired.show.has(field.key) : true;
    if (fired.hide.has(field.key)) visible = false;

    let required = field.required;
    if (fired.require.has(field.key)) required = true;
    if (fired.optional.has(field.key)) required = false;
    if (!visible) required = false;

    states.set(field.key, { visible, required });
  }
  return states;
}

/** The submission-scope fields a submitter should see, in order. */
export function visibleFields(answers: FormAnswers, def: FormDefinition): FormFieldRef[] {
  const states = fieldStates(answers, def, "submission");
  return def.fields
    .filter((field) => field.scope === "submission" && states.get(field.key)?.visible)
    .sort((a, b) => a.order - b.order);
}

/** The participant-scope fields for ONE participant, in order. */
export function visibleParticipantFields(
  answers: FormAnswers,
  def: FormDefinition,
  participantIndex: number,
): FormFieldRef[] {
  const states = fieldStates(answers, def, "participant", participantIndex);
  return def.fields
    .filter((field) => field.scope === "participant" && states.get(field.key)?.visible)
    .sort((a, b) => a.order - b.order);
}

/* ---------------------------------------------------- combined counters */

/**
 * Live combined character counters — one per rule (submission scope) or one
 * per rule per participant (participant scope). Hidden fields do not count.
 */
export function combinedCounters(answers: FormAnswers, def: FormDefinition): CombinedCounter[] {
  const out: CombinedCounter[] = [];
  const byKey = new Map(def.fields.map((field) => [field.key, field]));

  for (const rule of def.combinedLimits) {
    if (rule.enabled === false) continue;

    const build = (participantIndex: number | null): CombinedCounter => {
      const states = fieldStates(
        answers,
        def,
        rule.scope,
        rule.scope === "participant" ? (participantIndex ?? 0) : null,
      );
      const source =
        rule.scope === "participant"
          ? (answers.participants?.[participantIndex ?? 0]?.answers ?? {})
          : (answers.fields ?? {});

      const countedKeys = rule.fieldKeys.filter((key) => states.get(key)?.visible !== false);
      const used = countedKeys.reduce(
        (total, key) => total + countChars(source[key], byKey.get(key)?.type),
        0,
      );

      return {
        ruleId: rule.id,
        label: rule.label,
        scope: rule.scope,
        participantIndex,
        countedKeys,
        used,
        max: rule.maxChars,
        remaining: rule.maxChars - used,
        over: used > rule.maxChars,
      };
    };

    if (rule.scope === "participant") {
      const count = answers.participants?.length ?? 0;
      for (let i = 0; i < count; i += 1) out.push(build(i));
    } else {
      out.push(build(null));
    }
  }
  return out;
}

/* ------------------------------------------------------------- validation */

export const ISSUE_CODES = [
  "form_closed",
  "required",
  "min_length",
  "max_length",
  "min",
  "max",
  "pattern",
  "option",
  "min_selected",
  "max_selected",
  "combined_limit",
  "role_min",
  "role_max",
  "participants_max_total",
  "participants_min_total",
  "unknown_role",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export type ValidationIssue = {
  code: IssueCode;
  message: string;
  fieldKey?: string;
  /** Set for participant-scope issues. */
  participantIndex?: number;
  roleKey?: string;
  ruleId?: string;
  limit?: number;
  actual?: number;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
  counters: CombinedCounter[];
};

export type ValidateOptions = {
  /** Epoch ms. When given, a past close date fails the submission. */
  now?: number;
  /** Drafts skip required/min checks but still cannot exceed a max. */
  draft?: boolean;
};

function validateField(
  field: FormFieldRef,
  value: AnswerValue,
  required: boolean,
  participantIndex: number | null,
  draft: boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = participantIndex === null ? {} : { participantIndex };
  const rules = field.validation ?? {};

  if (isBlank(value)) {
    if (required && !draft) {
      issues.push({
        code: "required",
        message: `${field.label} is required.`,
        fieldKey: field.key,
        ...at,
      });
    }
    // Nothing else to check on an empty answer.
    return issues;
  }

  const text = textOf(value, field.type);
  const length = text.length;

  if (rules.minLength !== undefined && length < rules.minLength && !draft) {
    issues.push({
      code: "min_length",
      message: `${field.label} must be at least ${rules.minLength} characters (currently ${length}).`,
      fieldKey: field.key,
      limit: rules.minLength,
      actual: length,
      ...at,
    });
  }
  if (rules.maxLength !== undefined && length > rules.maxLength) {
    issues.push({
      code: "max_length",
      message: `${field.label} must be ${rules.maxLength} characters or fewer (currently ${length}).`,
      fieldKey: field.key,
      limit: rules.maxLength,
      actual: length,
      ...at,
    });
  }

  if (field.type === "number") {
    const n = numberOf(value);
    if (n === null) {
      issues.push({
        code: "pattern",
        message: `${field.label} must be a number.`,
        fieldKey: field.key,
        ...at,
      });
    } else {
      if (rules.min !== undefined && n < rules.min) {
        issues.push({
          code: "min",
          message: `${field.label} must be at least ${rules.min}.`,
          fieldKey: field.key,
          limit: rules.min,
          actual: n,
          ...at,
        });
      }
      if (rules.max !== undefined && n > rules.max) {
        issues.push({
          code: "max",
          message: `${field.label} must be at most ${rules.max}.`,
          fieldKey: field.key,
          limit: rules.max,
          actual: n,
          ...at,
        });
      }
    }
  }

  if (rules.pattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(rules.pattern);
    } catch {
      re = null; // A broken pattern must not block a submitter.
    }
    if (re && !re.test(text)) {
      issues.push({
        code: "pattern",
        message: rules.patternMessage ?? `${field.label} is not in the expected format.`,
        fieldKey: field.key,
        ...at,
      });
    }
  }

  if (rules.options?.length) {
    const chosen = Array.isArray(value) ? value.map(String) : [String(value)];
    const bad = chosen.filter((choice) => !rules.options!.includes(choice));
    if (bad.length) {
      issues.push({
        code: "option",
        message: `${field.label}: "${bad[0]}" is not one of the available options.`,
        fieldKey: field.key,
        ...at,
      });
    }
  }

  if (Array.isArray(value)) {
    if (rules.minSelected !== undefined && value.length < rules.minSelected && !draft) {
      issues.push({
        code: "min_selected",
        message: `${field.label}: choose at least ${rules.minSelected}.`,
        fieldKey: field.key,
        limit: rules.minSelected,
        actual: value.length,
        ...at,
      });
    }
    if (rules.maxSelected !== undefined && value.length > rules.maxSelected) {
      issues.push({
        code: "max_selected",
        message: `${field.label}: choose at most ${rules.maxSelected}.`,
        fieldKey: field.key,
        limit: rules.maxSelected,
        actual: value.length,
        ...at,
      });
    }
  }

  return issues;
}

/**
 * The whole submission: per-field rules, cross-field combined limits, and the
 * participant role bounds. Everything invisible is skipped.
 */
export function validate(
  answers: FormAnswers,
  def: FormDefinition,
  options: ValidateOptions = {},
): ValidationResult {
  const draft = options.draft === true;
  const issues: ValidationIssue[] = [];

  if (options.now !== undefined && !draft && !isFormOpen(def, options.now)) {
    issues.push({
      code: "form_closed",
      message: "This form is closed and is no longer accepting submissions.",
    });
  }

  /* submission-scope fields */
  const submissionStates = fieldStates(answers, def, "submission");
  for (const field of def.fields) {
    if (field.scope !== "submission") continue;
    const state = submissionStates.get(field.key);
    if (!state?.visible) continue;
    issues.push(
      ...validateField(field, answers.fields?.[field.key], state.required, null, draft),
    );
  }

  /* participants */
  const participants = answers.participants ?? [];
  if (def.participants.collect) {
    const enabledRoles = def.participants.roles.filter((role) => role.enabled);
    const enabledKeys = new Set(enabledRoles.map((role) => role.key));

    participants.forEach((participant, index) => {
      if (!enabledKeys.has(participant.role)) {
        issues.push({
          code: "unknown_role",
          message: `"${participant.role}" is not a role this form accepts.`,
          participantIndex: index,
          roleKey: participant.role,
        });
      }
      const states = fieldStates(answers, def, "participant", index);
      for (const field of def.fields) {
        if (field.scope !== "participant") continue;
        const state = states.get(field.key);
        if (!state?.visible) continue;
        issues.push(
          ...validateField(field, participant.answers?.[field.key], state.required, index, draft),
        );
      }
    });

    for (const role of enabledRoles) {
      const count = participants.filter((p) => p.role === role.key).length;
      if (!draft && count < role.min) {
        issues.push({
          code: "role_min",
          message:
            role.max === null
              ? `${role.label}: at least ${role.min} required · ${count} added`
              : `${role.label}: ${role.min}–${role.max} required · ${count} added`,
          roleKey: role.key,
          limit: role.min,
          actual: count,
        });
      }
      if (role.max !== null && count > role.max) {
        issues.push({
          code: "role_max",
          message: `${role.label}: at most ${role.max} allowed · ${count} added`,
          roleKey: role.key,
          limit: role.max,
          actual: count,
        });
      }
    }

    const total = participants.length;
    if (def.participants.maxTotal !== null && total > def.participants.maxTotal) {
      issues.push({
        code: "participants_max_total",
        message: `At most ${def.participants.maxTotal} participants in total · ${total} added`,
        limit: def.participants.maxTotal,
        actual: total,
      });
    }
    if (def.participants.minTotal !== null && total < def.participants.minTotal && !draft) {
      issues.push({
        code: "participants_min_total",
        message: `At least ${def.participants.minTotal} participants in total · ${total} added`,
        limit: def.participants.minTotal,
        actual: total,
      });
    }
  }

  /* cross-field combined limits */
  const counters = combinedCounters(answers, def);
  for (const counter of counters) {
    if (!counter.over) continue;
    issues.push({
      code: "combined_limit",
      message: `${counter.label}: ${counter.used} of ${counter.max} characters used — remove ${counter.used - counter.max}.`,
      ruleId: counter.ruleId,
      limit: counter.max,
      actual: counter.used,
      ...(counter.participantIndex === null ? {} : { participantIndex: counter.participantIndex }),
    });
  }

  return { ok: issues.length === 0, issues, counters };
}

/* ---------------------------------------------------------------- routing */

/**
 * First enabled routing rule (by `order`) that matches wins; else the default.
 * The returned `trackId` is a `tracks.id` and goes straight onto
 * `sessions.track_id` — routing IS track assignment (DECISIONS.md #25).
 *
 * Named `routeCategory` because that is what the brief calls the feature.
 */
export function routeCategory(answers: FormAnswers, def: FormDefinition): RoutingOutcome {
  const lookup = lookupFor(answers, null);
  const rules = def.routing.rules
    .filter((rule) => rule.enabled !== false)
    .slice()
    .sort((a, b) => a.order - b.order);

  for (const rule of rules) {
    if (!matches(rule.match, rule.when, lookup)) continue;
    return {
      trackId: rule.trackId,
      reviewTeamKey: rule.reviewTeamKey ?? null,
      ruleId: rule.id,
    };
  }

  return {
    trackId: def.routing.defaultTrackId,
    reviewTeamKey: def.routing.defaultReviewTeamKey ?? null,
    ruleId: null,
  };
}

/* ----------------------------------------------------------------- gates */

/** Open = status `open` AND (no close date OR the close date is in the future). */
export function isFormOpen(
  def: Pick<FormDefinition, "status" | "closesAt">,
  now: number,
): boolean {
  if (def.status !== "open") return false;
  if (def.closesAt === null) return true;
  return now <= def.closesAt;
}

/** Organizer-facing status, including the close-date gate submitters actually hit. */
export function effectiveFormStatus(
  def: Pick<FormDefinition, "status" | "closesAt">,
  now: number,
): FormStatus {
  if (def.status === "draft") return "draft";
  return isFormOpen(def, now) ? "open" : "closed";
}

/**
 * Per-person submission cap: the form-level override when set, else the
 * event-level default. null = unlimited (screenshot p13_2: "Event max: 3 —
 * applies when no form-level limit is set").
 */
export function effectiveSubmissionLimit(
  def: Pick<FormDefinition, "submissionLimit">,
  eventLimit: number | null,
): number | null {
  return def.submissionLimit ?? eventLimit ?? null;
}
