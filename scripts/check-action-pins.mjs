#!/usr/bin/env node
/**
 * Require every third-party GitHub Action to use an immutable commit SHA.
 * A version comment keeps Renovate/dependabot-style review understandable while
 * the executed ref remains immutable.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workflowsRoot = resolve(root, ".github/workflows");
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export function findMutableActionRefs(source) {
  const hits = [];

  source.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?/);
    if (!match) return;

    const specifier = match[1];
    if (specifier.startsWith("./")) return;

    if (specifier.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/i.test(specifier)) {
        hits.push({ line: index + 1, specifier });
      }
      return;
    }

    const separator = specifier.lastIndexOf("@");
    const reference = separator >= 0 ? specifier.slice(separator + 1) : "";
    if (!COMMIT_SHA.test(reference)) hits.push({ line: index + 1, specifier });
  });

  return hits;
}

const SELF_TESTS = [
  {
    name: "rejects a mutable major tag",
    source: "steps:\n  - uses: actions/checkout@v4",
    expected: 1,
  },
  {
    name: "rejects an unpinned remote action",
    source: "steps:\n  - uses: owner/action",
    expected: 1,
  },
  {
    name: "rejects a mutable reusable workflow",
    source: "jobs:\n  shared:\n    uses: owner/repo/.github/workflows/check.yml@main",
    expected: 1,
  },
  {
    name: "accepts a full commit with a version comment",
    source:
      "steps:\n  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    expected: 0,
  },
  {
    name: "accepts a repository-local action",
    source: "steps:\n  - uses: ./.github/actions/check",
    expected: 0,
  },
];

let failures = 0;
for (const test of SELF_TESTS) {
  const actual = findMutableActionRefs(test.source).length;
  if (actual !== test.expected) {
    console.error(
      `action-pins self-test FAILED: ${test.name} (expected ${test.expected}, got ${actual})`,
    );
    failures += 1;
  }
}
if (failures) process.exit(1);

function* workflowFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* workflowFiles(path);
    } else if (YAML_EXTENSIONS.has(extname(entry))) {
      yield path;
    }
  }
}

let violations = 0;
let scanned = 0;
for (const path of workflowFiles(workflowsRoot)) {
  scanned += 1;
  const source = readFileSync(path, "utf8");
  for (const hit of findMutableActionRefs(source)) {
    console.error(
      `${relative(root, path)}:${hit.line} mutable action ref: ${hit.specifier}. ` +
        "Pin the official action to its full 40-character commit SHA and retain a version comment.",
    );
    violations += 1;
  }
}

if (violations) {
  console.error(`action-pins: ${violations} violation(s) across ${scanned} workflow file(s).`);
  process.exit(1);
}

console.log(
  `action-pins: ok — ${SELF_TESTS.length} self-tests passed; ${scanned} workflow file(s), 0 mutable refs.`,
);
