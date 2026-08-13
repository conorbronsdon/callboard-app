#!/usr/bin/env node
/**
 * docs link-check — every relative markdown link resolves.
 *
 * Scans every *.md file (excluding node_modules), extracts `[text](target)`
 * links whose target is a filesystem-relative path (not http(s):, mailto:,
 * a site-absolute in-app route like `/admin/embeds`, or another URI scheme),
 * and verifies:
 *   1. the referenced file exists on disk AND is tracked by git;
 *   2. if the link carries a `#fragment`, that fragment matches a heading
 *      in the target file (or the current file, for a same-file `#frag`
 *      link), using GitHub's heading-slug rules.
 *
 * Site-absolute paths (leading `/`) are deliberately out of scope: they name
 * live application routes, not files, and resolving one against the linking
 * file's directory would walk toward the filesystem root rather than test
 * anything real. Verifying those against `app/routes.ts` is a separate,
 * manual step — this script only proves markdown-to-markdown links resolve.
 *
 * Like scripts/guards.mjs and scripts/check-action-pins.mjs, this proves
 * itself before it is trusted: known-positive and known-negative fixtures
 * run through the exact same extraction/resolution code as the real scan.
 * A checker that cannot fail is not a checker.
 *
 * Usage: node scripts/check-links.mjs
 * Exit 0 = every relative link resolves. Exit 1 = at least one does not,
 * OR the self-test failed (in which case the scan below did not run).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "build", "dist", ".react-router"]);

/* ------------------------------------------------------------- helpers */

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** GitHub-flavoured heading slug: lowercase, strip non-word/space/hyphen,
 * spaces -> hyphens, collapse. Good enough for our own docs' headings —
 * we don't use emoji or duplicate headings that would need a `-1` suffix. */
function slugify(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingsOf(mdSource) {
  const slugs = new Set();
  for (const line of mdSource.split("\n")) {
    const m = HEADING_RE.exec(line);
    HEADING_RE.lastIndex = 0;
    if (m) slugs.add(slugify(m[2]));
  }
  return slugs;
}

function isRelative(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // http:, https:, mailto:, etc.
  if (target.startsWith("#")) return "same-file";
  // A leading "/" is a site-absolute in-app ROUTE (e.g. "/admin/embeds"),
  // not a filesystem path relative to the linking file. Those aren't
  // markdown files at all and resolving them against `dirname(sourceFile)`
  // would walk to the filesystem root — out of scope for this checker,
  // which only follows links between tracked markdown/anchor targets.
  if (target.startsWith("/")) return false;
  return true;
}

/**
 * Resolve one link found in `sourceFile`. Returns null when it's fine, or a
 * string describing the problem.
 */
function checkOneLink(sourceFile, sourceText, target, trackedFiles) {
  const kind = isRelative(target);
  if (kind === false) return null; // external — out of scope
  if (kind === "same-file") {
    const frag = target.slice(1);
    if (!frag) return null; // bare "#" — some renderers use it as a no-op top link
    return headingsOf(sourceText).has(slugify(decodeURIComponent(frag)))
      ? null
      : `same-file anchor #${frag} has no matching heading`;
  }

  const [pathPart, frag] = target.split("#");
  if (!pathPart) return null; // shouldn't happen given kind check above, but stay defensive
  const resolved = resolve(dirname(sourceFile), decodeURIComponent(pathPart));
  const relFromRoot = relative(root, resolved).split("\\").join("/");

  if (!existsSync(resolved)) return `target does not exist: ${pathPart}`;
  if (!trackedFiles.has(relFromRoot)) return `target exists but is not tracked by git: ${pathPart}`;

  if (frag) {
    let targetText;
    try {
      targetText = readFileSync(resolved, "utf8");
    } catch {
      return `could not read target to check anchor: ${pathPart}`;
    }
    if (!headingsOf(targetText).has(slugify(decodeURIComponent(frag)))) {
      return `anchor #${frag} has no matching heading in ${pathPart}`;
    }
  }
  return null;
}

function extractLinks(mdSource) {
  const links = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(mdSource))) links.push(m[2].trim());
  return links;
}

/* ---------------------------------------------------------------- self-test */

const SELF_TESTS = [
  {
    name: "known-negative: link to a file that exists, no anchor",
    sourceFile: join(root, "FAKE.md"),
    sourceText: "See [x](README.md).",
    target: "README.md",
    expectFailure: false,
  },
  {
    name: "known-positive: link to a file that does not exist",
    sourceFile: join(root, "FAKE.md"),
    sourceText: "See [x](docs/DOES_NOT_EXIST.md).",
    target: "docs/DOES_NOT_EXIST.md",
    expectFailure: true,
  },
  {
    name: "known-positive: same-file anchor with no matching heading",
    sourceFile: join(root, "FAKE.md"),
    sourceText: "# Real Heading\n\nSee [x](#nonexistent-heading).",
    target: "#nonexistent-heading",
    expectFailure: true,
  },
  {
    name: "known-negative: same-file anchor with a matching heading",
    sourceFile: join(root, "FAKE.md"),
    sourceText: "# Real Heading\n\nSee [x](#real-heading).",
    target: "#real-heading",
    expectFailure: false,
  },
  {
    name: "known-negative: site-absolute in-app route is out of scope, not a broken filesystem path",
    sourceFile: join(root, "docs/FAKE.md"),
    sourceText: "See [x](/admin/embeds).",
    target: "/admin/embeds",
    expectFailure: false,
  },
];

function gitTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  return new Set(out.split("\n").filter(Boolean));
}

function runSelfTest(trackedFiles) {
  let failures = 0;
  for (const test of SELF_TESTS) {
    const problem = checkOneLink(test.sourceFile, test.sourceText, test.target, trackedFiles);
    const failed = problem !== null;
    if (failed !== test.expectFailure) {
      console.error(
        `check-links self-test FAILED: ${test.name} (expected ${test.expectFailure ? "a problem" : "no problem"}, got ${
          failed ? `"${problem}"` : "no problem"
        })`,
      );
      failures += 1;
    }
  }
  return failures;
}

/* ---------------------------------------------------------------- scan */

function findMarkdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) findMarkdownFiles(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function main() {
  const trackedFiles = gitTrackedFiles();

  const selfTestFailures = runSelfTest(trackedFiles);
  if (selfTestFailures > 0) {
    console.error(
      `check-links: ${selfTestFailures}/${SELF_TESTS.length} self-tests failed — the checker is broken, so its silence would mean nothing.`,
    );
    process.exit(1);
  }

  const mdFiles = findMarkdownFiles(root);
  let problems = 0;
  let linksChecked = 0;

  for (const file of mdFiles) {
    const text = readFileSync(file, "utf8");
    const relFile = relative(root, file).split("\\").join("/");
    for (const target of extractLinks(text)) {
      if (isRelative(target) === false) continue; // external, skip
      linksChecked += 1;
      const problem = checkOneLink(file, text, target, trackedFiles);
      if (problem) {
        console.error(`${relFile}: [${target}] -> ${problem}`);
        problems += 1;
      }
    }
  }

  if (problems > 0) {
    console.error(`check-links: FAILED — ${problems} broken relative link(s) of ${linksChecked} checked.`);
    process.exit(1);
  }

  console.log(
    `check-links: ok — ${SELF_TESTS.length} self-tests passed; ${linksChecked} relative link(s) checked across ${mdFiles.length} markdown file(s), 0 broken.`,
  );
}

main();
