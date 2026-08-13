import { describe, expect, it } from "vitest";

import {
  applyAnswers,
  canPublish,
  isPastDeadline,
  isPortalForm,
  questionKey,
  readPortalSchema,
  readPortalSettings,
  stepIssues,
  validateAnswers,
  type PortalFormDraft,
  type PortalFormSchema,
} from "./portal-form";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

const schema = (questions: PortalFormSchema["questions"]): PortalFormSchema => ({
  sectionTitle: "Update your information",
  questions,
});

const draft = (over: Partial<PortalFormDraft> = {}): PortalFormDraft => ({
  name: "Speaker logistics",
  title: "Tell us how to look after you",
  type: "submissions",
  schema: schema([{ key: "shirt", label: "Shirt size", type: "select", options: ["S", "M", "L"] }]),
  settings: { surface: "portal", type: "submissions", requireLogin: true },
  ...over,
});

describe("isPortalForm", () => {
  it("fires on the portal discriminator", () => {
    expect(isPortalForm({ surface: "portal", type: "submissions" })).toBe(true);
  });

  /* must-not-fire: a CFP form targeting `submission` is NOT a portal form */
  it("does NOT treat a CFP form as a portal form", () => {
    expect(isPortalForm({ notifyAdmins: ["a@b.c"] })).toBe(false);
    expect(isPortalForm({})).toBe(false);
    expect(isPortalForm(null)).toBe(false);
  });
});

describe("readPortalSchema / readPortalSettings", () => {
  it("survives garbage without throwing", () => {
    expect(readPortalSchema(null).questions).toEqual([]);
    expect(readPortalSchema("nope").questions).toEqual([]);
    expect(readPortalSchema({ questions: "no" }).questions).toEqual([]);
    expect(readPortalSchema({}).sectionTitle).toBe("Your information");
  });

  it("drops questions with an unknown type instead of rendering them", () => {
    const parsed = readPortalSchema({
      sectionTitle: "s",
      questions: [
        { key: "ok", label: "Ok", type: "text" },
        { key: "bad", label: "Bad", type: "quantum" },
        { key: "worse", type: "text" },
      ],
    });
    expect(parsed.questions.map((q) => q.key)).toEqual(["ok"]);
  });

  it("defaults settings sanely", () => {
    const settings = readPortalSettings(null);
    expect(settings.surface).toBe("portal");
    expect(settings.type).toBe("submissions");
    expect(settings.requireLogin).toBe(true);
    expect(settings.deadlineAt).toBeNull();
  });

  it("keeps a valid type and falls back for anything else", () => {
    expect(readPortalSettings({ type: "submissions" }).type).toBe("submissions");
    // `contacts`/`groups` are cut for this deadline (DECISIONS.md #25), so a
    // stored row carrying one must not render an unbuildable form type.
    expect(readPortalSettings({ type: "contacts" }).type).toBe("submissions");
    expect(readPortalSettings({ type: "groups" }).type).toBe("submissions");
    expect(readPortalSettings({ type: "hackers" }).type).toBe("submissions");
  });
});

describe("questionKey", () => {
  it("slugifies a label", () => {
    expect(questionKey("Dietary needs?")).toBe("dietary_needs");
    expect(questionKey("T-shirt size")).toBe("t_shirt_size");
  });

  it("de-duplicates against taken keys", () => {
    expect(questionKey("Notes", ["notes"])).toBe("notes_2");
    expect(questionKey("Notes", ["notes", "notes_2"])).toBe("notes_3");
  });

  it("falls back for a label with no usable characters", () => {
    expect(questionKey("???")).toBe("question");
  });
});

describe("stepIssues", () => {
  it("blocks step 1 on a missing name, title or type", () => {
    expect(stepIssues(draft({ name: "  " }), "setup")).toContain("Name is required.");
    expect(stepIssues(draft({ title: "" }), "setup")).toContain("Title is required.");
    expect(stepIssues(draft({ type: null }), "setup")).toContain("Choose a type.");
  });

  it("blocks step 2 on no questions, a blank label, a duplicate key or an optionless select", () => {
    expect(stepIssues(draft({ schema: schema([]) }), "questions")).toContain(
      "Add at least one question.",
    );
    expect(
      stepIssues(draft({ schema: schema([{ key: "a", label: "", type: "text" }]) }), "questions"),
    ).toContain("Every question needs a label.");
    expect(
      stepIssues(
        draft({
          schema: schema([
            { key: "a", label: "A", type: "text" },
            { key: "a", label: "A again", type: "text" },
          ]),
        }),
        "questions",
      ),
    ).toContain("Duplicate question key: a");
    expect(
      stepIssues(
        draft({ schema: schema([{ key: "s", label: "Size", type: "select" }]) }),
        "questions",
      ),
    ).toContain('"Size" needs at least one option.');
  });

  it("blocks step 3 on a confirmation email with no body, and a reminder with no deadline", () => {
    expect(
      stepIssues(
        draft({ settings: { surface: "portal", type: "submissions", sendConfirmationEmail: true } }),
        "settings",
      ),
    ).toContain("Confirmation email is on but the body is empty.");
    expect(
      stepIssues(
        draft({ settings: { surface: "portal", type: "submissions", reminderDaysBefore: 3 } }),
        "settings",
      ),
    ).toContain("A reminder needs a deadline to count back from.");
  });

  /* must-not-fire: a valid draft has no issues on any step */
  it("does NOT block a complete draft", () => {
    const complete = draft();
    expect(stepIssues(complete, "setup")).toEqual([]);
    expect(stepIssues(complete, "questions")).toEqual([]);
    expect(stepIssues(complete, "settings")).toEqual([]);
    expect(canPublish(complete)).toBe(true);
  });

  it("does NOT demand a body for a confirmation email that is switched off", () => {
    expect(
      stepIssues(
        draft({ settings: { surface: "portal", type: "submissions", sendConfirmationEmail: false } }),
        "settings",
      ),
    ).toEqual([]);
  });

  it("canPublish is false while any step is dirty", () => {
    expect(canPublish(draft({ type: null }))).toBe(false);
  });
});

