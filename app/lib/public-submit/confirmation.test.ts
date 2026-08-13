/**
 * Submission-confirmation email — red-annotated "must have" in the buyer's brief.
 *
 * Driven through a MemoryMailer so both outcomes are assertable: the send on a
 * successful submit, AND its absence when the form is closed or the admin
 * turned the confirmation off. "No email" is a behaviour, not a gap.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATES } from "~/lib/comms/templates";
import { MemoryMailer } from "~/lib/mail/mailer";

import { buildConfirmationEmail, sendSubmissionConfirmation } from "./confirmation";
import { emptyFormSettings } from "./contract";

const config = () => emptyFormSettings().notifications.confirmationEmail;

const input = (over: Partial<Parameters<typeof buildConfirmationEmail>[0]> = {}) => ({
  to: "ada@example.com",
  eventName: "Frontier AI Summit 2026",
  formName: "Call for Proposals 2026",
  submissionTitle: "Agents that survive contact with users",
  friendlyId: "ABS-9",
  portalUrl: "https://callboard.test/portal",
  config: config(),
  closed: false,
  ...over,
});

describe("buildConfirmationEmail", () => {
  it("MUST-FIRE: an open form produces a receipt naming the event, title and portal", () => {
    const message = buildConfirmationEmail(input());
    expect(message).not.toBeNull();
    expect(message!.to).toBe("ada@example.com");
    expect(message!.subject).toBe("We got your submission");
    expect(message!.text).toContain("Frontier AI Summit 2026");
    expect(message!.text).toContain("ABS-9 — Agents that survive contact with users");
    expect(message!.text).toContain("Call for Proposals 2026");
    expect(message!.text).toContain("https://callboard.test/portal");
  });

  it("MUST-NOT-FIRE: a closed form produces no receipt", () => {
    expect(buildConfirmationEmail(input({ closed: true }))).toBeNull();
  });

  it("MUST-NOT-FIRE: the admin switched the confirmation off", () => {
    expect(
      buildConfirmationEmail(input({ config: { ...config(), enabled: false } })),
    ).toBeNull();
  });

  it("still sends when the admin config is malformed rather than disabled", () => {
    const message = buildConfirmationEmail(
      input({ config: {} as ReturnType<typeof config> }),
    );
    expect(message).not.toBeNull();
    expect(message!.subject).toBe("We got your submission");
  });

  it("expands the admin-authored merge fields", () => {
    const message = buildConfirmationEmail(
      input({
        config: {
          enabled: true,
          subject: "{{event_name}}: {{session_title}}",
          body: "Your id is {{submission_id}}. Portal: {{portal_url}}",
        },
      }),
    );
    expect(message!.subject).toBe(
      "Frontier AI Summit 2026: Agents that survive contact with users",
    );
    expect(message!.text).toContain("Your id is ABS-9.");
    expect(message!.text).toContain("Portal: https://callboard.test/portal");
  });

  it("omits the id prefix when the submission has no friendly id yet", () => {
    const message = buildConfirmationEmail(input({ friendlyId: null }));
    expect(message!.text).toContain("Agents that survive contact with users");
    expect(message!.text).not.toContain("null");
    expect(message!.text).not.toContain(" — Agents");
  });
});

describe("WS5 template upgrade", () => {
  const template = DEFAULT_TEMPLATES.submission_confirmation;

  it("MUST-FIRE: with no per-form copy, the event template supplies the message", () => {
    const message = buildConfirmationEmail(
      input({ template, speakerName: "Ada Lovelace" }),
    );

    expect(message!.subject).toBe(
      "We got your submission to Frontier AI Summit 2026",
    );
    expect(message!.text).toContain("Hi Ada,");
    expect(message!.text).toContain("Submission: Agents that survive contact with users");
    expect(message!.text).toContain("Reference:  ABS-9");
    expect(message!.text).toContain("Form:       Call for Proposals 2026");
    expect(message!.text).toContain("https://callboard.test/portal");
    expect(message!.text).not.toMatch(/\{\{/);
  });

  it("MUST-NOT-FIRE: the form's OWN copy still wins over the event template", () => {
    const message = buildConfirmationEmail(
      input({
        template,
        config: {
          enabled: true,
          subject: "Per-form subject for {{event_name}}",
          body: "Per-form body.",
        },
      }),
    );

    expect(message!.subject).toBe("Per-form subject for Frontier AI Summit 2026");
    expect(message!.text).toContain("Per-form body.");
    expect(message!.text).not.toContain("Submission: Agents");
  });

  it("MUST-NOT-FIRE: a closed form is still silent even with a template", () => {
    expect(buildConfirmationEmail(input({ template, closed: true }))).toBeNull();
  });

  it("MUST-NOT-FIRE: a disabled confirmation is still silent even with a template", () => {
    expect(
      buildConfirmationEmail(input({ template, config: { ...config(), enabled: false } })),
    ).toBeNull();
  });

  it("never leaves a blank reference line when no friendly id exists yet", () => {
    const message = buildConfirmationEmail(input({ template, friendlyId: null }));
    expect(message!.text).toContain("Reference:  not assigned yet");
    expect(message!.text).not.toMatch(/Reference: +$/m);
  });

  it("falls back to the email address when the submitter has no name", () => {
    const message = buildConfirmationEmail(input({ template, speakerName: null }));
    expect(message!.text).toContain("Hi ada@example.com,");
  });
});

describe("sendSubmissionConfirmation", () => {
  it("MUST-FIRE: hands exactly one message to the mailer on a submit", async () => {
    const mailer = new MemoryMailer();
    const result = await sendSubmissionConfirmation(mailer, input());
    expect(result?.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("ada@example.com");
  });

  it("MUST-NOT-FIRE: sends nothing at all when the form is closed", async () => {
    const mailer = new MemoryMailer();
    const result = await sendSubmissionConfirmation(mailer, input({ closed: true }));
    expect(result).toBeNull();
    expect(mailer.sent).toEqual([]);
  });

  it("MUST-NOT-FIRE: sends nothing when confirmations are disabled", async () => {
    const mailer = new MemoryMailer();
    await sendSubmissionConfirmation(
      mailer,
      input({ config: { ...config(), enabled: false } }),
    );
    expect(mailer.sent).toEqual([]);
  });
});
