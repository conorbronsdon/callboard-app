/**
 * Portal forms — the SIMPLER sibling of the 7-step CFP builder.
 *
 * Sessionboard's portal form wizard is three steps (screenshots p25_1–p27_1):
 * **Form Setup** (name, external title, type) / **Form Questions** (a titled
 * section of fields) / **Settings** (deadline, login requirement, confirmation
 * email, reminders). Their type is the triad that also governs Tasks and File
 * Requests — of which only `submissions` ships here; see the note on
 * `PORTAL_FORM_TYPES`.
 *
 * Stored on the existing `forms` row — schema in `forms.schema`, settings in
 * `forms.settings`. Nothing here needs a migration.
 *
 * ⚠️ `surface: "portal"` in the settings JSON is how a portal form is told
 * apart from a CFP form: `forms.target` alone cannot do it, because BOTH a CFP
 * form and a portal "Submissions" form are `target: "submission"`. A real
 * `forms.surface` column is requested from the orchestrator; until then this
 * discriminator is the single source and `isPortalForm` is the only reader.
 *
 * Pure module — no bindings, no I/O. Everything here is unit-tested.
 */

/* ------------------------------------------------------------------ types */

/**
 * Sessionboard's triad is Contacts | Groups | Submissions. For this deadline
 * only **Submissions** ships (DECISIONS.md #25): contact- and group-scoped
 * portal forms have no consumer — there is no sponsor/exhibitor surface in
 * scope — and building two more type branches would be UI nobody can reach.
 * The type is still an enum rather than a boolean so re-adding them is a data
 * change, not a redesign.
 */
export const PORTAL_FORM_TYPES = ["submissions"] as const;
export type PortalFormType = (typeof PORTAL_FORM_TYPES)[number];

/** Copy for the type cards in step 1. */
export const PORTAL_FORM_TYPE_COPY: Record<PortalFormType, { label: string; description: string }> = {
  submissions: { label: "Submissions", description: "Collect submission-related information." },
};

/** Maps a portal form type onto the `forms.target` enum already in the schema. */
export const PORTAL_TYPE_TO_TARGET: Record<PortalFormType, "contact" | "group" | "submission"> = {
  submissions: "submission",
};

export const PORTAL_QUESTION_TYPES = [
  "text",
  "textarea",
  "select",
  "multiselect",
  "checkbox",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "file",
] as const;
export type PortalQuestionType = (typeof PORTAL_QUESTION_TYPES)[number];

export interface PortalQuestion {
  /** Stable machine key — the key in `tasks.response`. */
  key: string;
  label: string;
  type: PortalQuestionType;
  helpText?: string;
  required?: boolean;
  /**
   * The padlock in the screenshots: the responder SEES the field but cannot
   * change it. Locked answers are never overwritten by a submission.
   */
  locked?: boolean;
  options?: string[];
  maxLength?: number;
  /** `file` questions: what the R2 upload is filed as. */
  filePurpose?: "headshot" | "slides" | "document" | "other";
}

export interface PortalFormSchema {
  /** Section heading shown above the questions ("Update Your Information"). */
  sectionTitle: string;
  /** WYSIWYG-lite instructions under the heading. Markdown. */
  description?: string;
  questions: PortalQuestion[];
}

export interface PortalFormSettings {
  /** Discriminator — see the module note. */
  surface: "portal";
  type: PortalFormType;
  /** Deadline in epoch ms. Past it, the form is read-only. */
  deadlineAt?: number | null;
  /** Step 3 "login" — portal forms are always behind the portal for us. */
  requireLogin?: boolean;
  sendConfirmationEmail?: boolean;
  confirmationBody?: string;
  /** Days before the deadline to send a reminder. WS5 consumes this. */
  reminderDaysBefore?: number | null;
}

/* -------------------------------------------------------------- accessors */

const EMPTY_SCHEMA: PortalFormSchema = { sectionTitle: "Your information", questions: [] };

