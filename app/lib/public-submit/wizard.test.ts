/**
 * WS1b's own logic: step gating, close-date copy, submission limits, the live
 * participant indicators, and the abstract-or-video content block.
 *
 * The form evaluator itself (validation, conditional visibility, combined
 * limits, routing) is WS1a's and is covered by app/lib/form-schema.test.ts —
 * what is tested here is the layer WS1b adds on top. Every guard gets a
 * must-fire AND a must-not-fire case (AGENTS.md #2).
 */
import { describe, expect, it } from "vitest";

import {
  FORM_SCHEMA_SOURCE,
  emptyFormSettings,
  toFormDefinition,
  type FormDefinition,
  type ParticipantRoleConfig,
} from "./contract";
import {
  DEFAULT_STEP_LABELS,
  WIZARD_STEPS,
  canAddParticipant,
  checkContent,
  checkParticipants,
  checkSubmissionLimit,
  closeDateSentence,
  closedReason,
  enabledRoles,
  nextStep,
  prevStep,
  resolveStep,
  roleIndicator,
  stepLabels,
  stepPath,
  submissionLimitSentence,
  toFormAnswers,
  type DraftParticipant,
} from "./wizard";

/* ------------------------------------------------------------- fixtures */

let emailCounter = 0;
const participant = (over: Partial<DraftParticipant> = {}): DraftParticipant => ({
  role: "speaker",
  firstName: "Ada",
  lastName: "Lovelace",
  email: `ada${(emailCounter += 1)}@example.com`,
  ...over,
});

/** A FormDefinition built the way the loader builds one, from a row-like. */
function definition(over: {
  status?: string;
  closesAt?: number | null;
  submissionLimit?: number | null;
  roles?: Partial<ParticipantRoleConfig>[];
  maxTotal?: number | null;
  minTotal?: number | null;
  settings?: unknown;
} = {}): FormDefinition {
  const roles = (over.roles ?? [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: null }]).map(
    (role) => ({
      key: role.key ?? "speaker",
      label: role.label ?? "Speaker",
      enabled: role.enabled ?? true,
      min: role.min ?? 0,
      max: role.max ?? null,
    }),
  );
  return toFormDefinition({
    id: "form-1",
    name: "CFP",
    target: "submission",
    status: (over.status ?? "open") as never,
    closesAt: over.closesAt ?? null,
    submissionLimit: over.submissionLimit ?? null,
    allowMultipleDrafts: true,
    schema: {
      fields: [],
      rules: [],
      combinedLimits: [],
      participants: {
        collect: true,
        roles,
        maxTotal: over.maxTotal ?? null,
        minTotal: over.minTotal ?? null,
      },
      routing: { rules: [], defaultTrackId: null },
    },
    settings: over.settings ?? {},
  });
}

/* ----------------------------------------------------------------- seam */

describe("the WS1a seam", () => {
  it("is wired to the real form-schema module, not a local mock", () => {
    expect(FORM_SCHEMA_SOURCE).toBe("ws1a-form-schema");
    // A shape only WS1a's contract has.
    expect(definition().participants.roles[0]).toHaveProperty("key");
    expect(typeof toFormDefinition).toBe("function");
  });
});

/* -------------------------------------------------------------- step model */

describe("step model", () => {
  it("is the FIVE-step public flow, not the admin seven", () => {
    expect(WIZARD_STEPS).toEqual(["welcome", "account", "submission", "participant", "review"]);
    expect(DEFAULT_STEP_LABELS.welcome).toBe("Welcome!");
  });

  it("walks forward and back, and stops at both ends", () => {
    expect(nextStep("welcome")).toBe("account");
    expect(nextStep("review")).toBeNull();
    expect(prevStep("welcome")).toBeNull();
    expect(prevStep("review")).toBe("participant");
  });

  it("puts the step in the path", () => {
    expect(stepPath("aie-2026", "form-1", "participant")).toBe(
      "/submit/aie-2026/form-1/step/participant",
    );
  });

  it("takes stepper labels from the admin page headings, capped at 15 chars", () => {
    const settings = emptyFormSettings();
    settings.abstract.heading = "Your submission goes here";
    settings.participant.heading = "Speakers";
    settings.welcome.heading = "   ";

    const labels = stepLabels(settings);
    expect(labels.submission).toBe("Your submission");
    expect(labels.submission.length).toBe(15);
    expect(labels.participant).toBe("Speakers");
    // Blank override falls back rather than rendering an empty circle label.
    expect(labels.welcome).toBe(DEFAULT_STEP_LABELS.welcome);
    // Account and Review have no admin-side config.
    expect(labels.account).toBe("Account");
    expect(labels.review).toBe("Review");
  });

  it("uses WS1a's own defaults for a form that was never configured", () => {
    const labels = stepLabels(emptyFormSettings());
    expect(labels.submission).toBe("Submission");
    expect(labels.participant).toBe("Participant");
  });
});

