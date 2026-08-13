#!/usr/bin/env node
/**
 * README.md's stamped volatile counts, actually run.
 *
 * The Limitations section stamps four counts with the exact command that
 * reproduces them (migrations, tables, seeded tables, tests) — e.g.
 * `` `ls app/db/migrations/*.sql | wc -l` → **20** migrations ``. #204 found
 * all four stale at once (17->20, 37->39, 2610->2836, and the test-count
 * COMMAND itself needed fixing because `wc -l` is nondeterministic against
 * Node's per-worker `ExperimentalWarning` lines). Nothing had ever run the
 * stamped commands and diffed the result — a human read the number, believed
 * it, and moved on. This script is that missing step.
 *
 * It extracts every `` `command` → **NUMBER** label `` stamp from the
 * Limitations section, runs each command from a clean cwd, and fails naming
 * any stamp whose printed number no longer matches. Commands that need a
 * running server or the network (curl against a live deployment, etc.) are
 * out of scope and skipped — everything currently stamped is pure
 * filesystem/grep/vitest-list, so nothing is skipped today.
 *
 * Extraction is resilient to ordinary prose edits (wrapped lines, reordered
 * sentences) because it normalizes whitespace before matching, but it is NOT
 * a promise to survive every possible rewrite. Per house law (see
 * scripts/check-links.mjs, scripts/check-migrations.mjs): a check that
 * cannot find its target must not report ok. If the stamp format changes
 * enough that a required count (migrations/tables/seeded tables/tests)
 * cannot be located, that is a FAILURE — "could not locate stamp" — never a
 * silent pass.
 *
 * Usage: node scripts/docs-verify.mjs
 * Exit 0 = every located, runnable stamp matches. Exit 1 = a mismatch, a
 * stamp could not be located, or a stamped command failed to run.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const README_PATH = resolve(root, "README.md");

/** Stamps whose command needs a live server or the network are out of scope
 * for a repo-local check — matched defensively even though nothing stamped
 * today trips it. */
const NEEDS_SERVER_OR_NETWORK_RE = /\bcurl\b|localhost|https?:\/\//i;

const REQUIRED_LABELS = ["migrations", "tables", "seeded tables", "tests"];

/* ---------------------------------------------------------------- parsing */

/**
 * Every `` `command` → **NUMBER** label `` stamp in the "## Limitations"
 * section. Whitespace-normalized first so a stamp's label can wrap across
 * source lines (the real file wraps "seeded\ntables" mid-label) without
 * breaking the match. Returns null if the section itself cannot be found.
 */
function extractStamps(readmeText) {
  const start = readmeText.indexOf("## Limitations");
  if (start === -1) return null;
  const nextHeading = readmeText.indexOf("\n## ", start + 1);
  const section = nextHeading === -1 ? readmeText.slice(start) : readmeText.slice(start, nextHeading);
  const normalized = section.replace(/\s+/g, " ");

  const stampRe = /`([^`]+)`\s*→\s*\*\*(\d+)\*\*\s+([a-zA-Z][a-zA-Z ]*?)(?=[;.])/g;
  const stamps = [];
  let m;
  while ((m = stampRe.exec(normalized))) {
    stamps.push({ command: m[1].trim(), count: Number(m[2]), label: m[3].trim().toLowerCase() });
  }
  return stamps.length > 0 ? stamps : null;
}

/* --------------------------------------------------------------- running */

/** Real shell runner. Pipes/grep/wc need an actual shell; `bash.exe` is what
 * this repo's Windows contributors have on PATH (Git for Windows / WSL), and
 * every other platform's execSync default (`/bin/sh`) already handles them. */
function runCommand(command, cwd) {
  return execSync(command, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" ? "bash.exe" : undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Compares each located stamp against what `run(command, cwd)` actually
 * prints. `run` is injected so the self-test below can prove the comparison
 * logic without touching a shell or this repo's real file counts.
 */
function checkStamps(stamps, cwd, run) {
  const problems = [];
  for (const stamp of stamps) {
    if (NEEDS_SERVER_OR_NETWORK_RE.test(stamp.command)) continue;

    let output;
    try {
      output = run(stamp.command, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(
        `README says ${stamp.count} ${stamp.label} (\`${stamp.command}\`), but the command failed: ${message.replace(/[\r\n]+/g, " ")}`,
      );
      continue;
    }

    const actual = Number(output.trim());
    if (!Number.isFinite(actual)) {
      problems.push(
        `README says ${stamp.count} ${stamp.label} (\`${stamp.command}\`), but the command's output was not a number: ${JSON.stringify(output.trim())}`,
      );
      continue;
    }

    if (actual !== stamp.count) {
      problems.push(`README says ${stamp.count} ${stamp.label}; \`${stamp.command}\` counts ${actual} — restamp`);
    }
  }
  return problems;
}

