/**
 * Round-trip test: does the ADMIN BUILDER produce a definition the EVALUATOR
 * actually understands?
 *
 * The unit tests in form-schema.test.ts prove the evaluator against fixtures I
 * wrote by hand — which proves nothing about the builder, because I wrote both
 * sides. This fixture is different: it is the verbatim `forms.schema` JSON that
 * `/admin/forms/:id/:step` wrote to D1 when a form was built entirely over
 * HTTP. If the builder ever starts emitting a shape the evaluator ignores —
 * a renamed key, a dropped track id, a rule the parser silently discards —
 * these assertions go red.
 *
 * Regenerate after changing the builder's persisted shape:
 *
 *   npm run dev -- --port 5199
 *   curl -c cj -X POST -d role=admin localhost:5199/demo
 *   # …build a form through /admin/forms…
 *   npx wrangler d1 execute callboard-db --local --json \
 *     --command "SELECT schema FROM forms WHERE id='<id>'"
 *
 * The form it captures: fields title/abstract/format/workshop_prereqs, one
 * conditional rule (format = Workshop → show workshop_prereqs), two routing
 * rules onto real track ids plus a default track, and one cross-field combined
 * character limit of 60 across title + workshop_prereqs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type FormAnswers,
  type FormDefinition,
  combinedCounters,
  emptyFormSettings,
  isFormOpen,
  parseFormSchema,
  routeCategory,
  validate,
  visibleFields,
} from "./form-schema";

/** Track ids from `scripts/seed.mjs` — the same rows the builder picked from. */
const TRACK_AGENTS = "000000tr-0000-4000-8000-000000000001";
const TRACK_EVALS = "000000tr-0000-4000-8000-000000000002";
const TRACK_INFRA = "000000tr-0000-4000-8000-000000000003";

/** `2026-09-15T23:59` America/Los_Angeles, as the builder stored it. */
const CLOSES_AT = Date.UTC(2026, 8, 16, 6, 59, 0);

const raw = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/builder-output.schema.json", import.meta.url)),
    "utf8",
  ),
);

const def: FormDefinition = {
  ...parseFormSchema(raw),
  id: "e2e",
  name: "E2E Routing Form",
  target: "submission",
  status: "open",
  closesAt: CLOSES_AT,
  submissionLimit: 2,
  allowMultipleDrafts: true,
  settings: emptyFormSettings(),
};

const answers = (fields: FormAnswers["fields"]): FormAnswers => ({
  fields,
  participants: [{ role: "speaker", answers: {} }],
});