describe("resolveStep", () => {
  it("MUST-FIRE: a logged-out visitor asking for a later step lands on Account", () => {
    for (const requested of ["submission", "participant", "review"]) {
      expect(resolveStep({ requested, signedIn: false, hasDraft: false })).toBe("account");
    }
  });

  it("MUST-NOT-FIRE: welcome and account stay reachable logged out", () => {
    expect(resolveStep({ requested: "welcome", signedIn: false, hasDraft: false })).toBe("welcome");
    expect(resolveStep({ requested: "account", signedIn: false, hasDraft: false })).toBe("account");
  });

  it("holds a signed-in visitor with no draft at Submission", () => {
    expect(resolveStep({ requested: "review", signedIn: true, hasDraft: false })).toBe("submission");
    expect(resolveStep({ requested: "review", signedIn: true, hasDraft: true })).toBe("review");
  });

  it("defaults an unknown step to Welcome instead of 404-ing", () => {
    expect(resolveStep({ requested: "nope", signedIn: true, hasDraft: true })).toBe("welcome");
    expect(resolveStep({ requested: undefined, signedIn: false, hasDraft: false })).toBe("welcome");
  });
});

/* -------------------------------------------------------------- close date */

describe("close-date gate", () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);

  it("MUST-NOT-FIRE: an open form with a future close date accepts submissions", () => {
    expect(closedReason(definition({ closesAt: now + 86_400_000 }), now)).toBeNull();
    expect(closedReason(definition({ closesAt: null }), now)).toBeNull();
  });

  it("MUST-FIRE: past the close date", () => {
    expect(closedReason(definition({ closesAt: now - 1 }), now)).toBe("past_close_date");
  });

  it("MUST-NOT-FIRE: exactly at the close date is still open", () => {
    expect(closedReason(definition({ closesAt: now }), now)).toBeNull();
  });

  it("MUST-FIRE: a form that is not open at all, whatever its close date", () => {
    expect(closedReason(definition({ status: "draft" }), now)).toBe("not_open");
    expect(
      closedReason(definition({ status: "closed", closesAt: now + 86_400_000 }), now),
    ).toBe("not_open");
  });

  it("renders the close date as prose in the EVENT timezone", () => {
    // 2026-09-16 06:59 UTC == 2026-09-15 23:59 PDT.
    const closes = Date.UTC(2026, 8, 16, 6, 59);
    expect(closeDateSentence(closes, "America/Los_Angeles")).toBe(
      "Form submissions will be accepted until September 15, 2026 at 11:59 PM PDT.",
    );
    // Same instant, different event timezone -> a different sentence.
    expect(closeDateSentence(closes, "UTC")).toContain("September 16");
  });

  it("renders nothing when there is no close date", () => {
    expect(closeDateSentence(null, "UTC")).toBeNull();
    expect(closeDateSentence(Number.NaN, "UTC")).toBeNull();
  });
});

/* -------------------------------------------------------- submission limit */

