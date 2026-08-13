#!/usr/bin/env node
/**
 * Build-output gate: the database schema must never reach a browser.
 *
 * AGENTS.md already warns that importing runtime values from `app/db/schema.ts`
 * into a route module drags drizzle's sqlite-core into that route's CLIENT
 * chunk. The warning is not enough on its own — React Router strips `loader`
 * and `action`, but the bare `import "~/db/schema"` SIDE EFFECT can survive the
 * strip, and then the chunk ships every table and column name (including
 * `api_keys.key_hash` and `auth_tokens.token_hash`) to anyone who fetches the
 * asset URL. That is exactly what `api.upload-*.js` was doing at 30.7 kB.
 *
 * `npm run check` cannot catch this: it never builds. So this runs against
 * `build/client/` after `npm run build`.
 *
 * Like scripts/guards.mjs, the detector proves itself before it is trusted:
 * a known-positive and a known-negative fixture go through the same code path,
 * and a detector that cannot fire exits non-zero without scanning.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CLIENT_DIR = resolve(root, process.argv[2] ?? "build/client");

/**
 * `drizzle:entityKind` is the symbol every drizzle entity class is tagged with.
 * It is present in any bundle that evaluated the ORM, and absent from one that
 * only imported types. The table names are a second, independent signal so a
 * drizzle rename cannot silently retire this gate.
 */
const MARKERS = [
  { id: "drizzle-runtime", needle: "drizzle:entityKind", why: "drizzle ORM runtime" },
  { id: "schema-tables", needle: "auth_tokens", why: "database table name" },
  { id: "schema-secrets", needle: "key_hash", why: "credential column name" },
];

export function scanBundle(source) {
  return MARKERS.filter((marker) => source.includes(marker.needle));
}

/* ------------------------------------------------------- self-test */

const SELF_TESTS = [
  {
    name: "fires on the drizzle entity symbol",
    source: "var e=Symbol.for(`drizzle:entityKind`);",
    expect: "drizzle-runtime",
  },
  {
    name: "fires on a leaked table name",
    source: 'R(`auth_tokens`,{id:W()})',
    expect: "schema-tables",
  },
  {
    name: "fires on a leaked credential column",
    source: "keyHash:F(`key_hash`).notNull()",
    expect: "schema-secrets",
  },
  {
    name: "stays silent on ordinary client code",
    source: 'import{jsx as e}from"react/jsx-runtime";export default function A(){return e("p",{})}',
    expect: null,
  },
  {
    name: "stays silent on an empty resource-route stub",
    source: "",
    expect: null,
  },
];

let selfTestFailures = 0;
for (const test of SELF_TESTS) {
  const ids = scanBundle(test.source).map((hit) => hit.id);
  const passed = test.expect === null ? ids.length === 0 : ids.includes(test.expect);
  if (!passed) {
    console.error(
      `check-bundle self-test FAILED: ${test.name} (expected ${test.expect ?? "no hits"}, got [${ids.join(", ")}])`,
    );
    selfTestFailures += 1;
  }
}
if (selfTestFailures > 0) {
  console.error(
    `check-bundle: ${selfTestFailures}/${SELF_TESTS.length} self-tests failed — the scanner is broken, so its silence would mean nothing.`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------ scan */

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".js")) yield full;
  }
}

let scanned = 0;
let violations = 0;

try {
  statSync(CLIENT_DIR);
} catch {
  console.error(
    `check-bundle: ${relative(root, CLIENT_DIR)} does not exist. Run \`npm run build\` first — this gate reads build output, not source.`,
  );
  process.exit(1);
}

for (const file of walk(CLIENT_DIR)) {
  scanned += 1;
  const hits = scanBundle(readFileSync(file, "utf8"));
  for (const hit of hits) {
    console.error(
      `${relative(root, file)}  [${hit.id}] ${hit.why} reached the client bundle.\n` +
        `    A route module imported a RUNTIME value from ~/db/schema. Move the\n` +
        `    schema-touching code into a *.server.ts module and import that instead.`,
    );
    violations += 1;
  }
}

if (scanned === 0) {
  console.error(`check-bundle: no .js files under ${relative(root, CLIENT_DIR)} — nothing was checked.`);
  process.exit(1);
}

if (violations > 0) {
  console.error(`\ncheck-bundle: ${violations} violation(s) across ${scanned} client assets.`);
  process.exit(1);
}

console.log(
  `check-bundle: ok — ${SELF_TESTS.length} self-tests passed, ${scanned} client assets scanned, 0 schema leaks.`,
);
