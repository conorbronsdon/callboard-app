/**
 * Contract tests for the form evaluator. Every rule family gets a MUST-FIRE and
 * a MUST-NOT-FIRE case (AGENTS.md ground rule 2) — a validator that only ever
 * says "no" is as broken as one that only ever says "yes".
 */
import { describe, expect, it } from "vitest";

import { FIELD_TYPES } from "~/db/schema";
import {
  type CombinedLimitRule,
  type ConditionalRule,
  type FormAnswers,
  type FormDefinition,
  type FormFieldRef,
  type RoutingRule,
  combinedCounters,
  countChars,
  effectiveSubmissionLimit,
  emptyFormSchema,
  emptyFormSettings,
  evaluateCondition,
  fieldStates,
  hydrateFieldRefs,
  isFormOpen,
  parseFormSchema,
  parseFormSettings,
  routeCategory,
  toFormDefinition,
  validate,
  visibleFields,
  visibleParticipantFields,
} from "./form-schema";

/* ------------------------------------------------------------- fixtures */

const field = (over: Partial<FormFieldRef> & Pick<FormFieldRef, "key">): FormFieldRef => ({
  fieldId: `fd-${over.key}`,
  type: "text",
  label: over.key,
  scope: "submission",
  order: 0,
  required: false,
  ...over,
});

/**
 * Note the participants default: the PRODUCT default is `collect: true` with
 * `speaker.min = 1` (DECISIONS.md #7), which means an answer set with zero
 * participants legitimately fails. Fixtures that are not about participants
 * turn collection off so a role_min issue cannot mask the rule under test;
 * the participant suite below sets its own config.
 */
function makeForm(over: Partial<FormDefinition> = {}): FormDefinition {
  const base = emptyFormSchema();
  return {
    ...base,
    participants: { ...base.participants, collect: false },
    id: "form-1",
    name: "Call for Proposals",
    target: "submission",
    status: "open",
    closesAt: null,
    submissionLimit: null,
    allowMultipleDrafts: true,
    settings: emptyFormSettings(),
    ...over,
  };
}

const answers = (over: Partial<FormAnswers> = {}): FormAnswers => ({
  fields: {},
  participants: [],
  ...over,
});

const speakerOnly = (count: number): FormAnswers =>
  answers({
    participants: Array.from({ length: count }, (_, i) => ({
      role: "speaker",
      answers: { first_name: `Speaker ${i}` },
    })),
  });

/* --------------------------------------------------------- primitives */

describe("countChars", () => {
  it("counts a plain string verbatim", () => {
    expect(countChars("hello", "text")).toBe(5);
  });

  it("strips markup on wysiwyg answers so tags do not eat the budget", () => {
    // must-fire: HTML is stripped
    expect(countChars("<p><strong>hello</strong></p>", "wysiwyg")).toBe(5);
  });

  it("does NOT strip markup on a plain text field", () => {
    // must-not-fire: text fields are literal — 5 chars + 24 of markup
    expect(countChars("<p><strong>hello</strong></p>", "text")).toBe(29);
  });

  it("counts an entity as the one character it renders as", () => {
    expect(countChars("a&nbsp;b", "wysiwyg")).toBe(3);
  });

  it("treats null/undefined as zero", () => {
    expect(countChars(null)).toBe(0);
    expect(countChars(undefined)).toBe(0);
  });
});

