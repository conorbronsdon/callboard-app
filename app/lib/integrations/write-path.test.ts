/**
 * DECISIONS.md #2, as a check that can fail: the Airtable mirror never sits on
 * a user write path.
 *
 * Airtable caps at 5 requests/second. If any submit, review, portal or agenda
 * handler ever imported the mirror, a speaker's form POST would inherit that
 * ceiling — and it would happen quietly, as a "why is this slow" bug weeks
 * later. So this is a STATIC scan of every module under app/, with an explicit
 * allowlist and a negative control proving the scanner sees real imports.
 *
 * The allowlist is deliberately tiny: the cron job registry, and the admin
 * Integrations page whose whole purpose is a manual "run it now" button.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Modules allowed to reach the mirror. Both are off the request hot path. */
const ALLOWED = [
  "lib/jobs/registry.server.ts",
  "routes/admin.integrations.tsx",
  // The mirror's own module and its tests.
  "lib/integrations/airtable.server.ts",
  "lib/integrations/airtable.test.ts",
  "lib/integrations/write-path.test.ts",
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

const IMPORT_PATTERN = /from\s+["'][^"']*integrations\/airtable\.server["']/;

function importers(): string[] {
  const found: string[] = [];
  for (const file of walk(APP_DIR)) {
    if (IMPORT_PATTERN.test(readFileSync(file, "utf8"))) {
      found.push(relative(APP_DIR, file).replace(/\\/g, "/"));
    }
  }
  return found.sort();
}

describe("the Airtable mirror stays off the write path", () => {
  const found = importers();

  it("NEGATIVE CONTROL: the scanner really does find imports", () => {
    // If this list were empty the assertion below would pass vacuously.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("lib/jobs/registry.server.ts");
  });

  it("only the job registry and the Integrations page import it", () => {
    const unexpected = found.filter((file) => !ALLOWED.includes(file));
    expect(unexpected).toEqual([]);
  });

  it("no public, submit, portal or review module touches it", () => {
    const hot = found.filter((file) =>
      /^routes\/(public|portal|auth|api)\.|^lib\/(public-submit|review|portal)\//.test(file),
    );
    expect(hot).toEqual([]);
  });

  it("MUST NOT FIRE: the pattern does not match the Accelevents module", () => {
    expect(IMPORT_PATTERN.test('from "./accelevents.server"')).toBe(false);
    expect(IMPORT_PATTERN.test('from "~/lib/integrations/airtable.server"')).toBe(true);
  });
});