/** Returns a list of problem strings; empty = every required stamp located
 * and verified. */
function findProblems(readmeText, cwd, run) {
  const stamps = extractStamps(readmeText);
  if (!stamps) {
    return [
      `could not locate the stamped volatile-count sentence in README.md's "## Limitations" section — the checker cannot verify anything`,
    ];
  }

  const problems = [];
  for (const label of REQUIRED_LABELS) {
    if (!stamps.some((s) => s.label === label)) {
      problems.push(`could not locate a stamp for "${label}" — README's stamp format changed, or the stamp is gone`);
    }
  }
  problems.push(...checkStamps(stamps, cwd, run));
  return problems;
}

/* ---------------------------------------------------------------- self-test */

function stampLine(command, count, label) {
  return `\`${command}\` → **${count}** ${label};`;
}

const GOLDEN_README = `# Callboard

## Limitations

Volatile counts for the commit this file ships in, one reproducing command each:
${stampLine("echo 20", 20, "migrations")}
${stampLine("echo 39", 39, "tables")}
${stampLine("echo 29", 29, "seeded tables")}
${stampLine("echo 2854", 2854, "tests")}

## Verify it yourself
`;

const mockRunFor = (answers) => (command) => {
  if (!(command in answers)) throw new Error(`self-test mock has no answer for: ${command}`);
  return answers[command];
};

const GOLDEN_ANSWERS = {
  "echo 20": "20\n",
  "echo 39": "39\n",
  "echo 29": "29\n",
  "echo 2854": "2854\n",
};

const SELF_TESTS = [
  {
    name: "known-negative: every stamp matches what its command prints",
    readme: GOLDEN_README,
    run: mockRunFor(GOLDEN_ANSWERS),
    expectFailure: false,
  },
  {
    name: "known-positive: one stamp's command now prints a different number",
    readme: GOLDEN_README,
    run: mockRunFor({ ...GOLDEN_ANSWERS, "echo 39": "40\n" }),
    expectFailure: true,
  },
  {
    name: "known-positive: a stamped command fails to run",
    readme: GOLDEN_README,
    run: (command) => {
      if (command === "echo 20") throw new Error("command not found");
      return mockRunFor(GOLDEN_ANSWERS)(command);
    },
    expectFailure: true,
  },
  {
    name: "known-positive: a stamped command's output is not a number",
    readme: GOLDEN_README,
    run: mockRunFor({ ...GOLDEN_ANSWERS, "echo 20": "twenty\n" }),
    expectFailure: true,
  },
  {
    name: "known-positive: the tests stamp is missing entirely",
    readme: GOLDEN_README.replace(`${stampLine("echo 2854", 2854, "tests")}\n`, ""),
    run: mockRunFor(GOLDEN_ANSWERS),
    expectFailure: true,
  },
  {
    name: "known-positive: no Limitations section at all",
    readme: GOLDEN_README.replace("## Limitations", "## Nothing Here"),
    run: mockRunFor(GOLDEN_ANSWERS),
    expectFailure: true,
  },
  {
    name: "known-negative: a stamp needing a live server/network is skipped, not run",
    readme: `${GOLDEN_README}\n${stampLine("curl -s https://demo.callboardhq.com/ready", 200, "status")};`,
    // Any call for the curl command throws — proving it was never invoked.
    run: (command) => {
      if (command.includes("curl")) throw new Error("must not run network commands");
      return mockRunFor(GOLDEN_ANSWERS)(command);
    },
    expectFailure: false,
  },
];

function runSelfTest() {
  let failures = 0;
  for (const test of SELF_TESTS) {
    const problems = findProblems(test.readme, root, test.run);
    const failed = problems.length > 0;
    if (failed !== test.expectFailure) {
      console.error(
        `docs-verify self-test FAILED: ${test.name} (expected ${test.expectFailure ? "a problem" : "no problem"}, got ${
          failed ? `${problems.length} problem(s): ${problems.join("; ")}` : "no problem"
        })`,
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
      `docs-verify: ${selfTestFailures}/${SELF_TESTS.length} self-tests failed — the checker is broken, so its silence would mean nothing.`,
    );
    process.exit(1);
  }

  const readmeText = readFileSync(README_PATH, "utf8");
  const problems = findProblems(readmeText, root, runCommand);
  if (problems.length > 0) {
    console.error(`docs-verify: FAILED — README.md's stamped counts do not match reality:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`docs-verify: ok — ${SELF_TESTS.length} self-tests passed; all stamped README counts match.`);
}

main();
