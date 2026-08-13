/**
 * Submission-confirmation email — red-annotated **"must have"** in the buyer's brief, ahead of
 * reminders (PLAN §1). WS5 owns templating, merge fields and the real provider;
 * this is the minimum that makes the CFP loop honest: the submitter gets a
 * receipt naming the event and their submission, with a link to the portal.
 *
 * PURE — it builds a `MailMessage` (or refuses to). The send lives in
 * `draft.server.ts`, so both the message and the two refusal cases (form closed,
 * confirmation disabled by the admin) are unit-testable against a MemoryMailer
 * with no bindings.
 *
 * The body honours the admin-authored copy in
 * `forms.settings.notifications.confirmationEmail` (WS1a's FormSettings).
 */
import { firstNameOf } from "~/lib/comms/schedule-invite";
import {
  mergeContext,
  renderEmail,
  type EmailTemplate,
} from "~/lib/comms/templates";
import type { MailMessage, Mailer, MailResult } from "~/lib/mail/mailer";

import { emptyFormSettings, type NotificationSettings } from "./contract";

export interface ConfirmationInput {
  to: string;
  eventName: string;
  formName: string;
  submissionTitle: string;
  friendlyId: string | null;
  /** Absolute URL of the speaker portal. */
  portalUrl: string;
  config: NotificationSettings["confirmationEmail"];
  /**
   * The form's state AT THE MOMENT OF THE WRITE. A closed form never produces a
   * submission, so it must never produce a receipt either — a confirmation for
   * a submission that was refused is worse than no email at all.
   */
  closed: boolean;
  /** Submitter's name, for `{{speaker.first_name}}`. WS5. */
  speakerName?: string | null;
  /**
   * WS5. The event's `submission_confirmation` template, when the admin has
   * one. PRECEDENCE: this form's own copy wins over the event template, which
   * wins over the built-in default — per-form copy is the more specific
   * instruction, and WS1a's wizard is where an organiser expects to set it.
   */
  template?: Pick<EmailTemplate, "key" | "subject" | "body"> | null;
}

/** Merge fields the admin body may use. Deliberately few; WS5 widens the set. */
function applyMergeFields(template: string, input: ConfirmationInput): string {
  return template
    .replaceAll("{{event_name}}", input.eventName)
    .replaceAll("{{form_name}}", input.formName)
    .replaceAll("{{session_title}}", input.submissionTitle)
    .replaceAll("{{submission_id}}", input.friendlyId ?? "")
    .replaceAll("{{portal_url}}", input.portalUrl);
}

/**
 * The confirmation message, or null when it must not be sent.
 * Returning null (rather than throwing) keeps "no email" a first-class,
 * assertable outcome.
 */
export function buildConfirmationEmail(input: ConfirmationInput): MailMessage | null {
  if (input.closed) return null;
  if (input.config?.enabled === false) return null;

  /*
   * WS5: when this form carries no copy of its own, the whole message comes
   * from the event's editable template. That path replaces the body below
   * outright rather than wrapping it, so what the admin previews in
   * /admin/templates is byte-for-byte what the submitter receives.
   */
  const usingTemplate = Boolean(input.template) && !hasFormSpecificCopy(input.config);

  if (usingTemplate) {
    const rendered = renderEmail(input.template!, confirmationContext(input));
    return { to: input.to, subject: rendered.subject, text: rendered.text };
  }

  const subject = applyMergeFields(
    input.config?.subject?.trim() || "We got your submission",
    input,
  );
  const body = applyMergeFields(input.config?.body?.trim() || "", input);
  const reference = input.friendlyId ? `${input.friendlyId} — ` : "";

  const text = [
    `Thanks — we received your submission to ${input.eventName}.`,
    "",
    `${reference}${input.submissionTitle}`,
    `Submitted through: ${input.formName}`,
    ...(body ? ["", body] : []),
    "",
    "Track it, and complete any speaker tasks, in your portal:",
    input.portalUrl,
    "",
    "If you did not make this submission, reply to this email and we will remove it.",
  ].join("\n");

  return { to: input.to, subject, text };
}

/**
 * Did an admin write copy for THIS form, or is it still carrying WS1a's shipped
 * placeholder?
 *
 * Emptiness cannot answer that: every form is created with the placeholder
 * already filled in, so "non-empty subject" would mean every form overrides the
 * event template and the template editor would look broken. Comparing against
 * the shipped defaults is what distinguishes intent from a factory setting.
 */
function hasFormSpecificCopy(
  config: ConfirmationInput["config"],
): boolean {
  const shipped = emptyFormSettings().notifications.confirmationEmail;
  const subject = config?.subject?.trim() ?? "";
  const body = config?.body?.trim() ?? "";
  return (
    (subject.length > 0 && subject !== shipped.subject.trim()) ||
    (body.length > 0 && body !== shipped.body.trim())
  );
}

/** The WS5 merge context for a submission receipt. */
function confirmationContext(input: ConfirmationInput) {
  return mergeContext({
    "speaker.name": input.speakerName ?? input.to,
    "speaker.first_name": firstNameOf(input.speakerName) ?? input.to,
    "speaker.email": input.to,
    "event.name": input.eventName,
    "form.name": input.formName,
    "session.title": input.submissionTitle,
    // Never blank: a bare "Reference:" line reads as a bug in the email.
    "session.id": input.friendlyId ?? "not assigned yet",
    "portal.url": input.portalUrl,
  });
}

/** Build + send. Returns null when the message was deliberately not sent. */
export async function sendSubmissionConfirmation(
  mailer: Mailer,
  input: ConfirmationInput,
): Promise<MailResult | null> {
  const message = buildConfirmationEmail(input);
  if (!message) return null;
  return mailer.send(message);
}
