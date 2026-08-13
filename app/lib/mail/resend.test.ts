/**
 * The Resend transport, asserted against the bytes it would put on the wire.
 *
 * The `content_type` assertion is the important one: the spike proved that
 * exact string is what turns a `.ics` attachment into a native Gmail invite, so
 * this test exists to fail if anyone "tidies" the MIME parameters away.
 */
import { describe, expect, it } from "vitest";

import { icsContentType } from "~/lib/comms/ics";
import { withStrictFetch } from "~/test/workerd-fetch";

import { ResendMailer, RESEND_ENDPOINT, buildResendPayload, fromBase64, toBase64 } from "./resend";
import type { MailMessage } from "./mailer";

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/**
 * `response` is a FACTORY, not a Response: a `Response` body can only be read
 * once, so a shared instance makes the second send in a test fail for a reason
 * that has nothing to do with the code under test.
 */
function recordingFetch(response: () => Response, sink: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return response();
  }) as unknown as typeof fetch;
}

const ok =
  (body = '{"id":"0c69ed41-aa37-498e-8f28-2366c7953812"}') =>
  () =>
    new Response(body, { status: 200 });

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: "speaker@callboard.dev",
  subject: "Your slot at Frontier AI Summit 2026",
  text: "Your session is scheduled.",
  ...over,
});

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

describe("ResendMailer.send", () => {
  it("MUST-FIRE: POSTs to the Resend API with the bearer key", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "re_test_key",
      from: "Callboard <onboarding@resend.dev>",
      fetchImpl: recordingFetch(ok(), calls),
    });

    const result = await mailer.send(message());

    expect(result).toEqual({ ok: true, id: "0c69ed41-aa37-498e-8f28-2366c7953812" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_ENDPOINT);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key",
    );
    expect(calls[0].body).toMatchObject({
      from: "Callboard <onboarding@resend.dev>",
      to: ["speaker@callboard.dev"],
      subject: "Your slot at Frontier AI Summit 2026",
      text: "Your session is scheduled.",
    });
  });

  it("MUST-FIRE: an ICS attachment goes out base64 with the invite content_type", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "re_test_key",
      from: "Callboard <onboarding@resend.dev>",
      fetchImpl: recordingFetch(ok(), calls),
    });

    await mailer.send(
      message({
        attachments: [
          {
            filename: "invite.ics",
            content: ICS,
            contentType: icsContentType("REQUEST"),
          },
        ],
      }),
    );

    const attachments = calls[0].body.attachments as {
      filename: string;
      content: string;
      content_type: string;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("invite.ics");
    // The exact literal DECISIONS.md #28 turns on.
    expect(attachments[0].content_type).toBe('text/calendar; charset="utf-8"; method=REQUEST');
    // Content is base64 of the RAW ics, CRLF intact.
    expect(attachments[0].content).not.toContain("BEGIN:VCALENDAR");
    expect(fromBase64(attachments[0].content)).toBe(ICS);
  });

  it("MUST-FIRE: a cancellation carries method=CANCEL", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: recordingFetch(ok(), calls),
    });

    await mailer.send(
      message({
        attachments: [
          { filename: "cancel.ics", content: ICS, contentType: icsContentType("CANCEL") },
        ],
      }),
    );

    const attachments = calls[0].body.attachments as { content_type: string }[];
    expect(attachments[0].content_type).toBe('text/calendar; charset="utf-8"; method=CANCEL');
  });

  it("MUST-NOT-FIRE: no `attachments` key at all on a plain email", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: recordingFetch(ok(), calls),
    });

    await mailer.send(message());
    expect("attachments" in calls[0].body).toBe(false);

    await mailer.send(message({ attachments: [] }));
    expect("attachments" in calls[1].body).toBe(false);
  });

  it("MUST-NOT-FIRE: html/reply_to are omitted unless the message sets them", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: recordingFetch(ok(), calls),
    });

    await mailer.send(message());
    expect("html" in calls[0].body).toBe(false);
    expect("reply_to" in calls[0].body).toBe(false);

    await mailer.send(message({ html: "<p>hi</p>", replyTo: "program@ai.engineer" }));
    expect(calls[1].body.html).toBe("<p>hi</p>");
    expect(calls[1].body.reply_to).toBe("program@ai.engineer");
  });

  it("a per-message `from` overrides the configured default", async () => {
    const calls: Captured[] = [];
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "default@b.test",
      fetchImpl: recordingFetch(ok(), calls),
    });
    await mailer.send(message({ from: "override@b.test" }));
    expect(calls[0].body.from).toBe("override@b.test");
  });

  it("MUST-FIRE: a non-2xx response is a failed result, not a throw", async () => {
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: recordingFetch(
        () =>
          new Response('{"message":"You can only send testing emails to your own address"}', {
            status: 403,
          }),
        [],
      ),
    });

    const result = await mailer.send(message());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("403");
    expect(result.error).toContain("your own address");
    expect(result.id).toBeUndefined();
  });

  it("MUST-FIRE: a network error is a failed result, not a throw", async () => {
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });

    const result = await mailer.send(message());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });

  it("treats a 200 with an unparseable body as delivered, without an id", async () => {
    const mailer = new ResendMailer({
      apiKey: "k",
      from: "a@b.test",
      fetchImpl: recordingFetch(() => new Response("accepted", { status: 200 }), []),
    });
    expect(await mailer.send(message())).toEqual({ ok: true, id: undefined });
  });
});

describe("the default fetch is called with the right receiver", () => {
  /*
   * REGRESSION. workerd's `fetch` throws "Illegal invocation" when called with
   * a `this` that is not the global scope, and `this.fetchImpl(...)` supplies
   * the mailer instance. Node's undici does not check, so nothing else in this
   * file can see the bug. Standing in a receiver-checking fetch reproduces
   * workerd's contract in Node.
   */
  it("MUST-NOT-FIRE: no illegal invocation when fetchImpl is left to default", async () => {
    await withStrictFetch(async (calls) => {
      const mailer = new ResendMailer({ apiKey: "k", from: "a@b.test" });
      const result = await mailer.send(message());
      expect(result).toEqual({ ok: true, id: "bound" });
      expect(calls[0]?.receiver).toBe(globalThis);
    }, () => new Response('{"id":"bound"}', { status: 200 }));
  });
});

describe("base64 helpers", () => {
  it("round-trips UTF-8 including CRLF and non-ASCII", () => {
    const text = "SUMMARY:Café — naïve 🚀\r\nEND:VEVENT\r\n";
    expect(fromBase64(toBase64(text))).toBe(text);
  });

  it("produces base64, not the original text", () => {
    expect(toBase64("BEGIN:VCALENDAR")).toBe("QkVHSU46VkNBTEVOREFS");
  });
});

describe("buildResendPayload", () => {
  it("addresses exactly one recipient per send — no accidental bulk", () => {
    expect(buildResendPayload(message(), "a@b.test").to).toEqual(["speaker@callboard.dev"]);
  });
});