describe("validateAnswers", () => {
  it("fires on a missing required answer", () => {
    const issues = validateAnswers(
      schema([{ key: "shirt", label: "Shirt size", type: "text", required: true }]),
      {},
    );
    expect(issues).toEqual([{ key: "shirt", message: "Shirt size is required." }]);
  });

  it("fires on maxLength, bad email, bad url, non-number and a value outside the options", () => {
    const issues = validateAnswers(
      schema([
        { key: "bio", label: "Bio", type: "textarea", maxLength: 5 },
        { key: "mail", label: "Email", type: "email" },
        { key: "site", label: "Website", type: "url" },
        { key: "n", label: "Count", type: "number" },
        { key: "size", label: "Size", type: "select", options: ["S", "M"] },
      ]),
      { bio: "far too long", mail: "not-an-email", site: "ftp://x", n: "abc", size: "XXL" },
    );
    expect(issues.map((issue) => issue.key).sort()).toEqual(["bio", "mail", "n", "site", "size"]);
    expect(issues.find((issue) => issue.key === "bio")?.message).toContain("currently 12");
  });

  it("fires on a multiselect value outside the options", () => {
    const issues = validateAnswers(
      schema([{ key: "days", label: "Days", type: "multiselect", options: ["Mon", "Tue"] }]),
      { days: ["Mon", "Sun"] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Sun");
  });

  /* --- must NOT fire --- */

  it("does NOT fire on a valid answer set", () => {
    const issues = validateAnswers(
      schema([
        { key: "bio", label: "Bio", type: "textarea", maxLength: 50, required: true },
        { key: "mail", label: "Email", type: "email" },
        { key: "site", label: "Website", type: "url" },
        { key: "n", label: "Count", type: "number" },
        { key: "size", label: "Size", type: "select", options: ["S", "M"] },
        { key: "days", label: "Days", type: "multiselect", options: ["Mon", "Tue"] },
      ]),
      {
        bio: "Short bio.",
        mail: "sam@example.com",
        site: "https://example.com/sam",
        n: "3",
        size: "M",
        days: ["Mon", "Tue"],
      },
    );
    expect(issues).toEqual([]);
  });

  it("does NOT fire on an optional question left blank", () => {
    expect(
      validateAnswers(schema([{ key: "notes", label: "Notes", type: "textarea" }]), { notes: "" }),
    ).toEqual([]);
  });

  it("does NOT demand a locked question the responder cannot edit", () => {
    expect(
      validateAnswers(
        schema([{ key: "id", label: "Session ID", type: "text", required: true, locked: true }]),
        {},
      ),
    ).toEqual([]);
  });

  it("does NOT fire on a value exactly at maxLength (off-by-one guard)", () => {
    expect(
      validateAnswers(schema([{ key: "b", label: "B", type: "text", maxLength: 5 }]), { b: "12345" }),
    ).toEqual([]);
    expect(
      validateAnswers(schema([{ key: "b", label: "B", type: "text", maxLength: 5 }]), { b: "123456" }),
    ).toHaveLength(1);
  });

  it("treats an unchecked required checkbox as missing", () => {
    expect(
      validateAnswers(schema([{ key: "ok", label: "Agree", type: "checkbox", required: true }]), {
        ok: false,
      }),
    ).toHaveLength(1);
    expect(
      validateAnswers(schema([{ key: "ok", label: "Agree", type: "checkbox", required: true }]), {
        ok: true,
      }),
    ).toEqual([]);
  });
});

describe("applyAnswers", () => {
  it("keeps a locked answer and ignores the submitted override", () => {
    const result = applyAnswers(
      schema([
        { key: "id", label: "Session ID", type: "text", locked: true },
        { key: "notes", label: "Notes", type: "textarea" },
      ]),
      { id: "SESS-1", notes: "old" },
      { id: "SESS-HACKED", notes: "new" },
    );
    expect(result).toEqual({ id: "SESS-1", notes: "new" });
  });

  it("drops keys that are not in the schema", () => {
    const result = applyAnswers(schema([{ key: "notes", label: "Notes", type: "textarea" }]), null, {
      notes: "kept",
      isAdmin: "true",
    });
    expect(result).toEqual({ notes: "kept" });
    expect(result).not.toHaveProperty("isAdmin");
  });

  it("preserves a prior answer when the field is not resubmitted", () => {
    const result = applyAnswers(
      schema([{ key: "notes", label: "Notes", type: "textarea" }]),
      { notes: "prior" },
      {},
    );
    expect(result.notes).toBe("prior");
  });
});

describe("isPastDeadline", () => {
  it("fires after the deadline", () => {
    expect(isPastDeadline({ surface: "portal", type: "submissions", deadlineAt: NOW - 1 }, NOW)).toBe(
      true,
    );
  });

  it("does NOT fire before the deadline or when there is none", () => {
    expect(isPastDeadline({ surface: "portal", type: "submissions", deadlineAt: NOW + 1 }, NOW)).toBe(
      false,
    );
    expect(isPastDeadline({ surface: "portal", type: "submissions" }, NOW)).toBe(false);
    expect(isPastDeadline({ surface: "portal", type: "submissions", deadlineAt: null }, NOW)).toBe(
      false,
    );
  });
});