describe("evaluateCondition", () => {
  const lookup = (values: Record<string, unknown>) => (key: string) => values[key] as never;

  it("equals fires on a match and not on a miss", () => {
    const c = { fieldKey: "track", op: "equals" as const, value: "Agents" };
    expect(evaluateCondition(c, lookup({ track: "Agents" }))).toBe(true);
    expect(evaluateCondition(c, lookup({ track: "Infra" }))).toBe(false);
  });

  it("is_empty distinguishes empty string, empty array and a real answer", () => {
    const c = { fieldKey: "x", op: "is_empty" as const };
    expect(evaluateCondition(c, lookup({ x: "" }))).toBe(true);
    expect(evaluateCondition(c, lookup({ x: [] }))).toBe(true);
    expect(evaluateCondition(c, lookup({ x: "hi" }))).toBe(false);
  });

  it("contains works for substrings and for multiselect membership", () => {
    expect(
      evaluateCondition(
        { fieldKey: "tags", op: "contains", value: "oss" },
        lookup({ tags: ["oss", "prod"] }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { fieldKey: "tags", op: "contains", value: "research" },
        lookup({ tags: ["oss", "prod"] }),
      ),
    ).toBe(false);
  });

  it("greater_than needs two real numbers — a blank answer never fires", () => {
    const c = { fieldKey: "n", op: "greater_than" as const, value: 10 };
    expect(evaluateCondition(c, lookup({ n: 11 }))).toBe(true);
    expect(evaluateCondition(c, lookup({ n: 10 }))).toBe(false);
    expect(evaluateCondition(c, lookup({ n: "" }))).toBe(false);
  });

  it("in / not_in match against a list", () => {
    expect(
      evaluateCondition(
        { fieldKey: "fmt", op: "in", value: ["Workshop", "Tutorial"] },
        lookup({ fmt: "Workshop" }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { fieldKey: "fmt", op: "not_in", value: ["Workshop", "Tutorial"] },
        lookup({ fmt: "Talk" }),
      ),
    ).toBe(true);
  });
});

/* --------------------------------------------------- conditional logic */

describe("conditional logic — visibility", () => {
  const showRule: ConditionalRule = {
    id: "r1",
    match: "all",
    when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
    action: "show",
    targetKeys: ["workshop_prereqs"],
  };

  const def = makeForm({
    fields: [
      field({ key: "format", type: "select", order: 0 }),
      field({ key: "workshop_prereqs", order: 1 }),
      field({ key: "abstract", order: 2 }),
    ],
    rules: [showRule],
  });

  it("hides a show-targeted field until its rule fires (must-not-fire)", () => {
    const keys = visibleFields(answers({ fields: { format: "Talk" } }), def).map((f) => f.key);
    expect(keys).toEqual(["format", "abstract"]);
  });

  it("reveals it when the rule fires (must-fire)", () => {
    const keys = visibleFields(answers({ fields: { format: "Workshop" } }), def).map((f) => f.key);
    expect(keys).toEqual(["format", "workshop_prereqs", "abstract"]);
  });

  it("leaves untargeted fields visible in both directions", () => {
    for (const format of ["Talk", "Workshop"]) {
      expect(visibleFields(answers({ fields: { format } }), def).map((f) => f.key)).toContain(
        "abstract",
      );
    }
  });

  it("a firing hide rule beats a firing show rule", () => {
    const both = makeForm({
      fields: def.fields,
      rules: [
        showRule,
        {
          id: "r2",
          match: "all",
          when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
          action: "hide",
          targetKeys: ["workshop_prereqs"],
        },
      ],
    });
    expect(
      visibleFields(answers({ fields: { format: "Workshop" } }), both).map((f) => f.key),
    ).not.toContain("workshop_prereqs");
  });

  it("a rule with no conditions never fires", () => {
    const empty = makeForm({
      fields: [field({ key: "a" }), field({ key: "b", order: 1 })],
      rules: [{ id: "r", match: "all", when: [], action: "hide", targetKeys: ["b"] }],
    });
    expect(visibleFields(answers(), empty).map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("respects `enabled: false` (a disabled rule is inert)", () => {
    const disabled = makeForm({
      fields: def.fields,
      rules: [{ ...showRule, enabled: false }],
    });
    // With the only show-rule disabled, the field is no longer show-targeted,
    // so it falls back to visible-by-default.
    expect(
      visibleFields(answers({ fields: { format: "Talk" } }), disabled).map((f) => f.key),
    ).toContain("workshop_prereqs");
  });

  it("`any` matches on one condition, `all` needs both", () => {
    const base = {
      id: "r",
      when: [
        { fieldKey: "format", op: "equals" as const, value: "Workshop" },
        { fieldKey: "track", op: "equals" as const, value: "Agents" },
      ],
      action: "show" as const,
      targetKeys: ["workshop_prereqs"],
    };
    const anyDef = makeForm({ fields: def.fields, rules: [{ ...base, match: "any" }] });
    const allDef = makeForm({ fields: def.fields, rules: [{ ...base, match: "all" }] });
    const partial = answers({ fields: { format: "Workshop", track: "Infra" } });

    expect(visibleFields(partial, anyDef).map((f) => f.key)).toContain("workshop_prereqs");
    expect(visibleFields(partial, allDef).map((f) => f.key)).not.toContain("workshop_prereqs");
  });
});

describe("conditional logic — requiredness", () => {
  const def = makeForm({
    fields: [
      field({ key: "format", type: "select" }),
      field({ key: "video_url", order: 1, required: false, label: "Video URL" }),
      field({ key: "abstract", order: 2, required: true, label: "Abstract" }),
    ],
    rules: [
      {
        id: "req",
        match: "all",
        when: [{ fieldKey: "format", op: "equals", value: "Video" }],
        action: "require",
        targetKeys: ["video_url"],
      },
      {
        id: "opt",
        match: "all",
        when: [{ fieldKey: "format", op: "equals", value: "Lightning" }],
        action: "optional",
        targetKeys: ["abstract"],
      },
    ],
  });

  it("require fires: a blank optional field becomes a blocking error", () => {
    const result = validate(answers({ fields: { format: "Video", abstract: "x" } }), def);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => `${i.code}:${i.fieldKey}`)).toContain("required:video_url");
  });

  it("require does NOT fire on another value (must-not-fire)", () => {
    const result = validate(answers({ fields: { format: "Talk", abstract: "x" } }), def);
    expect(result.issues.map((i) => i.fieldKey)).not.toContain("video_url");
    expect(result.ok).toBe(true);
  });

  it("optional clears a base-required field when its rule fires", () => {
    const fires = validate(answers({ fields: { format: "Lightning" } }), def);
    expect(fires.ok).toBe(true);

    const doesNot = validate(answers({ fields: { format: "Talk" } }), def);
    expect(doesNot.ok).toBe(false);
    expect(doesNot.issues.map((i) => `${i.code}:${i.fieldKey}`)).toContain("required:abstract");
  });

  const hidden = makeForm({
    fields: [
      field({ key: "format", type: "select" }),
      field({ key: "secret", order: 1, required: true, label: "Secret" }),
    ],
    rules: [
      {
        id: "h",
        match: "all",
        when: [{ fieldKey: "format", op: "equals", value: "Talk" }],
        action: "hide",
        targetKeys: ["secret"],
      },
    ],
  });

  it("a hidden required field never blocks the submission", () => {
    expect(validate(answers({ fields: { format: "Talk" } }), hidden).ok).toBe(true);
    // must-not-fire complement: when it IS visible it blocks.
    expect(validate(answers({ fields: { format: "Workshop" } }), hidden).ok).toBe(false);
  });

  it("reports hidden fields as not-required in fieldStates — the UI reads this", () => {
    // validate() skips hidden fields wholesale, so this invariant is only
    // observable here; without it the builder would paint a required asterisk
    // on a field nobody can see.
    const off = fieldStates(answers({ fields: { format: "Talk" } }), hidden, "submission");
    expect(off.get("secret")).toEqual({ visible: false, required: false });

    const on = fieldStates(answers({ fields: { format: "Workshop" } }), hidden, "submission");
    expect(on.get("secret")).toEqual({ visible: true, required: true });
  });
});

/* ----------------------------------------------- per-field validation */

describe("per-field validation", () => {
  const def = makeForm({
    fields: [
      field({
        key: "title",
        label: "Title",
        required: true,
        validation: { maxLength: 10 },
      }),
      field({
        key: "abstract",
        label: "Abstract",
        type: "wysiwyg",
        validation: { minLength: 20 },
      }),
      field({
        key: "seats",
        label: "Seats",
        type: "number",
        validation: { min: 5, max: 50 },
      }),
      field({
        key: "track",
        label: "Track",
        type: "select",
        validation: { options: ["Agents", "Infra"] },
      }),
      field({
        key: "tags",
        label: "Tags",
        type: "multiselect",
        validation: { maxSelected: 2 },
      }),
      field({
        key: "email",
        label: "Email",
        type: "email",
        validation: { pattern: "^[^@\\s]+@[^@\\s]+$", patternMessage: "Enter a real email." },
      }),
    ],
  });

  it("passes a fully valid submission", () => {
    const result = validate(
      answers({
        fields: {
          title: "Short",
          abstract: "<p>" + "a".repeat(25) + "</p>",
          seats: 20,
          track: "Agents",
          tags: ["oss"],
          email: "a@b.co",
        },
      }),
      def,
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("catches each rule individually", () => {
    const result = validate(
      answers({
        fields: {
          title: "This title is far too long",
          abstract: "<p>short</p>",
          seats: 99,
          track: "Nonsense",
          tags: ["a", "b", "c"],
          email: "not-an-email",
        },
      }),
      def,
    );
    const codes = result.issues.map((i) => `${i.code}:${i.fieldKey}`);
    expect(codes).toContain("max_length:title");
    expect(codes).toContain("min_length:abstract");
    expect(codes).toContain("max:seats");
    expect(codes).toContain("option:track");
    expect(codes).toContain("max_selected:tags");
    expect(codes).toContain("pattern:email");
  });

  it("measures wysiwyg length after stripping markup", () => {
    // 25 visible chars wrapped in 30 chars of markup — the markup must not count.
    const body = `<p><em>${"a".repeat(25)}</em></p>`;
    expect(validate(answers({ fields: { title: "ok", abstract: body } }), def).ok).toBe(true);
    const tooShort = `<p><em><strong>${"a".repeat(19)}</strong></em></p>`;
    expect(validate(answers({ fields: { title: "ok", abstract: tooShort } }), def).ok).toBe(false);
  });

  it("draft mode skips required and minimums but still enforces maximums", () => {
    const draft = validate(
      answers({ fields: { abstract: "<p>tiny</p>", title: "way way too long" } }),
      def,
      { draft: true },
    );
    const codes = draft.issues.map((i) => i.code);
    expect(codes).not.toContain("required");
    expect(codes).not.toContain("min_length");
    expect(codes).toContain("max_length");
  });

  it("does not throw on an unparseable regex — it just does not flag", () => {
    const broken = makeForm({
      fields: [field({ key: "x", label: "X", validation: { pattern: "([" } })],
    });
    expect(validate(answers({ fields: { x: "anything" } }), broken).ok).toBe(true);
  });
});

/* --------------------------------------------- cross-field char limits */

describe("cross-field combined character limits", () => {
  const limit: CombinedLimitRule = {
    id: "cl1",
    label: "Printed program block",
    fieldKeys: ["title", "teaser"],
    maxChars: 40,
    scope: "submission",
  };

  const def = makeForm({
    fields: [
      field({ key: "title", label: "Title" }),
      field({ key: "teaser", label: "Teaser", order: 1 }),
    ],
    combinedLimits: [limit],
  });

  it("BLOCKS when the combined length exceeds the cap (must-fire)", () => {
    const result = validate(
      answers({ fields: { title: "a".repeat(30), teaser: "b".repeat(15) } }),
      def,
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "combined_limit");
    expect(issue?.actual).toBe(45);
    expect(issue?.limit).toBe(40);
    expect(issue?.ruleId).toBe("cl1");
  });

  it("UNBLOCKS once a field is trimmed (must-not-fire)", () => {
    const result = validate(
      answers({ fields: { title: "a".repeat(30), teaser: "b".repeat(10) } }),
      def,
    );
    expect(result.issues.filter((i) => i.code === "combined_limit")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is off-by-one exact: 40 passes, 41 fails", () => {
    const at = validate(answers({ fields: { title: "a".repeat(40), teaser: "" } }), def);
    expect(at.ok).toBe(true);
    const over = validate(answers({ fields: { title: "a".repeat(41), teaser: "" } }), def);
    expect(over.ok).toBe(false);
  });

  it("exposes a live counter with used/remaining for the public form", () => {
    const [counter] = combinedCounters(
      answers({ fields: { title: "abc", teaser: "de" } }),
      def,
    );
    expect(counter).toMatchObject({
      ruleId: "cl1",
      label: "Printed program block",
      used: 5,
      max: 40,
      remaining: 35,
      over: false,
      participantIndex: null,
    });
  });

  it("excludes a hidden field from the combined count", () => {
    const withHide = makeForm({
      fields: def.fields.concat(field({ key: "mode", type: "select", order: 2 })),
      combinedLimits: [limit],
      rules: [
        {
          id: "h",
          match: "all",
          when: [{ fieldKey: "mode", op: "equals", value: "short" }],
          action: "hide",
          targetKeys: ["teaser"],
        },
      ],
    });
    const over = { title: "a".repeat(30), teaser: "b".repeat(30) };
    expect(validate(answers({ fields: { ...over, mode: "short" } }), withHide).ok).toBe(true);
    expect(validate(answers({ fields: { ...over, mode: "long" } }), withHide).ok).toBe(false);
  });

  it("applies a participant-scope rule to EACH participant separately", () => {
    const perSpeaker = makeForm({
      fields: [
        field({ key: "bio", label: "Bio", scope: "participant" }),
        field({ key: "tagline", label: "Tagline", scope: "participant", order: 1 }),
      ],
      combinedLimits: [
        {
          id: "cl2",
          label: "Speaker blurb",
          fieldKeys: ["bio", "tagline"],
          maxChars: 20,
          scope: "participant",
        },
      ],
      participants: {
        collect: true,
        roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: 3 }],
        maxTotal: null,
        minTotal: null,
      },
    });

    const twoSpeakers = answers({
      participants: [
        { role: "speaker", answers: { bio: "a".repeat(10), tagline: "b".repeat(5) } },
        { role: "speaker", answers: { bio: "a".repeat(18), tagline: "b".repeat(9) } },
      ],
    });

    const counters = combinedCounters(twoSpeakers, perSpeaker);
    expect(counters).toHaveLength(2);
    expect(counters[0]).toMatchObject({ participantIndex: 0, used: 15, over: false });
    expect(counters[1]).toMatchObject({ participantIndex: 1, used: 27, over: true });

    const result = validate(twoSpeakers, perSpeaker);
    const issue = result.issues.find((i) => i.code === "combined_limit");
    expect(issue?.participantIndex).toBe(1);
  });
});

/* ------------------------------------------------------- participants */

describe("participant roles", () => {
  const def = makeForm({
    fields: [field({ key: "first_name", label: "First name", scope: "participant", required: true })],
    participants: {
      collect: true,
      roles: [
        { key: "speaker", label: "Speaker", enabled: true, min: 2, max: 4 },
        { key: "moderator", label: "Moderator", enabled: false, min: 0, max: null },
      ],
      maxTotal: 5,
      minTotal: null,
    },
  });

  it("blocks below the role minimum with the '2–4 required · 1 added' message", () => {
    const result = validate(speakerOnly(1), def);
    const issue = result.issues.find((i) => i.code === "role_min");
    expect(issue?.message).toBe("Speaker: 2–4 required · 1 added");
    expect(issue?.actual).toBe(1);
  });

  it("passes inside the range (must-not-fire)", () => {
    expect(validate(speakerOnly(2), def).ok).toBe(true);
    expect(validate(speakerOnly(4), def).ok).toBe(true);
  });

  it("blocks above the role maximum", () => {
    const result = validate(speakerOnly(5), def);
    expect(result.issues.map((i) => i.code)).toContain("role_max");
  });

  it("enforces the across-roles total cap", () => {
    const overCap = makeForm({
      ...def,
      participants: {
        collect: true,
        roles: [
          { key: "speaker", label: "Speaker", enabled: true, min: 1, max: 6 },
          { key: "moderator", label: "Moderator", enabled: true, min: 0, max: 6 },
        ],
        maxTotal: 3,
        minTotal: null,
      },
    });
    const four = answers({
      participants: [
        { role: "speaker", answers: { first_name: "a" } },
        { role: "speaker", answers: { first_name: "b" } },
        { role: "moderator", answers: { first_name: "c" } },
        { role: "moderator", answers: { first_name: "d" } },
      ],
    });
    const three = answers({ participants: four.participants.slice(0, 3) });

    expect(validate(four, overCap).issues.map((i) => i.code)).toContain("participants_max_total");
    expect(validate(three, overCap).issues.map((i) => i.code)).not.toContain(
      "participants_max_total",
    );
  });

  it("rejects a role the form does not offer", () => {
    const result = validate(
      answers({ participants: [{ role: "moderator", answers: { first_name: "x" } }] }),
      def,
    );
    expect(result.issues.map((i) => i.code)).toContain("unknown_role");
  });

  it("validates participant fields per participant and reports the index", () => {
    const result = validate(
      answers({
        participants: [
          { role: "speaker", answers: { first_name: "Ada" } },
          { role: "speaker", answers: {} },
        ],
      }),
      def,
    );
    const missing = result.issues.find((i) => i.code === "required");
    expect(missing?.participantIndex).toBe(1);
    expect(missing?.fieldKey).toBe("first_name");
  });

  it("the shipped default asks for exactly one speaker", () => {
    const shipped = makeForm({ participants: emptyFormSchema().participants });
    expect(validate(answers(), shipped).issues.map((i) => i.code)).toContain("role_min");
    expect(validate(speakerOnly(1), shipped).ok).toBe(true);
    expect(validate(speakerOnly(9), shipped).ok).toBe(true); // no max by default
  });

  it("skips participant rules entirely when the form does not collect them", () => {
    const noParticipants = makeForm({
      ...def,
      participants: { ...def.participants, collect: false },
    });
    expect(validate(answers(), noParticipants).ok).toBe(true);
  });

  it("shows a participant field only for the participant whose answer fires", () => {
    const perPerson = makeForm({
      fields: [
        field({ key: "needs_visa", type: "boolean", scope: "participant" }),
        field({ key: "passport_name", scope: "participant", order: 1 }),
      ],
      rules: [
        {
          id: "visa",
          match: "all",
          when: [{ fieldKey: "needs_visa", op: "equals", value: true }],
          action: "show",
          targetKeys: ["passport_name"],
          scope: "participant",
        },
      ],
    });
    const mixed = answers({
      participants: [
        { role: "speaker", answers: { needs_visa: true } },
        { role: "speaker", answers: { needs_visa: false } },
      ],
    });
    expect(visibleParticipantFields(mixed, perPerson, 0).map((f) => f.key)).toContain(
      "passport_name",
    );
    expect(visibleParticipantFields(mixed, perPerson, 1).map((f) => f.key)).not.toContain(
      "passport_name",
    );
  });
});

/* ----------------------------------------------------- category routing */

describe("category routing — routes to TRACK ids (DECISIONS.md #25)", () => {
  // Real-shaped `tracks.id` values: routing assigns a track, not a made-up
  // category string. The outcome writes straight to `sessions.track_id`.
  const TRACK_WORKSHOPS = "000000tr-0000-4000-8000-000000000009";
  const TRACK_AGENTS = "000000tr-0000-4000-8000-000000000001";
  const TRACK_GENERAL = "000000tr-0000-4000-8000-000000000042";

  const rules: RoutingRule[] = [
    {
      id: "rt-ws",
      match: "all",
      when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
      trackId: TRACK_WORKSHOPS,
      reviewTeamKey: "workshops-committee",
      order: 0,
    },
    {
      id: "rt-agents",
      match: "all",
      when: [{ fieldKey: "topic", op: "equals", value: "Agents" }],
      trackId: TRACK_AGENTS,
      order: 1,
    },
  ];

  const def = makeForm({
    fields: [
      field({ key: "format", type: "select" }),
      field({ key: "topic", type: "select", order: 1 }),
    ],
    routing: { rules, defaultTrackId: TRACK_GENERAL },
  });

  it("routes to track A", () => {
    expect(routeCategory(answers({ fields: { format: "Workshop", topic: "Infra" } }), def)).toEqual(
      {
        trackId: TRACK_WORKSHOPS,
        reviewTeamKey: "workshops-committee",
        ruleId: "rt-ws",
      },
    );
  });

  it("routes to track B", () => {
    expect(routeCategory(answers({ fields: { format: "Talk", topic: "Agents" } }), def)).toEqual({
      trackId: TRACK_AGENTS,
      reviewTeamKey: null,
      ruleId: "rt-agents",
    });
  });

  it("falls back to the default track when nothing matches (must-not-fire)", () => {
    expect(routeCategory(answers({ fields: { format: "Talk", topic: "Infra" } }), def)).toEqual({
      trackId: TRACK_GENERAL,
      reviewTeamKey: null,
      ruleId: null,
    });
  });

  it("first rule by order wins when two match", () => {
    const both = answers({ fields: { format: "Workshop", topic: "Agents" } });
    expect(routeCategory(both, def).ruleId).toBe("rt-ws");

    const reordered = makeForm({
      ...def,
      routing: {
        rules: [
          { ...rules[0], order: 5 },
          { ...rules[1], order: 1 },
        ],
        defaultTrackId: TRACK_GENERAL,
      },
    });
    expect(routeCategory(both, reordered).ruleId).toBe("rt-agents");
    expect(routeCategory(both, reordered).trackId).toBe(TRACK_AGENTS);
  });

  it("skips a disabled rule", () => {
    const disabled = makeForm({
      ...def,
      routing: {
        rules: [{ ...rules[0], enabled: false }, rules[1]],
        defaultTrackId: TRACK_GENERAL,
      },
    });
    expect(routeCategory(answers({ fields: { format: "Workshop" } }), disabled).trackId).toBe(
      TRACK_GENERAL,
    );
  });

  it("returns a null track when there are no rules and no default", () => {
    const bare = makeForm({ routing: { rules: [], defaultTrackId: null } });
    expect(routeCategory(answers(), bare).trackId).toBeNull();
  });

  it("drops a persisted rule with no track id rather than keeping a no-op", () => {
    const parsed = parseFormSchema({
      routing: {
        rules: [
          { id: "good", match: "all", when: [], trackId: TRACK_AGENTS, order: 0 },
          { id: "bad", match: "all", when: [], order: 1 },
          { id: "empty", match: "all", when: [], trackId: "", order: 2 },
        ],
        defaultTrackId: TRACK_GENERAL,
      },
    });
    expect(parsed.routing.rules.map((r) => r.id)).toEqual(["good"]);
    expect(parsed.routing.defaultTrackId).toBe(TRACK_GENERAL);
  });
});

/* -------------------------------------------------- registry hydration */

describe("hydrateFieldRefs", () => {
  const registry = [
    {
      id: "fd-1",
      key: "title",
      label: "Session title",
      type: "text" as const,
      constraints: { required: true, maxLength: 120 },
      isLocked: true,
    },
    {
      id: "fd-2",
      key: "abstract",
      label: "Abstract",
      type: "wysiwyg" as const,
      constraints: { minLength: 200 },
      isLocked: false,
    },
  ];

  it("fills in label, type and validation for a bare {fieldId, key} ref", () => {
    // This is the shape `scripts/seed.mjs` writes. Before hydration the builder
    // rendered blank labels and blank type chips.
    const bare = parseFormSchema({
      fields: [
        { fieldId: "fd-1", key: "title" },
        { fieldId: "fd-2", key: "abstract" },
      ],
    }).fields;

    const hydrated = hydrateFieldRefs(bare, registry);
    expect(hydrated[0]).toMatchObject({
      key: "title",
      label: "Session title",
      type: "text",
      locked: true,
      required: true,
      validation: { maxLength: 120 },
    });
    expect(hydrated[1]).toMatchObject({
      label: "Abstract",
      type: "wysiwyg",
      validation: { minLength: 200 },
    });
  });

  it("keeps a per-form label override but never a stale type", () => {
    const refs: FormFieldRef[] = [
      field({ key: "title", fieldId: "fd-1", label: "Talk title", type: "number" }),
    ];
    const [hydrated] = hydrateFieldRefs(refs, registry);
    expect(hydrated.label).toBe("Talk title"); // override survives
    expect(hydrated.type).toBe("text"); // registry wins — type is immutable there
  });

  it("leaves a ref alone when its registry row is gone", () => {
    const refs: FormFieldRef[] = [
      field({ key: "orphan", fieldId: "fd-999", label: "Orphan", type: "email" }),
    ];
    expect(hydrateFieldRefs(refs, registry)[0]).toMatchObject({
      label: "Orphan",
      type: "email",
    });
  });

  it("makes a hydrated seed form actually validate", () => {
    // End-to-end of the bug: unhydrated, `maxLength` is absent and a 500-char
    // title passes. Hydrated, the registry's 120-char cap applies.
    const bare = parseFormSchema({ fields: [{ fieldId: "fd-1", key: "title" }] }).fields;
    const loose = makeForm({ fields: bare });
    const tight = makeForm({ fields: hydrateFieldRefs(bare, registry) });
    const long = answers({ fields: { title: "a".repeat(500) } });

    expect(validate(long, loose).ok).toBe(true);
    expect(validate(long, tight).ok).toBe(false);
  });
});

/* --------------------------------------------------------------- gates */

describe("close date + submission limits", () => {
  const closesAt = Date.UTC(2026, 8, 15, 23, 59, 0);
  const open = makeForm({ status: "open", closesAt });

  it("is open before the close date and closed after", () => {
    expect(isFormOpen(open, closesAt - 1)).toBe(true);
    expect(isFormOpen(open, closesAt + 1)).toBe(false);
  });

  it("a draft form is never open even with a future close date", () => {
    expect(isFormOpen(makeForm({ status: "draft", closesAt }), closesAt - 1)).toBe(false);
  });

  it("no close date means open forever", () => {
    expect(isFormOpen(makeForm({ status: "open", closesAt: null }), 9e15)).toBe(true);
  });

  it("validate flags a closed form only when `now` is supplied", () => {
    expect(validate(answers(), open, { now: closesAt + 1 }).issues.map((i) => i.code)).toContain(
      "form_closed",
    );
    expect(validate(answers(), open, { now: closesAt - 1 }).ok).toBe(true);
    expect(validate(answers(), open).ok).toBe(true);
  });

  it("a draft save is still allowed after close", () => {
    expect(validate(answers(), open, { now: closesAt + 1, draft: true }).ok).toBe(true);
  });

  it("cascades the submission limit form-override → event default → unlimited", () => {
    expect(effectiveSubmissionLimit({ submissionLimit: 2 }, 3)).toBe(2);
    expect(effectiveSubmissionLimit({ submissionLimit: null }, 3)).toBe(3);
    expect(effectiveSubmissionLimit({ submissionLimit: null }, null)).toBeNull();
  });
});

/* ------------------------------------------------------ persistence */

describe("parse / toFormDefinition", () => {
  it("survives a null schema blob", () => {
    const parsed = parseFormSchema(null);
    expect(parsed.fields).toEqual([]);
    expect(parsed.participants.roles.find((r) => r.key === "speaker")?.min).toBe(1);
  });

  it("defaults the speaker minimum to 1 (DECISIONS.md #7)", () => {
    expect(emptyFormSchema().participants.roles[0]).toMatchObject({ key: "speaker", min: 1 });
  });

  it("keeps unknown-but-valid data and normalises scope/order", () => {
    const parsed = parseFormSchema({
      fields: [{ fieldId: "a", key: "title", type: "text", label: "Title" }],
      routing: { rules: [], defaultTrackId: "trk-1" },
    });
    expect(parsed.fields[0]).toMatchObject({ key: "title", scope: "submission", order: 0 });
    expect(parsed.routing.defaultTrackId).toBe("trk-1");
  });

  it("parses settings with partial notification config", () => {
    const parsed = parseFormSettings({ notifications: { notifyOnNew: ["a@b.co"] } });
    expect(parsed.notifications.notifyOnNew).toEqual(["a@b.co"]);
    expect(parsed.notifications.confirmationEmail.enabled).toBe(true);
  });

  it("splices a DB row into an evaluator input", () => {
    const def = toFormDefinition({
      id: "f1",
      name: "CFP",
      target: "submission",
      status: "open",
      schema: { fields: [{ fieldId: "a", key: "title", type: "text", label: "Title" }] },
      settings: { successMessage: "Thanks!" },
      closesAt: new Date(1_800_000_000_000),
      submissionLimit: 3,
      allowMultipleDrafts: false,
    });
    expect(def.closesAt).toBe(1_800_000_000_000);
    expect(def.fields).toHaveLength(1);
    expect(def.settings.successMessage).toBe("Thanks!");
  });

  it("field types stay in step with the registry enum", () => {
    // Drift guard: FormFieldRef["type"] IS the schema's FieldType, so every
    // registry type must be assignable here. A new type in schema.ts that this
    // file cannot express would fail the typecheck on this line.
    const refs: FormFieldRef[] = FIELD_TYPES.map((type) =>
      field({ key: `k_${type}`, type }),
    );
    expect(refs).toHaveLength(FIELD_TYPES.length);
  });
});

/* ---------------------------------- end-to-end: the done-when scenario */

describe("done-when: one conditional rule + two track routes on a real form", () => {
  const TRACK_WORKSHOPS = "000000tr-0000-4000-8000-000000000009";
  const TRACK_TALKS = "000000tr-0000-4000-8000-000000000003";
  const TRACK_UNSORTED = "000000tr-0000-4000-8000-000000000000";

  const def = makeForm({
    name: "AIE CFP 2026",
    fields: [
      field({ key: "title", label: "Title", required: true, validation: { maxLength: 80 } }),
      field({
        key: "format",
        label: "Format",
        type: "select",
        order: 1,
        required: true,
        validation: { options: ["Talk", "Workshop"] },
      }),
      field({ key: "workshop_prereqs", label: "Prerequisites", order: 2 }),
      field({ key: "teaser", label: "Program teaser", order: 3 }),
      field({
        key: "first_name",
        label: "First name",
        scope: "participant",
        required: true,
      }),
    ],
    rules: [
      {
        id: "show-prereqs",
        label: "Workshops explain their prerequisites",
        match: "all",
        when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
        action: "show",
        targetKeys: ["workshop_prereqs"],
      },
      {
        id: "require-prereqs",
        match: "all",
        when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
        action: "require",
        targetKeys: ["workshop_prereqs"],
      },
    ],
    combinedLimits: [
      {
        id: "program-block",
        label: "Printed program block",
        fieldKeys: ["title", "teaser"],
        maxChars: 60,
        scope: "submission",
      },
    ],
    routing: {
      rules: [
        {
          id: "to-workshops",
          match: "all",
          when: [{ fieldKey: "format", op: "equals", value: "Workshop" }],
          trackId: TRACK_WORKSHOPS,
          order: 0,
        },
        {
          id: "to-talks",
          match: "all",
          when: [{ fieldKey: "format", op: "equals", value: "Talk" }],
          trackId: TRACK_TALKS,
          order: 1,
        },
      ],
      defaultTrackId: TRACK_UNSORTED,
    },
    participants: {
      collect: true,
      roles: [{ key: "speaker", label: "Speaker", enabled: true, min: 1, max: 2 }],
      maxTotal: 2,
      minTotal: null,
    },
  });

  const talk = answers({
    fields: { title: "Shipping agents", format: "Talk", teaser: "A short teaser" },
    participants: [{ role: "speaker", answers: { first_name: "Ada" } }],
  });

  const workshop = answers({
    fields: {
      title: "Build an eval harness",
      format: "Workshop",
      workshop_prereqs: "A laptop and Python 3.12",
      teaser: "Hands on",
    },
    participants: [{ role: "speaker", answers: { first_name: "Ada" } }],
  });

  it("a Talk hides the workshop field, validates, and routes to Talks", () => {
    expect(visibleFields(talk, def).map((f) => f.key)).toEqual(["title", "format", "teaser"]);
    expect(validate(talk, def, { now: Date.now() }).ok).toBe(true);
    expect(routeCategory(talk, def).trackId).toBe(TRACK_TALKS);
  });

  it("a Workshop shows the extra field, validates, and routes to Workshops", () => {
    expect(visibleFields(workshop, def).map((f) => f.key)).toEqual([
      "title",
      "format",
      "workshop_prereqs",
      "teaser",
    ]);
    expect(validate(workshop, def, { now: Date.now() }).ok).toBe(true);
    expect(routeCategory(workshop, def).trackId).toBe(TRACK_WORKSHOPS);
  });

  it("a Workshop missing its now-required field is blocked", () => {
    const incomplete = answers({
      ...workshop,
      fields: { ...workshop.fields, workshop_prereqs: "" },
    });
    const result = validate(incomplete, def);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => `${i.code}:${i.fieldKey}`)).toContain(
      "required:workshop_prereqs",
    );
  });

  it("an unrecognised format falls through to the default track", () => {
    const odd = answers({ ...talk, fields: { ...talk.fields, format: "Panel" } });
    expect(routeCategory(odd, def).trackId).toBe(TRACK_UNSORTED);
    // …and the option list rejects it, so it can never reach the DB.
    expect(validate(odd, def).issues.map((i) => i.code)).toContain("option");
  });

  it("the combined limit blocks a long title+teaser and unblocks when trimmed", () => {
    const long = answers({
      ...talk,
      fields: { ...talk.fields, title: "a".repeat(40), teaser: "b".repeat(30) },
    });
    expect(validate(long, def).ok).toBe(false);

    const trimmed = answers({
      ...talk,
      fields: { ...talk.fields, title: "a".repeat(40), teaser: "b".repeat(20) },
    });
    expect(validate(trimmed, def).ok).toBe(true);
  });
});
