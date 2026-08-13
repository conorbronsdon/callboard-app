/**
 * The cron ↔ registry join, which nothing else in the suite exercises.
 *
 * Cron triggers do not fire under `wrangler dev` (see registry.server.ts's
 * header comment and workers/app.ts's `scheduled` handler), so job BODIES are
 * tested and reachable only through POST /admin/jobs/run (unit tests +
 * tests/e2e/ws7-api.spec.ts). The GLUE that actually connects a fired cron
 * expression to a job — `jobsForCron()` matching `controller.cron` against
 * each JobDefinition's `cron` field, which itself must equal one of the
 * strings in wrangler.jsonc's `triggers.crons` — has no test at all. A typo in
 * either place would deploy cleanly, `npm run check`/`release:verify` would
 * stay green, manual job runs via /admin/jobs/run would stay green, and the
 * job would simply never fire in production — workers/app.ts's `scheduled`
 * handler only warns to the console when a cron matches nothing
 * (`jobsForCron(controller.cron).length === 0`), which nothing reads in CI.
 *
 * This test reads the real, checked-in wrangler.jsonc (not a fixture copy) so
 * it catches an actual drift, not a drift between two things I hand-wrote to
 * agree.
 *
 * `scripts/demo-lifecycle-lib.mjs` already has a `parseJsoncConfig` that does
 * this more thoroughly, but it lives outside tsconfig.test.json's composite
 * project boundary (only `app/` and this file's two `workers/` exceptions are
 * listed there) — importing it would pull its whole file, and everything
 * IT imports, into strict type-checking, which is out of scope for this test.
 * wrangler.jsonc's comments are a mix of line comments and one JSDoc-style
 * header block, with no trailing commas (confirmed by reading it), so a
 * minimal stripper is enough here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JOBS, jobsForCron } from "./registry.server";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Strips line and block comments outside of string literals. Not a general JSONC parser. */
function stripComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1; // land on the closing "/"; the loop's own i += 1 clears it
    } else {
      out += ch;
    }
  }
  return out;
}

function realCronTriggers(): string[] {
  const source = readFileSync(resolve(repoRoot, "wrangler.jsonc"), "utf8");
  const parsed = JSON.parse(stripComments(source)) as {
    triggers?: { crons?: unknown };
  };
  const crons = parsed.triggers?.crons;
  if (!Array.isArray(crons) || crons.some((value) => typeof value !== "string")) {
    throw new Error("wrangler.jsonc triggers.crons must be an array of strings.");
  }
  return crons as string[];
}

describe("wrangler.jsonc triggers.crons <-> registry.server.ts join", () => {
  it("MUST FIRE: every cron declared in wrangler.jsonc matches at least one registered job", () => {
    for (const cron of realCronTriggers()) {
      expect(jobsForCron(cron), `no job in registry.server.ts answers cron "${cron}"`).not.toHaveLength(0);
    }
  });

  it("MUST FIRE: every job's own cron field is declared in wrangler.jsonc — a job cron that drifts from the deploy config would silently never fire", () => {
    const declared = new Set(realCronTriggers());
    for (const job of Object.values(JOBS)) {
      if (!job.cron) continue; // on-demand jobs (e.g. airtable-schema) intentionally have none
      expect(
        declared.has(job.cron),
        `job "${job.name}" declares cron "${job.cron}", which is not in wrangler.jsonc's triggers.crons`,
      ).toBe(true);
    }
  });

  it("pins today's known-correct mapping so a silent rename shows up as a diff, not just a passing generic assertion", () => {
    const declared = realCronTriggers();
    const mapped = declared.map((cron) => ({
      cron,
      jobs: jobsForCron(cron).map((job) => job.name),
    }));
    expect(mapped).toEqual([
      { cron: "0 15 * * *", jobs: ["task-reminders"] },
      { cron: "*/30 * * * *", jobs: ["airtable-mirror"] },
    ]);
  });
});

describe("jobsForCron()", () => {
  it("MUST-NOT-FIRE: an unmatched cron expression returns an empty list, not a throw or a wrong job", () => {
    expect(jobsForCron("*/5 * * * *")).toEqual([]);
  });

  it("MUST-NOT-FIRE: matching is an exact string compare, not a prefix/substring match", () => {
    // "0 15 * * *" is a real registered cron; "0 15 * * * *" (six fields) and
    // "0 15 * *" (three) must NOT fuzzily match it.
    expect(jobsForCron("0 15 * * * *")).toEqual([]);
    expect(jobsForCron("0 15 * *")).toEqual([]);
  });

  it("returns every currently-registered job whose cron field is set, once each, keyed by its own name", () => {
    // Cross-checks jobsForCron against JOBS directly rather than re-deriving
    // the expected set by hand, so this stays correct if a job is renamed.
    const withCron = Object.values(JOBS).filter((job): job is typeof job & { cron: string } =>
      Boolean(job.cron),
    );
    for (const job of withCron) {
      const matches = jobsForCron(job.cron);
      expect(matches.map((m) => m.name)).toContain(job.name);
    }
  });
});