describe("submission limit", () => {
  it("MUST-NOT-FIRE below the cap; MUST-FIRE at and above it", () => {
    expect(checkSubmissionLimit({ formLimit: 3, eventLimit: 9, used: 2 }).reached).toBe(false);
    expect(checkSubmissionLimit({ formLimit: 3, eventLimit: 9, used: 3 }).reached).toBe(true);
    expect(checkSubmissionLimit({ formLimit: 3, eventLimit: 9, used: 4 }).reached).toBe(true);
  });

  it("a form-level limit overrides the event default", () => {
    const check = checkSubmissionLimit({ formLimit: 1, eventLimit: 9, used: 1 });
    expect(check.limit).toBe(1);
    expect(check.fromEvent).toBe(false);
    expect(check.reached).toBe(true);
  });

  it("the event default applies when the form sets none", () => {
    const check = checkSubmissionLimit({ formLimit: null, eventLimit: 3, used: 3 });
    expect(check.limit).toBe(3);
    expect(check.fromEvent).toBe(true);
    expect(check.reached).toBe(true);
  });

  it("MUST-NOT-FIRE when neither level sets a cap", () => {
    const check = checkSubmissionLimit({ formLimit: null, eventLimit: null, used: 99 });
    expect(check.limit).toBeNull();
    expect(check.reached).toBe(false);
    expect(submissionLimitSentence(check)).toBeNull();
  });

  it("renders the limit sentence from the screenshot", () => {
    expect(
      submissionLimitSentence(checkSubmissionLimit({ formLimit: 3, eventLimit: null, used: 0 })),
    ).toBe("Submission Limit: 3 submissions per user");
    expect(
      submissionLimitSentence(checkSubmissionLimit({ formLimit: 1, eventLimit: null, used: 0 })),
    ).toBe("Submission Limit: 1 submission per user");
  });
});

/* ---------------------------------------------------------- participants */

describe("participant roles", () => {
  it("offers only the roles the builder enabled", () => {
    const def = definition({
      roles: [
        { key: "speaker", label: "Speaker", enabled: true, min: 1 },
        { key: "moderator", label: "Moderator", enabled: false, min: 0 },
      ],
    });
    expect(enabledRoles(def).map((role) => role.key)).toEqual(["speaker"]);
  });

  it("renders the walkthrough's exact indicator string", () => {
    const role: ParticipantRoleConfig = {
      key: "speaker",
      label: "Speaker",
      enabled: true,
      min: 2,
      max: 4,
    };
    expect(roleIndicator(role, 1)).toBe("Speaker: 2–4 required · 1 added");
    expect(roleIndicator({ ...role, max: null }, 3)).toBe("Speaker: 2+ required · 3 added");
    expect(roleIndicator({ ...role, min: 1, max: 1 }, 1)).toBe("Speaker: 1 required · 1 added");
  });
});

describe("checkParticipants", () => {
  const def = definition({
    roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 2, max: 4 }],
  });

  it("MUST-FIRE below the minimum, with the red inline hint", () => {
    const check = checkParticipants({ def, participants: [participant()] });
    expect(check.ok).toBe(false);
    expect(check.roles[0].hint).toBe("Add 1 more Speaker (minimum 2).");
    expect(check.roles[0].indicator).toBe("Speaker: 2–4 required · 1 added");
    expect(check.roles[0].satisfied).toBe(false);
  });

  it("MUST-NOT-FIRE exactly at the minimum and inside the range", () => {
    for (const count of [2, 3, 4]) {
      const check = checkParticipants({
        def,
        participants: Array.from({ length: count }, () => participant()),
      });
      expect(check.ok).toBe(true);
      expect(check.roles[0].hint).toBeNull();
      expect(check.roles[0].satisfied).toBe(true);
    }
  });

  it("MUST-FIRE above the maximum", () => {
    const check = checkParticipants({
      def,
      participants: Array.from({ length: 5 }, () => participant()),
    });
    expect(check.ok).toBe(false);
    expect(check.roles[0].hint).toBe("Remove 1 Speaker (maximum 4).");
  });

  it("MUST-FIRE on the across-roles total cap; MUST-NOT-FIRE at the cap", () => {
    const roles = [
      { key: "speaker", label: "Speaker", enabled: true, min: 1, max: 3 },
      { key: "moderator", label: "Moderator", enabled: true, min: 0, max: 2 },
    ];
    const people = [participant(), participant(), participant({ role: "moderator" })];
    expect(checkParticipants({ def: definition({ roles, maxTotal: 2 }), participants: people }).ok).toBe(
      false,
    );
    expect(checkParticipants({ def: definition({ roles, maxTotal: 3 }), participants: people }).ok).toBe(
      true,
    );
  });

  it("MUST-FIRE on a duplicate email, a blank name, and a malformed address", () => {
    const open = definition({
      roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: null }],
    });
    const dup = participant({ email: "same@example.com" });

    expect(
      checkParticipants({ def: open, participants: [dup, { ...dup }] }).errors.join(" "),
    ).toMatch(/listed twice/);
    expect(
      checkParticipants({ def: open, participants: [participant({ firstName: " " })] })
        .errors.join(" "),
    ).toMatch(/first and last name/);
    expect(
      checkParticipants({ def: open, participants: [participant({ email: "not-an-email" })] })
        .errors.join(" "),
    ).toMatch(/not a valid email/);
  });

  it("MUST-NOT-FIRE on a well-formed single participant", () => {
    const open = definition({
      roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: null }],
    });
    expect(checkParticipants({ def: open, participants: [participant()] }).errors).toEqual([]);
  });

  it("gates the + Add button on the role max and the total cap", () => {
    const capped = definition({
      roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: 2 }],
      maxTotal: 4,
    });
    expect(canAddParticipant(checkParticipants({ def: capped, participants: [participant()] }))).toBe(
      true,
    );
    expect(
      canAddParticipant(
        checkParticipants({ def: capped, participants: [participant(), participant()] }),
      ),
    ).toBe(false);

    const totalCapped = definition({
      roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: null }],
      maxTotal: 2,
    });
    expect(
      canAddParticipant(
        checkParticipants({ def: totalCapped, participants: [participant(), participant()] }),
      ),
    ).toBe(false);
  });
});

