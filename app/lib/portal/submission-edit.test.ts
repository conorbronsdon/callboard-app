import { describe, expect, it } from "vitest";

import {
  canSpeakerEditSubmission,
  speakerEditLockReason,
  validateSubmissionEdit,
} from "./submission-edit";

describe("speaker submission edits", () => {
  it("allows pending and accepted speaker corrections", () => {
    expect(canSpeakerEditSubmission("pending")).toBe(true);
    expect(canSpeakerEditSubmission("accepted")).toBe(true);
  });

  it("locks drafts, staged decisions, declined and withdrawn submissions", () => {
    expect(canSpeakerEditSubmission("draft")).toBe(false);
    expect(canSpeakerEditSubmission("accept_queue")).toBe(false);
    expect(canSpeakerEditSubmission("decline_queue")).toBe(false);
    expect(canSpeakerEditSubmission("declined")).toBe(false);
    expect(canSpeakerEditSubmission("withdrawn")).toBe(false);
  });

  it("locks a pending proposal after its CFP deadline", () => {
    expect(
      speakerEditLockReason({
        status: "pending",
        closesAt: 1_000,
        now: 1_001,
      }),
    ).toBe("past_close_date");
  });

  it("allows a pending proposal before, at, or without a CFP deadline", () => {
    expect(
      speakerEditLockReason({
        status: "pending",
        closesAt: 1_000,
        now: 999,
      }),
    ).toBeNull();
    expect(
      speakerEditLockReason({
        status: "pending",
        closesAt: 1_000,
        now: 1_000,
      }),
    ).toBeNull();
    expect(
      speakerEditLockReason({
        status: "pending",
        closesAt: null,
        now: 2_000,
      }),
    ).toBeNull();
  });

  it("allows accepted corrections even after the CFP deadline", () => {
    expect(
      speakerEditLockReason({
        status: "accepted",
        closesAt: 1_000,
        now: 10_000,
      }),
    ).toBeNull();
  });

  it("keeps staged and negative decision locks authoritative", () => {
    for (const status of ["accept_queue", "decline_queue", "declined", "withdrawn"] as const) {
      expect(
        speakerEditLockReason({
          status,
          closesAt: 10_000,
          now: 1_000,
        }),
      ).toBe("review_advanced");
    }
  });

  it("requires a title and either abstract or video", () => {
    expect(validateSubmissionEdit({ title: "", abstract: "", videoUrl: "" })).toEqual({
      ok: false,
      errors: {
        title: "Give your submission a title.",
        abstract: "Add an abstract or a video link.",
      },
    });
  });

  it("normalizes safe edits and rejects non-web video schemes", () => {
    expect(
      validateSubmissionEdit({
        title: "  Better title  ",
        abstract: "  Better abstract  ",
        videoUrl: " https://example.com/pitch ",
      }),
    ).toEqual({
      ok: true,
      value: {
        title: "Better title",
        abstract: "Better abstract",
        videoUrl: "https://example.com/pitch",
      },
    });

    expect(
      validateSubmissionEdit({
        title: "A title",
        abstract: "",
        videoUrl: "javascript:alert(1)",
      }),
    ).toEqual({
      ok: false,
      errors: { videoUrl: "Use an http or https video link." },
    });
  });
});
