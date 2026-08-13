/**
 * Mailer selection. Both branches, because "RESEND_API_KEY is set" is the only
 * thing standing between the judged demo's console log and real email going out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTestDb, type TestDbContext } from "~/test/db";

import { getMailer } from "./mailer.server";

let ctx: TestDbContext;
afterEach(() => ctx?.close());

describe("getMailer", () => {
  it("MUST-NOT-FIRE: no key means the console mailer — a fresh clone sends nothing", () => {
    ctx = installTestDb();
    expect(getMailer().name).toBe("console");
  });

  it("MUST-NOT-FIRE: an empty key is not a key", () => {
    ctx = installTestDb({ RESEND_API_KEY: "" });
    expect(getMailer().name).toBe("console");
  });

  it("MUST-FIRE: a key selects the Resend mailer", () => {
    ctx = installTestDb({ RESEND_API_KEY: "re_test_key" });
    expect(getMailer().name).toBe("resend");
  });

  /**
   * The e2e guard. `.dev.vars` is read by the dev server Playwright boots, so a
   * developer's live key WILL be present in a test run — "no key" is not a test
   * default. MAIL_DRIVER has to beat the key, or e2e sends real email.
   */
  it("MUST-FIRE: MAIL_DRIVER=console beats a real key", () => {
    ctx = installTestDb({ RESEND_API_KEY: "re_test_key", MAIL_DRIVER: "console" });
    expect(getMailer().name).toBe("console");
  });

  it.each(["", "resend", "Console", "console ", "1"])(
    "MUST-NOT-FIRE: MAIL_DRIVER=%j leaves the key in charge",
    (driver) => {
      ctx = installTestDb({ RESEND_API_KEY: "re_test_key", MAIL_DRIVER: driver });
      expect(getMailer().name).toBe("resend");
    },
  );

  it("MUST-NOT-FIRE: MAIL_DRIVER=console does not invent a mailer without a key", () => {
    ctx = installTestDb({ MAIL_DRIVER: "console" });
    expect(getMailer().name).toBe("console");
  });

  it("takes its From from RESEND_FROM, and falls back when it is unset", async () => {
    // The From has to be observable, so drive one send through a stub endpoint.
    const sent: Record<string, unknown>[] = [];
    const stubFetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response('{"id":"stub"}', { status: 200 });
    }) as unknown as typeof fetch;

    ctx = installTestDb({
      RESEND_API_KEY: "re_test_key",
      RESEND_FROM: "Callboard Program <program@callboard.test>",
    });
    const { ResendMailer } = await import("./resend");
    const { currentSender } = await import("~/lib/comms/sender.server");

    expect(currentSender().email).toBe("program@callboard.test");
    await new ResendMailer({
      apiKey: "k",
      from: currentSender().display,
      fetchImpl: stubFetch,
    }).send({ to: "a@b.test", subject: "s", text: "t" });
    expect(sent[0].from).toBe("Callboard Program <program@callboard.test>");

    ctx.close();
    ctx = installTestDb({ RESEND_API_KEY: "re_test_key" });
    expect(currentSender().display).toBe("Callboard <onboarding@resend.dev>");
  });
});
