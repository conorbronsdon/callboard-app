#!/usr/bin/env node
/**
 * docs/PUBLIC_STRIP_LIST.md self-consistency — the table, the `rm -rf`
 * release-export command, and the two verification regexes must all name the
 * same stripped paths.
 *
 * That file protects the release mechanism itself: everything in its table
 * is a private path that must NOT survive the public export. Before #204 the
 * command and both regexes had silently drifted from the table — three files
 * (BLINDING-PROOFS.md, RECUSAL-PROOFS.md, BONUS_IDEAS.md) were listed as
 * "stripped" but the export command never deleted them and both verification
 * regexes reported "clean" anyway, because none of the three mentioned the
 * files either. A hand fix closed that gap once; nothing stopped it from
 * reopening the next time someone edits the table without touching the other
 * three places by hand. This script is that guard.
 *
 * It parses, from the markdown TEXT (never executes anything in the doc):
 *   1. the "Paths to remove" table -> [{ path, kind: "file" | "directory" }]
 *   2. the `rm -rf ...` command's argument list
 *   3. the `git ls-files | grep -E '...'` verification regex
 *   4. the `grep -rn '...' ...` verification regex
 * and asserts every table path is covered by the command, and matched by the
 * kind-appropriate alternation in BOTH regexes. A path can drift out of any
 * one of those three without the others noticing — that is exactly what
 * happened — so each is checked independently against the table, not against
 * each other.
 *
 * Like scripts/check-links.mjs and scripts/check-migrations.mjs, this proves
 * itself before it is trusted: SELF_TESTS below run known-consistent and
 * known-drifted fixtures through the exact same parse/compare code as the
 * real scan. A checker that cannot fail is not a checker — and a parser that
 * silently finds nothing is worse than one that fails loudly, so a markdown
 * shape it cannot locate (no table, no `rm -rf` block, no verification
 * regexes) is itself a failure, never a silent pass.
 *
 * Usage: node scripts/check-strip-list.mjs
 * Exit 0 = table, command, and both regexes agree. Exit 1 = they don't, OR
 * the self-test failed (in which case the real scan below did not run).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOC_PATH = resolve(root, "docs/PUBLIC_STRIP_LIST.md");

/* ---------------------------------------------------------------- parsing */

/** The "Paths to remove" table -> [{ path, kind }]. `kind` is normalized to
 * the bare word before any parenthetical ("directory (recursive)" ->
 * "directory"). Returns null if the section/table cannot be located. */
function parseTable(text) {
  const start = text.indexOf("## Paths to remove");
  if (start === -1) return null;
  const nextHeading = text.indexOf("\n## ", start + 1);
  const section = nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading);

  const rows = [];
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*(file|directory)\b/gm;
  let m;
  while ((m = rowRe.exec(section))) rows.push({ path: m[1], kind: m[2] });
  return rows.length > 0 ? rows : null;
}

/** Join `rm -rf`'s backslash-continued lines into one logical command and
 * return its path arguments (flags and the `rm`/`rm -rf` tokens dropped).
 * Returns null if no `rm -rf` line is found. */
function commandArgs(text) {
  const lines = text.split("\n");
  let capturing = false;
  let combined = "";
  for (const line of lines) {
    if (!capturing) {
      if (!/^\s*rm\s+-rf\b/.test(line)) continue;
      capturing = true;
    }
    combined += `${combined ? " " : ""}${line.replace(/\\\s*$/, "").trim()}`;
    if (!/\\\s*$/.test(line)) break;
  }
  if (!capturing) return null;
  return combined.split(/\s+/).filter((token) => token && token !== "rm" && !token.startsWith("-"));
}

/** The two verification regex STRINGS (the content between the outer single
 * quotes), taken from the fenced block under "## Verification". Returns null
 * if either line cannot be located. */
function extractVerificationRegexes(text) {
  const start = text.indexOf("## Verification");
  if (start === -1) return null;
  const section = text.slice(start);

  const gitLsFiles = section.match(/^git ls-files \| grep -E '([^']+)'/m);
  const grepRn = section.match(/^grep -rn '([^']+)'/m);
  if (!gitLsFiles || !grepRn) return null;
  return { gitLsFilesPattern: gitLsFiles[1], grepRnPattern: grepRn[1] };
}

