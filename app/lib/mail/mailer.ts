/**
 * Mailer interface. WS5 adds the Resend implementation behind this same shape;
 * nothing above this line should ever import a provider SDK directly.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always required — it is the fallback and the dev log. */
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** ICS calendar invites (WS5): `METHOD:REQUEST` attachments. */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailResult {
  ok: boolean;
  /** Provider message id when the send succeeded. */
  id?: string;
  error?: string;
}

export interface Mailer {
  readonly name: string;
  /**
   * Can a `{ ok: true }` from this driver be read as "a mail provider accepted
   * it for delivery"?
   *
   * False for every driver that only writes the message somewhere local. The
   * console mailer returns `ok: true` unconditionally and cannot fail, so a
   * caller that treats "did not throw" as "sent" is making a claim nothing in
   * the system can observe — which is exactly what the reviewer-invite panel
   * did. Required, not optional: a new transport has to state which it is, and
   * the safe answer is never the one you get by forgetting the field.
   */
  readonly observesDelivery: boolean;
  send(message: MailMessage): Promise<MailResult>;
}

/**
 * DEV mailer: logs the message (and any link in it) to the Worker console.
 * The magic-link flow is fully usable locally with zero email configuration —
 * copy the URL out of the `wrangler dev` output.
 */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  /** Prints to the Worker log. Nothing leaves the process; nothing is delivered. */
  readonly observesDelivery = false;

  constructor(private readonly log: (message: string) => void = console.log) {}

  async send(message: MailMessage): Promise<MailResult> {
    const id = `console-${crypto.randomUUID()}`;
    const links = message.text.match(/https?:\/\/\S+/g) ?? [];
    this.log(
      [
        "",
        "──────────────── callboard: dev email ────────────────",
        `to:      ${message.to}`,
        `subject: ${message.subject}`,
        "",
        message.text,
        ...(links.length ? ["", `🔗 ${links.join("\n🔗 ")}`] : []),
        "──────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { ok: true, id };
  }
}

/** Collects messages instead of sending. For tests. */
export class MemoryMailer implements Mailer {
  readonly name = "memory";
  /** Collects into an array. A test asserting "sent" must assert on `sent`. */
  readonly observesDelivery = false;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message);
    return { ok: true, id: `memory-${this.sent.length}` };
  }
}
