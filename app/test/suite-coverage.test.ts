/**
 * The suite must not silently drop a test file.
 *
 * `vitest.config.ts` selects files by glob. A glob that names one directory
 * root will happily ignore a test file added anywhere else — no error, no
 * warning, just a smaller number in the "N test files" line that the release
 * evidence quotes. That is exactly what happened to
 * `scripts/demo-lifecycle.test.mjs` and `scripts/run-e2e.test.mjs`: both were
 * written for vitest, both passed when run directly, and neither had ever been
 * executed by `npm run check`, `npm run release:verify`, CI, or the exact-SHA
 * repeat gate.
 *
 * So this test walks the repository for test files and asserts every one is
 * matched by an include pattern. It fails on the file the config forgot, which
 * is the only moment anybody would find out.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Directories that cannot contain vitest files, or are not ours to police. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  ".wrangler",
  ".react-router",
  "test-results",
  "playwright-report",
  "artifacts",
]);

/** Extensions a vitest file can have. `.spec.ts` is Playwright's, not ours. */
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEST_FILE.test(entry)) yield full;
  }
}

/**
 * Compile the small glob dialect the config actually uses — `**` across
 * directories, `*` within a segment, `{a,b}` alternation. Deliberately not a
 * general glob engine: a wrong matcher here would make this guard lie in the
 * permissive direction, so it only claims to handle the forms in use.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` crosses directories and may match nothing at all.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const options = pattern.slice(i + 1, end).split(",");
        out += `(?:${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = end;
        continue;
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const includePatterns = (config.test?.include ?? []) as string[];
const matchers = includePatterns.map(globToRegExp);

function isIncluded(relativePath: string): boolean {
  return matchers.some((matcher) => matcher.test(relativePath));
}

describe("globToRegExp", () => {
  it("matches nested paths through **", () => {
    expect(globToRegExp("app/**/*.test.ts").test("app/lib/auth/tokens.test.ts")).toBe(true);
  });

  /* `**\/` must also match zero directories — `app/x.test.ts` is included. */
  it("matches a file directly under the ** root", () => {
    expect(globToRegExp("app/**/*.test.ts").test("app/x.test.ts")).toBe(true);
  });

  it("does not match across a directory boundary with a single *", () => {
    expect(globToRegExp("app/*.test.ts").test("app/lib/x.test.ts")).toBe(false);
  });

  /*
   * The must-not-fire control for the matcher itself. If this returned true,
   * the guard below would pass for every path and prove nothing.
   */
  it("rejects a path outside the pattern's root", () => {
    expect(globToRegExp("app/**/*.test.ts").test("scripts/x.test.mjs")).toBe(false);
    expect(globToRegExp("app/**/*.test.ts").test("app/lib/x.test.mjs")).toBe(false);
  });
});

describe("vitest include patterns", () => {
  const discovered = [...walk(repoRoot)]
    .map((file) => relative(repoRoot, file).split("\\").join("/"))
    .sort();

  it("finds the test files on disk (control — an empty walk must not pass silently)", () => {
    expect(discovered.length).toBeGreaterThan(50);
    expect(discovered).toContain("app/lib/auth/tokens.test.ts");
  });

  /*
   * The regression this file exists for. `scripts/` holds the tests for the
   * guarded destructive demo reset and for `assertDisposableStatePath`, the
   * check that stands between a recursive force-delete and a directory that is
   * not a disposable E2E state root.
   */
  it("covers the scripts/ tests that were previously never executed", () => {
    expect(discovered).toContain("scripts/demo-lifecycle.test.mjs");
    expect(discovered).toContain("scripts/run-e2e.test.mjs");
    expect(isIncluded("scripts/demo-lifecycle.test.mjs")).toBe(true);
    expect(isIncluded("scripts/run-e2e.test.mjs")).toBe(true);
  });

  it("runs every test file in the repository", () => {
    const orphans = discovered.filter((file) => !isIncluded(file));
    expect(
      orphans,
      `These test files exist but no vitest include pattern matches them, so they never run:\n` +
        `${orphans.join("\n")}\n` +
        `Add them to test.include in vitest.config.ts (or delete them).`,
    ).toEqual([]);
  });
});
