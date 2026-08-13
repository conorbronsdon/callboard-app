/**
 * Capture rules, without a database.
 *
 * Two properties carry the feature and are tested in both directions: a capture
 * with nothing in it still produces a usable row (must fire), and a malformed
 * email is refused rather than turned into a person nobody can reach (must not
 * fire).
 */
import { describe, expect, it } from "vitest";

import {
  CAPTURE_KEY,
  CAPTURE_TITLE_FALLBACK,
  captureProvenance,
  captureProvenanceFor,
  deriveCaptureTitle,
  planCapture,
} from "./capture";

const input = (over: Partial<Parameters<typeof planCapture>[0]> = {}) => ({
  title: "",
  pasted: "",
  source: "email",
  speakerEmail: "",
  speakerName: "",
  ...over,
});

describe("deriveCaptureTitle", () => {
  it("prefers an explicit title", () => {
    expect(deriveCaptureTitle("  Agent evals in anger  ", "Hi, I'd love to speak")).toBe(
      "Agent evals in anger",
    );
  });

  it("falls back to the first non-blank line of the paste", () => {
    expect(deriveCaptureTitle("", "\n\n  Talk idea: cost modelling  \nrest of the email")).toBe(
      "Talk idea: cost modelling",
    );
  });

  it("truncates a runaway first line with an ellipsis", () => {
    const long = "x".repeat(400);
    const title = deriveCaptureTitle("", long);
    expect(title).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("names an empty capture rather than refusing it", () => {
    expect(deriveCaptureTitle("", "   \n  ")).toBe(CAPTURE_TITLE_FALLBACK);
  });
});

describe("planCapture", () => {
  it("accepts a capture with every field blank", () => {
    const result = planCapture(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.title).toBe(CAPTURE_TITLE_FALLBACK);
    expect(result.plan.description).toBeNull();
    expect(result.plan.speakerEmail).toBeNull();
  });

  it("normalises an email and keeps the paste verbatim", () => {
    const pasted = "Hi Conor,\n\n  I'd like to talk about D1 at scale.\n\n-- Rina";
    const result = planCapture(
      input({ speakerEmail: "  RINA@Example.COM ", pasted: `${pasted}\n` }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.speakerEmail).toBe("rina@example.com");
    // Interior newlines and indentation survive: this is a recording, not a parse.
    expect(result.plan.description).toBe(pasted);
  });

  it("rejects a malformed email — must not fire", () => {
    const result = planCapture(input({ speakerEmail: "rina@" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("rina@");
  });

  it("falls back to `other` for an unknown source rather than trusting the post", () => {
    const result = planCapture(input({ source: "carrier-pigeon" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.source).toBe("other");
  });
});

describe("captureProvenance", () => {
  const plan = {
    title: "T",
    description: null,
    source: "dm" as const,
    speakerEmail: null,
    speakerName: "Rina Okafor",
  };

  it("round-trips a stored block", () => {
    const block = captureProvenanceFor({
      plan,
      byPersonId: "admin-1",
      byName: "Ada Organizer",
      capturedAt: 1_754_000_000_000,
      attached: false,
    });
    const read = captureProvenance({ [CAPTURE_KEY]: block });
    expect(read).toEqual(block);
    // Unattached captures keep the typed name so the organizer can find them.
    expect(read?.contactName).toBe("Rina Okafor");
    expect(read?.contactNote).toBeTruthy();
  });

  it("drops the contact fallback once a person row exists", () => {
    const block = captureProvenanceFor({
      plan,
      byPersonId: "admin-1",
      byName: "Ada Organizer",
      capturedAt: 1,
      attached: true,
    });
    expect(block.contactName).toBeNull();
    expect(block.contactNote).toBeNull();
  });

  it("returns null for anything that is not a capture — must not fire", () => {
    expect(captureProvenance(null)).toBeNull();
    expect(captureProvenance({ title: "an ordinary answer blob" })).toBeNull();
    expect(captureProvenance([{ [CAPTURE_KEY]: {} }])).toBeNull();
    // A block missing the organizer is not provenance; reading it as one would
    // put an unattributed "captured by" banner on the page.
    expect(captureProvenance({ [CAPTURE_KEY]: { capturedAt: 1 } })).toBeNull();
    expect(captureProvenance({ [CAPTURE_KEY]: { byPersonId: "admin-1" } })).toBeNull();
  });
});
