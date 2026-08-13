/**
 * Resend transport — plain `fetch` against the REST API, no SDK (AGENTS.md:
 * "no new dependencies without a justification; prefer platform APIs"). The
 * whole surface we use is one POST.
 *
 * The one non-obvious field is the attachment `content_type`. The 2026-08-08
 * spike (DECISIONS.md #28) established that Resend passes MIME parameters
 * through to the wire intact, and that
 *
 *     text/calendar; charset="utf-8"; method=REQUEST
 *
 * is what makes Gmail render a native RSVP card instead of a download chip.
 * Dropping `method=` degrades the invite silently — it still "sends fine".
 *
 * `fetchImpl` is injectable so the transport is unit-testable without a network
 * or a key: the tests assert the exact bytes that would go over the wire.
 */
import type { MailAttachment, MailMessage, MailResult, Mailer } from "./mailer";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendMailerOptions {
  apiKey: string;
  /** `Name <address>` — comes from app/lib/comms/sender, never a literal. */
  from: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

interface ResendAttachmentPayload {
  filename: string;
  /** base64 — Resend requires it even for text parts. */
  content: string;
  content_type: string;
}

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: ResendAttachmentPayload[];
}

/** UTF-8 text -> base64. `btoa` is byte-oriented, so encode first. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of `toBase64` — exported for the tests, which decode what we sent. */
export function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** `MailAttachment.content` is RAW text (ICS); Resend wants it base64-encoded. */
function toResendAttachment(attachment: MailAttachment): ResendAttachmentPayload {
  return {
    filename: attachment.filename,
    content: toBase64(attachment.content),
    content_type: attachment.contentType,
  };
}

export function buildResendPayload(message: MailMessage, defaultFrom: string): ResendPayload {
  const payload: ResendPayload = {
    from: message.from ?? defaultFrom,
    to: [message.to],
    subject: message.subject,
    text: message.text,
  };
  if (message.html) payload.html = message.html;
  if (message.replyTo) payload.reply_to = message.replyTo;
  // Omitted entirely when there are none — an empty array is not the same
  // request, and a stray `attachments: []` has tripped provider validation.
  if (message.attachments?.length) {
    payload.attachments = message.attachments.map(toResendAttachment);
  }
  return payload;
}

export class ResendMailer implements Mailer {
  readonly name = "resend";
  /**
   * `ok: true` here means Resend's API returned 2xx — it accepted the message
   * for delivery. That is not proof of an inbox, but it IS an outcome the
   * provider reported, which is the line "sent" is allowed to be drawn at.
   */
  readonly observesDelivery = true;

  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: ResendMailerOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    /*
     * `.bind(globalThis)` is LOAD-BEARING on Workers, and its absence is
     * invisible in Node. Storing the global `fetch` on an instance and calling
     * it as `this.fetchImpl(...)` makes workerd throw
     *
     *   Illegal invocation: function called with incorrect `this` reference
     *
     * because its `fetch` is a real method that checks its receiver. Node's
     * undici does not, so the unit tests were green while the first REAL send
     * failed — caught on 2026-08-08 by the single live send, which the comm log
     * recorded as a `failed` row rather than a 500. See the regression test in
     * resend.test.ts.
     */
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
  }

  async send(message: MailMessage): Promise<MailResult> {
    const payload = buildResendPayload(message, this.from);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // A transport failure is a FAILED send, not an exception thrown into an
      // agenda action. The caller writes a comm_log row either way.
      return {
        ok: false,
        error: `resend: request failed — ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, error: `resend: HTTP ${response.status} — ${raw.slice(0, 500)}` };
    }

    let id: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { id?: string };
      id = typeof parsed.id === "string" ? parsed.id : undefined;
    } catch {
      // A 200 with an unreadable body still delivered the mail; losing the
      // provider id is not a failure worth reporting as one.
    }
    return { ok: true, id };
  }
}
