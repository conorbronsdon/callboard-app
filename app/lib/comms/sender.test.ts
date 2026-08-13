/**
 * The lockstep invariant from the ICS spike (DECISIONS.md #28): the `From`
 * header and the ICS `ORGANIZER` must always name the SAME address. This file
 * is what makes a future `RESEND_FROM` change safe.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SENDER, organizerMailto, parseSender } from "./sender";

describe("parseSender", () => {
  it("parses `Name <email>`", () => {
    expect(parseSender("Callboard <hello@callboard.dev>")).toEqual({
      display: "Callboard <hello@callboard.dev>",
      name: "Callboard",
      email: "hello@callboard.dev",
    });
  });

  it("parses a bare address", () => {
    expect(parseSender("hello@callboard.dev")).toEqual({
      display: "hello@callboard.dev",
      name: "hello@callboard.dev",
      email: "hello@callboard.dev",
    });
  });

  it("strips quotes from a quoted display name", () => {
    expect(parseSender('"AI Engineer, Program" <program@ai.engineer>').name).toBe(
      "AI Engineer, Program",
    );
  });

  it("MUST-NOT-FIRE: an unset or malformed value falls back, it does not throw", () => {
    for (const raw of [undefined, null, "", "   ", "not an address", "a@b <broken"]) {
      expect(parseSender(raw).display).toBe(DEFAULT_SENDER);
      expect(parseSender(raw).email).toBe("onboarding@resend.dev");
    }
  });

  it("ships the unverified Resend sandbox address until DNS verification lands", () => {
    // PLAN §9 item 1. Changing RESEND_FROM must be the ONLY change required.
    expect(DEFAULT_SENDER).toBe("Callboard <onboarding@resend.dev>");
  });
});

describe("From/ORGANIZER lockstep", () => {
  it("MUST-FIRE: the organizer mailto is derived from the same address as From", () => {
    for (const raw of [
      "Callboard <onboarding@resend.dev>",
      "speakers@chainofthought.show",
      "AI Engineer Program <program@ai.engineer>",
      "garbage",
      "",
    ]) {
      const sender = parseSender(raw);
      expect(organizerMailto(sender)).toBe(`mailto:${sender.email}`);
      // The display form always contains the address the organizer names.
      expect(sender.display.includes(sender.email)).toBe(true);
    }
  });

  it("MUST-NOT-FIRE: two different senders never share an organizer line", () => {
    expect(organizerMailto(parseSender("a@one.test"))).not.toBe(
      organizerMailto(parseSender("a@two.test")),
    );
  });
});