/** `^(A|B|C)\.md$|^dir/|^otherdir/` -> the file/dir alternates it matches. */
function parseGitLsFilesRegex(pattern) {
  const files = new Set();
  const groupMatch = pattern.match(/\(([^)]+)\)\\\.md\$/);
  if (groupMatch) {
    for (const name of groupMatch[1].split("|")) files.add(`${name}.md`);
  }
  const rest = groupMatch
    ? pattern.slice(0, groupMatch.index) + pattern.slice(groupMatch.index + groupMatch[0].length)
    : pattern;
  const dirs = new Set();
  for (const m of rest.matchAll(/\^([\w.-]+)\//g)) dirs.add(`${m[1]}/`);
  return { files, dirs };
}

/** `A\.md\|B\.md\|dir/` (basic-regex alternation via GNU `\|`) -> the
 * file/dir alternates it matches. */
function parseGrepRnRegex(pattern) {
  const files = new Set();
  const dirs = new Set();
  for (const token of pattern.split("\\|")) {
    if (token.endsWith("/")) dirs.add(token);
    else files.add(token.replace(/\\\./g, "."));
  }
  return { files, dirs };
}

/* -------------------------------------------------------------- compare */

/** Returns a list of problem strings; empty = consistent. A markdown shape
 * this cannot locate produces exactly one "could not locate" problem rather
 * than silently reporting zero problems. */
function findProblems(markdownText) {
  const table = parseTable(markdownText);
  if (!table) return [`could not locate the "Paths to remove" table — the checker cannot verify anything`];

  const args = commandArgs(markdownText);
  if (!args) return [`could not locate the \`rm -rf\` release-export command — the checker cannot verify anything`];

  const regexes = extractVerificationRegexes(markdownText);
  if (!regexes) {
    return [`could not locate both verification regex lines — the checker cannot verify anything`];
  }
  const gitLsFiles = parseGitLsFilesRegex(regexes.gitLsFilesPattern);
  const grepRn = parseGrepRnRegex(regexes.grepRnPattern);

  const problems = [];
  for (const { path, kind } of table) {
    if (!args.includes(path)) {
      problems.push(`table path "${path}" is not an argument to the rm -rf release-export command`);
    }

    const gitLsFilesSet = kind === "file" ? gitLsFiles.files : gitLsFiles.dirs;
    if (!gitLsFilesSet.has(path)) {
      problems.push(
        `table ${kind} "${path}" is not matched by the \`git ls-files | grep -E\` verification regex`,
      );
    }

    const grepRnSet = kind === "file" ? grepRn.files : grepRn.dirs;
    if (!grepRnSet.has(path)) {
      problems.push(`table ${kind} "${path}" is not matched by the \`grep -rn\` verification regex`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- self-test */

const GOLDEN = `# Public strip list

## Paths to remove

| Path | Kind |
|---|---|
| \`ALPHA.md\` | file |
| \`BETA.md\` | file |
| \`secret/\` | directory (recursive) |

## Release-export procedure

\`\`\`sh
git -C ~/repo archive <tag> | tar -x -C <dir>
cd <dir>
rm -rf ALPHA.md BETA.md secret/ \\
  .gitattributes docs/PUBLIC_STRIP_LIST.md
git init -b main && git add -A
\`\`\`

## Verification

\`\`\`sh
git ls-files | grep -E '^(ALPHA|BETA)\\.md$|^secret/'
grep -rn 'ALPHA\\.md\\|BETA\\.md\\|secret/' \\
  README.md
\`\`\`
`;

/** name -> transform applied to GOLDEN to produce a deliberately drifted fixture. */
const BREAK = {
  "drop BETA.md from the rm -rf command": (md) => md.replace("rm -rf ALPHA.md BETA.md secret/", "rm -rf ALPHA.md secret/"),
  "drop BETA from the git-ls-files regex": (md) =>
    md.replace("^(ALPHA|BETA)\\.md$", "^(ALPHA)\\.md$"),
  "drop secret/ from the git-ls-files regex": (md) => md.replace("|^secret/", ""),
  "drop BETA.md from the grep -rn regex": (md) => md.replace("BETA\\.md\\|", ""),
  "drop secret/ from the grep -rn regex": (md) => md.replace("\\|secret/", ""),
  "drop BETA.md from the table entirely (command/regexes now reference an untabled path, not a problem)": (md) =>
    md.replace("| `BETA.md` | file |\n", ""),
};

const SELF_TESTS = [
  { name: "known-negative: a fully consistent doc reports no problems", markdown: GOLDEN, expectFailure: false },
  ...Object.entries(BREAK)
    .filter(([name]) => !name.startsWith("drop BETA.md from the table"))
    .map(([name, transform]) => ({
      name: `known-positive: ${name}`,
      markdown: transform(GOLDEN),
      expectFailure: true,
    })),
  {
    name: "known-negative: removing a path from the table (not the command/regexes) is not this checker's problem",
    markdown: BREAK["drop BETA.md from the table entirely (command/regexes now reference an untabled path, not a problem)"](
      GOLDEN,
    ),
    expectFailure: false,
  },
  {
    name: "known-positive: no 'Paths to remove' table at all",
    markdown: GOLDEN.replace("## Paths to remove", "## Nothing Here"),
    expectFailure: true,
  },
  {
    name: "known-positive: no rm -rf command at all",
    markdown: GOLDEN.replace(/rm -rf[^\n]*\n(\s+[^\n]*\\\n)*\s+[^\n]*\n/, ""),
    expectFailure: true,
  },
  {
    name: "known-positive: no verification regexes at all",
    markdown: GOLDEN.replace("## Verification", "## Nothing Here"),
    expectFailure: true,
  },
];

function runSelfTest() {
  let failures = 0;
  for (const test of SELF_TESTS) {
    const problems = findProblems(test.markdown);
    const failed = problems.length > 0;
    if (failed !== test.expectFailure) {
      console.error(
        `check-strip-list self-test FAILED: ${test.name} (expected ${
          test.expectFailure ? "a problem" : "no problem"
        }, got ${failed ? `${problems.length} problem(s): ${problems.join("; ")}` : "no problem"})`,
      );
      failures += 1;
    }
  }
  return failures;
}

/* -------------------------------------------------------------------- main */

function main() {
  const selfTestFailures = runSelfTest();
  if (selfTestFailures > 0) {
    console.error(
      `check-strip-list: ${selfTestFailures}/${SELF_TESTS.length} self-tests failed — the checker is broken, so its silence would mean nothing.`,
    );
    process.exit(1);
  }

  const text = readFileSync(DOC_PATH, "utf8");
  const problems = findProblems(text);
  if (problems.length > 0) {
    console.error(
      `check-strip-list: FAILED — docs/PUBLIC_STRIP_LIST.md's table, rm -rf command, and verification regexes have drifted:`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `check-strip-list: ok — ${SELF_TESTS.length} self-tests passed; table/command/regexes agree on every stripped path.`,
  );
}

main();
