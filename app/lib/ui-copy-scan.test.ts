/**
 * The de-scaffolding gate.
 *
 * Two halves, and the second is worthless without the first:
 *
 *  1. MUST FIRE / MUST NOT FIRE on fixtures. Every banned token gets a fixture
 *     that puts it where a user would see it (JSX text, a string prop, a
 *     template literal) and a companion fixture that puts the same token where
 *     a user never sees it (a comment, an import path). A scanner that cannot
 *     go red proves nothing when it is green.
 *
 *  2. THE REAL TREE. Every shipped module under app/routes, app/components and
 *     app/lib is scanned. This is what stops "WS6 — REAL-TIME DASHBOARD" from
 *     coming back in a later edit.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BANNED_TOKENS, extractUserCopy, scanUiCopy } from "./ui-copy-scan";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCAN_DIRS = ["app/routes", "app/components", "app/lib"];
const EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Files this gate cannot scan, and why. Each entry is checked below to still be
 * NEEDED — when the owning lane cleans its copy up, the assertion goes red and
 * the exemption has to be deleted. An exemption that outlives its reason is how
 * a guard rots into decoration.
 */
const EXEMPT: { path: string; reason: string }[] = [
  {
    path: "app/lib/ui-copy-scan.ts",
    reason: "the scanner names the banned tokens in order to ban them",
  },
  {
    path: "app/lib/api/sessions.server.ts",
    reason:
      "snake_case field names ARE the public /v1 wire contract — an API error must name the field the client sent (`starts_at`), and that contract is Sessionboard-compatible on purpose",
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(extname(entry))) yield full;
  }
}

/** Repo-relative, forward-slashed paths of every module this gate covers. */
function shippedModules(): string[] {
  const exempt = new Set(EXEMPT.map((entry) => entry.path));
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const absolute of walk(resolve(ROOT, dir))) {
      const rel = relative(ROOT, absolute).split("\\").join("/");
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      if (exempt.has(rel)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

/* ------------------------------------------------- 1. the scanner can fail */

/** Copy a user would read, one fixture per banned token. */
const MUST_FIRE: Record<string, string> = {
  workstream: 'export const A = () => <p>WS6 — real-time dashboard lands here.</p>;',
  "plan-doc": 'export const A = () => <p>See PLAN.md §1 for the rationale.</p>;',
  "decisions-doc": 'export const A = () => <p>Marked NOT NEEDED (DECISIONS.md #6).</p>;',
  "reviewer-name": 'export const A = () => <p>swyx red-marked this one.</p>;',
  wrangler: 'export const A = () => <p>Cron does not fire in wrangler dev.</p>;',
  "dnd-kit": 'export const A = () => <p>Drag and drop uses dnd-kit.</p>;',
  "client-only": 'export const A = () => <p>Wrapped in a ClientOnly boundary.</p>;',
  "column-name": 'export const A = () => <p>Sessions with starts_at set.</p>;',
  "npm-script": 'export const A = () => <p>Run npm run seed to create the demo event.</p>;',
};

/** The same token, in a place no user can reach. */
const MUST_NOT_FIRE: Record<string, string> = {
  workstream: "/** WS6 owns this screen. */\nexport const A = () => <p>Dashboard</p>;",
  "plan-doc": "// PLAN.md §1 explains why.\nexport const A = () => <p>Dashboard</p>;",
  "decisions-doc": "/* DECISIONS.md #6 */\nexport const A = () => <p>Payments are out of scope.</p>;",
  "reviewer-name": "// swyx red-marked this.\nexport const A = () => <p>Confirmation email</p>;",
  wrangler: "// Cron never fires in wrangler dev.\nexport const A = () => <p>Run a job now</p>;",
  "dnd-kit": "// Reordering avoids dnd-kit on purpose.\nexport const A = () => <p>Move up</p>;",
  "client-only": 'import { ClientOnly } from "~/components/ClientOnly";\nexport const A = () => <ClientOnly>x</ClientOnly>;',
  "column-name": "// Ordered by starts_at.\nexport const A = () => <p>Schedule</p>;",
  "npm-script": "// Run npm run seed first.\nexport const A = () => <p>No event yet</p>;",
};

describe("the scanner itself", () => {
  it("has a must-fire and a must-not-fire fixture for every banned token", () => {
    const ids = BANNED_TOKENS.map((token) => token.id).sort();
    expect(Object.keys(MUST_FIRE).sort()).toEqual(ids);
    expect(Object.keys(MUST_NOT_FIRE).sort()).toEqual(ids);
  });

  for (const token of BANNED_TOKENS) {
    it(`fires on ${token.id} in user-visible copy`, () => {
      const hits = scanUiCopy(MUST_FIRE[token.id], "fixture.tsx");
      expect(hits.map((hit) => hit.token)).toContain(token.id);
    });

    it(`does NOT fire on ${token.id} in a comment or an import path`, () => {
      const hits = scanUiCopy(MUST_NOT_FIRE[token.id], "fixture.tsx");
      expect(hits).toEqual([]);
    });
  }

  it("reads copy out of string props and template literals, not just JSX text", () => {
    const fromProp = scanUiCopy(
      'export const A = () => <Stub lane="WS4 — agenda builder" />;',
      "fixture.tsx",
    );
    expect(fromProp.map((hit) => hit.token)).toContain("workstream");

    const fromTemplate = scanUiCopy(
      "export const A = (n: string) => `${n} — see PLAN.md`;",
      "fixture.ts",
    );
    expect(fromTemplate.map((hit) => hit.token)).toContain("plan-doc");
  });

  it("drops comments entirely rather than blanking them line by line", () => {
    const copy = extractUserCopy(
      '/* WS9 */ export const A = () => <p>Hello</p>;',
      "fixture.tsx",
    );
    expect(copy.map((node) => node.text.trim())).toEqual(["Hello"]);
  });

  it("reports the line the offending words start on, not the line of the tag", () => {
    const hits = scanUiCopy(
      "export const A = () => (\n  <p>\n    Run npm run seed.\n  </p>\n);",
      "fixture.tsx",
    );
    expect(hits[0]?.line).toBe(3);
  });
});

/* ------------------------------------------------------- 2. the real tree */

describe("shipped UI copy", () => {
  it("covers a non-trivial number of modules", () => {
    // A walk that silently found nothing would make the next assertion vacuous.
    expect(shippedModules().length).toBeGreaterThan(40);
  });

  it("names no workstream, planning doc, tool or column anywhere a user can read", () => {
    const offences: string[] = [];
    for (const rel of shippedModules()) {
      const source = readFileSync(resolve(ROOT, rel), "utf8");
      for (const hit of scanUiCopy(source, rel)) {
        offences.push(`${rel}:${hit.line}  [${hit.token}: ${hit.why}]  ${hit.text.trim()}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps every exemption honest — a clean file must lose its exemption", () => {
    for (const entry of EXEMPT) {
      const source = readFileSync(resolve(ROOT, entry.path), "utf8");
      const hits = scanUiCopy(source, entry.path);
      expect(
        hits.length,
        `${entry.path} no longer needs its exemption (${entry.reason}) — delete the EXEMPT entry.`,
      ).toBeGreaterThan(0);
    }
  });
});