describe("toFormAnswers", () => {
  it("bridges the wizard's draft into the evaluator's shape", () => {
    const answers = toFormAnswers({ title: "Agents" }, [
      participant({ role: "speaker", answers: { bio: "hi" } }),
    ]);
    expect(answers.fields.title).toBe("Agents");
    expect(answers.participants).toEqual([{ role: "speaker", answers: { bio: "hi" } }]);
  });

  it("gives a participant with no field answers an empty object, not undefined", () => {
    expect(toFormAnswers({}, [participant()]).participants[0].answers).toEqual({});
  });
});

/* ------------------------------------------------------- content: text/video */

describe("checkContent — abstract OR video", () => {
  it("MUST-NOT-FIRE: a form that collects no abstract field is not asked for prose", () => {
    // A title-and-track form, or one with no questions yet: there is no box to
    // type an abstract into, so demanding one would be unsatisfiable.
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: false,
        mode: "abstract",
        abstract: "",
        videoUrl: "",
        uploadKey: null,
      }).error,
    ).toBeNull();
  });

  it("MUST-FIRE: abstract mode with no prose", () => {
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: true,
        mode: "abstract",
        abstract: "  ",
        videoUrl: "",
        uploadKey: null,
      }).error,
    ).toMatch(/Write an abstract/);
  });

  it("MUST-NOT-FIRE: abstract mode with prose", () => {
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: true,
        mode: "abstract",
        abstract: "A talk about agents.",
        videoUrl: "",
        uploadKey: null,
      }).error,
    ).toBeNull();
  });

  it("MUST-FIRE: video mode with neither a link nor an upload", () => {
    const result = checkContent({
      allowed: "either",
      collectsAbstract: true,
      mode: "video",
      abstract: "",
      videoUrl: "",
      uploadKey: null,
    });
    expect(result.mode).toBe("video");
    expect(result.error).toMatch(/video link or upload/);
  });

  it("MUST-NOT-FIRE: video mode satisfied by a link, or by an upload alone", () => {
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: true,
        mode: "video",
        abstract: "",
        videoUrl: "https://youtu.be/abc",
        uploadKey: null,
      }).error,
    ).toBeNull();
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: true,
        mode: "video",
        abstract: "",
        videoUrl: "",
        uploadKey: "ev/session/x/other/file.mp4",
      }).error,
    ).toBeNull();
  });

  it("MUST-FIRE: video mode with a malformed link", () => {
    expect(
      checkContent({
        allowed: "either",
        collectsAbstract: true,
        mode: "video",
        abstract: "",
        videoUrl: "youtube dot com",
        uploadKey: null,
      }).error,
    ).toMatch(/http/);
  });

  it("a form that forces one mode ignores the submitter's choice", () => {
    expect(
      checkContent({
        allowed: "video",
        collectsAbstract: true,
        mode: "abstract",
        abstract: "prose",
        videoUrl: "",
        uploadKey: null,
      }).mode,
    ).toBe("video");
    expect(
      checkContent({
        allowed: "abstract",
        collectsAbstract: true,
        mode: "video",
        abstract: "prose",
        videoUrl: "",
        uploadKey: null,
      }).mode,
    ).toBe("abstract");
  });
});