/** True when a `forms` row is a portal form rather than a CFP form. */
export function isPortalForm(settings: unknown): boolean {
  return (settings as PortalFormSettings | null)?.surface === "portal";
}

/** Read `forms.schema` defensively — a hand-edited JSON blob must not 500 a page. */
export function readPortalSchema(raw: unknown): PortalFormSchema {
  const value = raw as Partial<PortalFormSchema> | null;
  if (!value || typeof value !== "object") return EMPTY_SCHEMA;
  const questions = Array.isArray(value.questions) ? value.questions : [];
  return {
    sectionTitle: typeof value.sectionTitle === "string" && value.sectionTitle.trim()
      ? value.sectionTitle
      : EMPTY_SCHEMA.sectionTitle,
    description: typeof value.description === "string" ? value.description : undefined,
    questions: questions.filter(
      (question): question is PortalQuestion =>
        Boolean(question) &&
        typeof question.key === "string" &&
        typeof question.label === "string" &&
        (PORTAL_QUESTION_TYPES as readonly string[]).includes(question.type),
    ),
  };
}

export function readPortalSettings(raw: unknown): PortalFormSettings {
  const value = raw as Partial<PortalFormSettings> | null;
  const type = (PORTAL_FORM_TYPES as readonly string[]).includes(value?.type ?? "")
    ? (value!.type as PortalFormType)
    : "submissions";
  return {
    surface: "portal",
    type,
    deadlineAt: typeof value?.deadlineAt === "number" ? value.deadlineAt : null,
    requireLogin: value?.requireLogin ?? true,
    sendConfirmationEmail: value?.sendConfirmationEmail ?? false,
    confirmationBody: typeof value?.confirmationBody === "string" ? value.confirmationBody : "",
    reminderDaysBefore:
      typeof value?.reminderDaysBefore === "number" ? value.reminderDaysBefore : null,
  };
}

/** Machine key from a label: `Dietary needs?` → `dietary_needs`. */
export function questionKey(label: string, taken: string[] = []): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "question";
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/* ---------------------------------------------------------- wizard steps */

export const PORTAL_WIZARD_STEPS = [
  { id: "setup", label: "Form Setup", subtitle: "Name, type, and welcome copy." },
  { id: "questions", label: "Form Questions", subtitle: "Questions and section heading." },
  { id: "settings", label: "Settings", subtitle: "Deadlines, login, reminders." },
] as const;
export type PortalWizardStep = (typeof PORTAL_WIZARD_STEPS)[number]["id"];

export interface PortalFormDraft {
  /** Internal name, admin-facing. */
  name: string;
  /** External title shown to the responder. */
  title: string;
  type: PortalFormType | null;
  schema: PortalFormSchema;
  settings: PortalFormSettings;
}

/**
 * What is stopping this step from being complete. Empty array = the `Next`
 * button is enabled — the screenshots show an explicit inline hint
 * ("Complete all required fields on this step to continue"), so the reasons
 * are returned rather than a bare boolean.
 */
export function stepIssues(draft: PortalFormDraft, step: PortalWizardStep): string[] {
  const issues: string[] = [];
  if (step === "setup") {
    if (!draft.name.trim()) issues.push("Name is required.");
    if (!draft.title.trim()) issues.push("Title is required.");
    if (!draft.type) issues.push("Choose a type.");
  }
  if (step === "questions") {
    if (!draft.schema.sectionTitle.trim()) issues.push("Section title is required.");
    if (draft.schema.questions.length === 0) issues.push("Add at least one question.");
    const keys = new Set<string>();
    for (const question of draft.schema.questions) {
      if (!question.label.trim()) issues.push("Every question needs a label.");
      if (keys.has(question.key)) issues.push(`Duplicate question key: ${question.key}`);
      keys.add(question.key);
      if (
        (question.type === "select" || question.type === "multiselect") &&
        (question.options ?? []).length === 0
      ) {
        issues.push(`"${question.label || question.key}" needs at least one option.`);
      }
    }
  }
  if (step === "settings") {
    if (draft.settings.sendConfirmationEmail && !draft.settings.confirmationBody?.trim()) {
      issues.push("Confirmation email is on but the body is empty.");
    }
    if (
      draft.settings.reminderDaysBefore !== null &&
      draft.settings.reminderDaysBefore !== undefined &&
      draft.settings.deadlineAt == null
    ) {
      issues.push("A reminder needs a deadline to count back from.");
    }
  }
  return [...new Set(issues)];
}