describe("builder output survives the round-trip into the evaluator", () => {
  it("parses into the fields the admin added, with registry types intact", () => {
    expect(def.fields.map((f) => `${f.key}:${f.type}`)).toEqual([
      "title:text",
      "abstract:wysiwyg",
      "format:select",
      "workshop_prereqs:textarea",
    ]);
    // Hydration wrote real labels, not the bare keys the seed shape carried.
    expect(def.fields[0].label).toBe("Session title");
  });

  it("kept exactly the rules that were added", () => {
    expect(def.rules).toHaveLength(1);
    expect(def.combinedLimits).toHaveLength(1);
    expect(def.routing.rules).toHaveLength(2);
    expect(def.routing.defaultTrackId).toBe(TRACK_EVALS);
  });

  it("defaults the speaker role to a minimum of 1 (DECISIONS.md #7)", () => {
    const speaker = def.participants.roles.find((role) => role.key === "speaker");
    expect(speaker).toMatchObject({ enabled: true, min: 1 });
  });

  /* ------------------------------------------- conditional logic */

  it("hides the workshop field for a Talk and shows it for a Workshop", () => {
    expect(visibleFields(answers({ format: "Talk" }), def).map((f) => f.key)).toEqual([
      "title",
      "abstract",
      "format",
    ]);
    expect(visibleFields(answers({ format: "Workshop" }), def).map((f) => f.key)).toEqual([
      "title",
      "abstract",
      "format",
      "workshop_prereqs",
    ]);
  });

  /* --------------------------------------------- track routing */

  it("routes a Workshop onto the Infrastructure track", () => {
    expect(routeCategory(answers({ format: "Workshop" }), def)).toMatchObject({
      trackId: TRACK_INFRA,
    });
  });

  it("routes a Talk onto the Agents track", () => {
    expect(routeCategory(answers({ format: "Talk" }), def)).toMatchObject({
      trackId: TRACK_AGENTS,
    });
  });

  it("falls back to the default track for anything else (must-not-fire)", () => {
    expect(routeCategory(answers({ format: "Panel" }), def)).toMatchObject({
      trackId: TRACK_EVALS,
      ruleId: null,
    });
  });

  it("returns ids that can be written straight to sessions.track_id", () => {
    // Guards the DECISIONS.md #25 contract: routing yields a real `tracks.id`,
    // never an invented category string WS2 would have to translate. Asserted
    // against the actual seeded rows rather than an id-shaped regex — the seed
    // ids are not hex, and a shape check would pass on any string anyway.
    const seededTrackIds = [TRACK_AGENTS, TRACK_EVALS, TRACK_INFRA];
    for (const format of ["Workshop", "Talk", "Panel"]) {
      expect(seededTrackIds).toContain(routeCategory(answers({ format }), def).trackId);
    }
    // …and every rule in the persisted definition points at one of them.
    for (const rule of def.routing.rules) expect(seededTrackIds).toContain(rule.trackId);
  });

  /* ------------------------------------ cross-field combined limit */

  it("BLOCKS when title + prerequisites exceed the 60-char combined cap", () => {
    const over = answers({
      title: "a".repeat(40),
      abstract: "<p>" + "x".repeat(250) + "</p>",
      format: "Workshop",
      workshop_prereqs: "b".repeat(25),
    });
    const result = validate(over, def, { now: CLOSES_AT - 1 });
    expect(result.ok).toBe(false);

    const issue = result.issues.find((i) => i.code === "combined_limit");
    expect(issue).toMatchObject({ limit: 60, actual: 65 });
  });

  it("UNBLOCKS when the prerequisites are trimmed", () => {
    const under = answers({
      title: "a".repeat(40),
      abstract: "<p>" + "x".repeat(250) + "</p>",
      format: "Workshop",
      workshop_prereqs: "b".repeat(20),
    });
    const result = validate(under, def, { now: CLOSES_AT - 1 });
    expect(result.issues.filter((i) => i.code === "combined_limit")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("stops counting the workshop field once the rule hides it", () => {
    // Same 65 characters, but as a Talk the prerequisites field is not shown —
    // an answer nobody can see must not block the submission.
    const asTalk = answers({
      title: "a".repeat(40),
      abstract: "<p>" + "x".repeat(250) + "</p>",
      format: "Talk",
      workshop_prereqs: "b".repeat(25),
    });
    const [counter] = combinedCounters(asTalk, def);
    expect(counter.countedKeys).toEqual(["title"]);
    expect(counter.used).toBe(40);
    expect(validate(asTalk, def, { now: CLOSES_AT - 1 }).ok).toBe(true);
  });

  it("exposes the live combined counter the public form renders", () => {
    const [counter] = combinedCounters(
      answers({ title: "Ship it", format: "Workshop", workshop_prereqs: "A laptop" }),
      def,
    );
    expect(counter).toMatchObject({
      label: "Printed programme block",
      used: 15,
      max: 60,
      remaining: 45,
      over: false,
    });
  });

  /* ------------------------------------------------ close date */

  it("stored the close date in the EVENT timezone, not UTC", () => {
    // 23:59 in America/Los_Angeles on Sep 15 is 06:59Z on Sep 16. Storing the
    // naive string would have closed the form seven hours early.
    expect(new Date(def.closesAt!).toISOString()).toBe("2026-09-16T06:59:00.000Z");
    expect(isFormOpen(def, CLOSES_AT - 1)).toBe(true);
    expect(isFormOpen(def, CLOSES_AT + 1)).toBe(false);
  });

  it("refuses a submission after the close date but still accepts a draft", () => {
    const late = answers({ title: "Late", abstract: "<p>x</p>", format: "Talk" });
    expect(validate(late, def, { now: CLOSES_AT + 1 }).issues.map((i) => i.code)).toContain(
      "form_closed",
    );
    expect(validate(late, def, { now: CLOSES_AT + 1, draft: true }).ok).toBe(true);
  });
});
