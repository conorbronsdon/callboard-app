/**
 * Email templates + merge fields.
 *
 * Two rules shape this module:
 *
 * 1. **Defaults live in code, overrides live in the DB.** `email_templates` has
 *    a row only once an admin has edited that template, which makes
 *    "reset to default" a DELETE and makes a fresh event send sensible email
 *    with no setup. (Schema is orchestrator-only — no new columns for this.)
 * 2. **Merge fields have one canonical dotted name and documented aliases.**
 *    The dotted form (`{{speaker.name}}`) is what the editor advertises; the
 *    snake aliases (`{{first_name}}`, `{{event_name}}`) already exist in
 *    `scripts/seed.mjs` rows and in WS1a's per-form confirmation copy, so both
 *    spellings resolve to the same value. Renaming one would silently blank a
 *    seeded template.
 *
 * Pure — `templates.server.ts` does the I/O.
 */

export const TEMPLATE_KEYS = [
  "submission_confirmation",
  "decision_accept",
  "decision_decline",
  "task_reminder",
  "schedule_invite",
  "schedule_update",
  "schedule_cancel",
  "portal_invite",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export function isTemplateKey(value: unknown): value is TemplateKey {
  return TEMPLATE_KEYS.includes(value as TemplateKey);
}

export interface EmailTemplate {
  key: TemplateKey;
  name: string;
  subject: string;
  body: string;
}

export interface TemplateDefinition extends EmailTemplate {
  /** What fires this template, shown in the editor so nothing is a mystery. */
  trigger: string;
  /** Merge fields that actually carry a value for this template. */
  fields: string[];
}

/* ------------------------------------------------------------ merge fields */

export interface MergeFieldSpec {
  /** Canonical dotted name. */
  key: string;
  label: string;
  /** Other spellings that resolve to the same value. */
  aliases: string[];
  /** Shown in the editor's field list and used for the preview. */
  sample: string;
}

export const MERGE_FIELDS: MergeFieldSpec[] = [
  {
    key: "speaker.name",
    label: "Speaker's full name",
    aliases: ["speaker_name"],
    sample: "Sam Speaker",
  },
  {
    key: "speaker.first_name",
    label: "Speaker's first name",
    aliases: ["first_name"],
    sample: "Sam",
  },
  {
    key: "speaker.email",
    label: "Speaker's email",
    aliases: ["speaker_email"],
    sample: "speaker@callboard.dev",
  },
  {
    key: "event.name",
    label: "Event name",
    aliases: ["event_name"],
    sample: "Frontier AI Summit 2026",
  },
  {
    key: "event.location",
    label: "Event location",
    aliases: ["event_location"],
    sample: "San Francisco, CA",
  },
  {
    key: "session.title",
    label: "Session title",
    aliases: ["session_title"],
    sample: "Shipping agents that survive contact with users",
  },
  {
    key: "session.id",
    label: "Submission reference",
    aliases: ["submission_id", "session_id"],
    sample: "ABS-9",
  },
  {
    key: "session.time",
    label: "Session day and time",
    aliases: ["session_time"],
    sample: "Wed Oct 7, 2026 · 10:00 AM – 10:30 AM",
  },
  {
    key: "session.room",
    label: "Room",
    aliases: ["session_room", "room_name"],
    sample: "Main Stage",
  },
  {
    key: "form.name",
    label: "Form the submission came through",
    aliases: ["form_name"],
    sample: "Call for Proposals 2026",
  },
  {
    key: "portal.url",
    label: "Speaker portal link",
    aliases: ["portal_url"],
    sample: "https://callboard.example/portal",
  },
  {
    key: "task.list",
    label: "Bulleted list of the speaker's open tasks",
    aliases: ["task_list"],
    sample: "- Confirm your slot (due Mon Aug 10)\n- Upload a headshot (due Tue Aug 18)",
  },
  {
    key: "task.count",
    label: "How many tasks are open",
    aliases: ["task_count"],
    sample: "2",
  },
  {
    key: "task.due",
    label: "Soonest due date across those tasks",
    aliases: ["task_due"],
    sample: "Mon Aug 10, 2026",
  },
];

/** Canonical key -> itself, alias -> canonical key. */
const ALIAS_TO_CANONICAL = new Map<string, string>(
  MERGE_FIELDS.flatMap((field) => [
    [field.key, field.key] as [string, string],
    ...field.aliases.map((alias) => [alias, field.key] as [string, string]),
  ]),
);

export type MergeContext = Record<string, string>;

/** Build a context from canonical keys; aliases are filled in automatically. */
export function mergeContext(values: Record<string, string | null | undefined>): MergeContext {
  const context: MergeContext = {};
  for (const [key, value] of Object.entries(values)) {
    const canonical = ALIAS_TO_CANONICAL.get(key) ?? key;
    const text = value == null ? "" : String(value);
    context[canonical] = text;
    for (const field of MERGE_FIELDS) {
      if (field.key !== canonical) continue;
      for (const alias of field.aliases) context[alias] = text;
    }
  }
  return context;
}

/** `{{ key }}` / `{{key}}`. Dots and underscores only — no expressions. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Substitute merge fields. An UNKNOWN field renders as empty string rather than
 * leaking `{{speker.name}}` into a speaker's inbox; the editor surfaces the same
 * unknowns as a warning (see `unknownMergeFields`) so the typo is still visible
 * to the person who can fix it.
 */
export function renderTemplate(template: string, context: MergeContext): string {
  return String(template ?? "").replace(PLACEHOLDER, (_match, name: string) => {
    const canonical = ALIAS_TO_CANONICAL.get(name) ?? name;
    return context[canonical] ?? context[name] ?? "";
  });
}

/** Merge fields used in the text that this product does not know how to fill. */
export function unknownMergeFields(template: string): string[] {
  const found = new Set<string>();
  for (const match of String(template ?? "").matchAll(PLACEHOLDER)) {
    if (!ALIAS_TO_CANONICAL.has(match[1])) found.add(match[1]);
  }
  return [...found];
}

/** Sample values for every field — the editor's live preview runs on these. */
export function previewContext(): MergeContext {
  return mergeContext(
    Object.fromEntries(MERGE_FIELDS.map((field) => [field.key, field.sample])),
  );
}

/* --------------------------------------------------------------- defaults */

export const DEFAULT_TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  submission_confirmation: {
    key: "submission_confirmation",
    name: "Submission confirmation",
    trigger: "Sent the moment a CFP submission is accepted by the form.",
    fields: ["speaker.first_name", "event.name", "session.title", "session.id", "form.name", "portal.url"],
    subject: "We got your submission to {{event.name}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "Thanks — we received your submission to {{event.name}}.",
      "",
      "Submission: {{session.title}}",
      "Reference:  {{session.id}}",
      "Form:       {{form.name}}",
      "",
      "Track it, and complete any speaker tasks, in your portal:",
      "{{portal.url}}",
      "",
      "If you did not make this submission, reply to this email and we will remove it.",
    ].join("\n"),
  },
  decision_accept: {
    key: "decision_accept",
    name: "Decision — accepted",
    trigger: "An organizer commits an abstract from Accept Queue to Accepted.",
    fields: [
      "speaker.first_name",
      "event.name",
      "session.title",
      "session.id",
      "portal.url",
    ],
    subject: "Your proposal for {{event.name}} was accepted",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "We would like to include your session in {{event.name}}:",
      "",
      "{{session.title}}",
      "Reference: {{session.id}}",
      "",
      "Your speaker tasks and event details are in your portal:",
      "{{portal.url}}",
      "",
      "We will follow up as the schedule takes shape.",
    ].join("\n"),
  },
  decision_decline: {
    key: "decision_decline",
    name: "Decision — declined",
    trigger: "An organizer commits an abstract from Decline Queue to Declined.",
    fields: ["speaker.first_name", "event.name", "session.title", "session.id"],
    subject: "An update on {{session.title}} for {{event.name}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "We will not be able to include this session in the {{event.name}} program:",
      "",
      "{{session.title}}",
      "Reference: {{session.id}}",
      "",
      "Thank you for taking the time to share it with us.",
      "This decision is only for this event, and we would be glad to hear from you for a future one.",
    ].join("\n"),
  },
  task_reminder: {
    key: "task_reminder",
    name: "Task reminder",
    trigger:
      "The `task-reminders` job: open tasks due soon or already past due, at most one reminder per task per cadence.",
    fields: ["speaker.first_name", "event.name", "task.count", "task.list", "task.due", "portal.url"],
    subject: "{{task.count}} thing(s) left before {{event.name}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "You have {{task.count}} open speaker task(s) for {{event.name}}:",
      "",
      "{{task.list}}",
      "",
      "Everything lives in your speaker portal:",
      "{{portal.url}}",
      "",
      "Reply to this email if any of it is wrong or you need more time.",
    ].join("\n"),
  },
  schedule_invite: {
    key: "schedule_invite",
    name: "Schedule invite",
    trigger: "A published session is given a time on the agenda. Carries the calendar invite.",
    fields: ["speaker.first_name", "event.name", "session.title", "session.time", "session.room", "portal.url"],
    subject: "Your slot at {{event.name}}: {{session.title}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "Your session is scheduled.",
      "",
      "{{session.title}}",
      "{{session.time}}",
      "{{session.room}}",
      "",
      "The calendar invite is attached — accept it and the session lands in your own calendar.",
      "",
      "Run of show and your speaker tasks:",
      "{{portal.url}}",
    ].join("\n"),
  },
  schedule_update: {
    key: "schedule_update",
    name: "Schedule change",
    trigger: "A published, already-invited session is moved. Carries an updated calendar invite.",
    fields: ["speaker.first_name", "event.name", "session.title", "session.time", "session.room", "portal.url"],
    subject: "Updated time for {{session.title}} at {{event.name}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "Your session has moved. The new time is:",
      "",
      "{{session.title}}",
      "{{session.time}}",
      "{{session.room}}",
      "",
      "The attached invite replaces the previous one — accepting it updates the entry",
      "already in your calendar.",
      "",
      "Run of show and your speaker tasks:",
      "{{portal.url}}",
    ].join("\n"),
  },
  schedule_cancel: {
    key: "schedule_cancel",
    name: "Schedule cancellation",
    trigger:
      "A scheduled, published session is unscheduled or pulled from the public schedule. Carries a calendar cancellation.",
    fields: ["speaker.first_name", "event.name", "session.title", "session.time", "portal.url"],
    subject: "Cancelled: {{session.title}} at {{event.name}}",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "{{session.title}} has been taken off the schedule for now. The slot that was held",
      "for you ({{session.time}}) is released, and the attached cancellation removes it",
      "from your calendar.",
      "",
      "This is not a decision about your talk — we will be in touch with a new time.",
      "",
      "{{portal.url}}",
    ].join("\n"),
  },
  portal_invite: {
    key: "portal_invite",
    name: "Portal invite",
    trigger: "An organizer explicitly sends it from the speaker roster — never automatic.",
    fields: ["speaker.first_name", "event.name", "portal.url"],
    subject: "You're set up in the {{event.name}} speaker portal",
    body: [
      "Hi {{speaker.first_name}},",
      "",
      "You have a speaker portal for {{event.name}} — it's where you'll track your",
      "submission status, complete speaker tasks, and update your bio, links, and headshot.",
      "",
      "Sign in here:",
      "{{portal.url}}",
      "",
      "Reply to this email if anything looks wrong.",
    ].join("\n"),
  },
};

export function defaultTemplate(key: TemplateKey): TemplateDefinition {
  return DEFAULT_TEMPLATES[key];
}

/* ---------------------------------------------------------------- render */

export interface RenderedEmail {
  subject: string;
  text: string;
}

/**
 * Subject + body with merge fields substituted. Falls back to the built-in
 * default for whichever half an admin blanked — an empty subject is never a
 * deliberate choice, and an email with no subject is a spam signal.
 */
export function renderEmail(
  template: Pick<EmailTemplate, "key" | "subject" | "body">,
  context: MergeContext,
): RenderedEmail {
  const fallback = DEFAULT_TEMPLATES[template.key as TemplateKey];
  const subject = template.subject?.trim() || fallback?.subject || "";
  const body = template.body?.trim() || fallback?.body || "";
  return {
    subject: renderTemplate(subject, context),
    text: renderTemplate(body, context),
  };
}