/** A form can be published only when every step is clean. */
export function canPublish(draft: PortalFormDraft): boolean {
  return PORTAL_WIZARD_STEPS.every((step) => stepIssues(draft, step.id).length === 0);
}

/* -------------------------------------------------------------- answering */

export interface AnswerIssue {
  key: string;
  message: string;
}

export type AnswerValue = string | string[] | boolean | number | null;

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function isBlank(value: AnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  return false;
}

/**
 * Validate a submitted answer set against a portal form schema.
 *
 * Locked questions are SKIPPED: the responder could not have edited them, so
 * holding them to `required` would deadlock a form whose locked field the
 * admin left blank.
 */
export function validateAnswers(
  schema: PortalFormSchema,
  answers: Record<string, AnswerValue>,
): AnswerIssue[] {
  const issues: AnswerIssue[] = [];

  for (const question of schema.questions) {
    if (question.locked) continue;
    const value = answers[question.key] ?? null;

    if (question.required && isBlank(value)) {
      issues.push({ key: question.key, message: `${question.label} is required.` });
      continue;
    }
    if (isBlank(value)) continue;

    if (typeof value === "string") {
      if (question.maxLength && value.length > question.maxLength) {
        issues.push({
          key: question.key,
          message: `${question.label} must be ${question.maxLength} characters or fewer (currently ${value.length}).`,
        });
      }
      if (question.type === "email" && !EMAIL_RE.test(value.trim())) {
        issues.push({ key: question.key, message: `${question.label} must be an email address.` });
      }
      if (question.type === "url" && !/^https?:\/\/\S+\.\S+/i.test(value.trim())) {
        issues.push({
          key: question.key,
          message: `${question.label} must be a URL starting with http:// or https://.`,
        });
      }
      if (question.type === "number" && Number.isNaN(Number(value))) {
        issues.push({ key: question.key, message: `${question.label} must be a number.` });
      }
      if (question.type === "select" && (question.options ?? []).length > 0) {
        if (!question.options!.includes(value)) {
          issues.push({ key: question.key, message: `${question.label}: "${value}" is not an option.` });
        }
      }
    }

    if (Array.isArray(value) && question.type === "multiselect" && (question.options ?? []).length) {
      for (const entry of value) {
        if (!question.options!.includes(entry)) {
          issues.push({ key: question.key, message: `${question.label}: "${entry}" is not an option.` });
        }
      }
    }
  }

  return issues;
}

/**
 * Merge a submission into the stored answers, honouring locked questions and
 * dropping keys that are not in the schema (an attacker cannot append fields
 * to `tasks.response` by adding inputs to the DOM).
 */
export function applyAnswers(
  schema: PortalFormSchema,
  previous: Record<string, AnswerValue> | null,
  submitted: Record<string, AnswerValue>,
): Record<string, AnswerValue> {
  const result: Record<string, AnswerValue> = {};
  for (const question of schema.questions) {
    const prior = previous?.[question.key] ?? null;
    result[question.key] = question.locked ? prior : (submitted[question.key] ?? prior);
  }
  return result;
}

/** A form past its deadline is read-only. */
export function isPastDeadline(settings: PortalFormSettings, now: number): boolean {
  return settings.deadlineAt != null && settings.deadlineAt < now;
}
