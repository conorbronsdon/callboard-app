/**
 * PII discipline for the outbound mirror, as a check that can fail.
 *
 * The mirror writes into someone else's SaaS. Whatever it serializes leaves our
 * database permanently and lands in a base that gets shared by link. So the set
 * of columns it may write is not something to infer from reading the code once —
 * it is pinned here, against a list a human reviewed, and any new field is red
 * until somebody adds it deliberately.
 *
 * This is a STATIC SOURCE SCAN, in the same style as `write-path.test.ts`, and
 * for the same reason that file gives: `write-path.test.ts` pins the modules
 * allowed to IMPORT the mirror, and that spec is frozen for the release. A test
 * that imported `airtable.server.ts` to inspect its output would itself break
 * that allowlist. Reading the source sidesteps that — and catches a forbidden
 * field even on a code path no fixture happens to exercise.
 *
 * Every extractor below is exercised against synthetic source with a known
 * answer, so a scan that silently stopped matching would fail these tests rather
 * than quietly approve everything.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MIRROR_FIELD_SPEC } from "./airtable-schema.server";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..", "..");
const MIRROR_SOURCE = readFileSync(join(HERE, "airtable.server.ts"), "utf8");

/**
 * Every Airtable column name the mirror can write, read out of its source.
 *
 * Two shapes carry a field name, and both appear in the mirror today:
 *   fields: { Email: ..., "Updated At": ..., [AIRTABLE_MERGE_FIELD]: ... }
 *   record.fields.Room = ...        /        record.fields["Starts At"] = ...
 */
export function projectedFields(source: string): string[] {
  const found = new Set<string>();

  // `export const AIRTABLE_MERGE_FIELD = "Callboard ID";` — resolve the one
  // computed key rather than reporting the identifier as a column name.
  const constants = new Map<string, string>();
  for (const match of source.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"\s*;/g,
  )) {
    constants.set(match[1], match[2]);
  }

  // Object-literal form: find each `fields: {` and brace-match its body.
  for (const opener of source.matchAll(/\bfields\s*:\s*\{/g)) {
    let depth = 1;
    let index = opener.index! + opener[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    const body = source.slice(start, index - 1);
    for (const key of body.matchAll(
      /(?:^|,)\s*(?:\[\s*([A-Za-z_$][\w$]*)\s*\]|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g,
    )) {
      const [, computed, quoted, bare] = key;
      if (computed) {
        const resolved = constants.get(computed);
        // An unresolvable computed key is reported verbatim so it shows up as
        // an unreviewed field rather than vanishing from the audit.
        found.add(resolved ?? `<computed ${computed}>`);
      } else {
        found.add(quoted ?? bare);
      }
    }
  }

  // Assignment form.
  for (const match of source.matchAll(
    /\.fields(?:\.([A-Za-z_$][\w$]*)|\[\s*"([^"]+)"\s*\])\s*=/g,
  )) {
    found.add(match[1] ?? match[2]);
  }

  return [...found].sort();
}

/**
 * The reviewed column list — written out by hand, NOT derived from the mirror
 * or from MIRROR_FIELD_SPEC. That independence is the whole point: if the two
 * agreed by construction this test would assert nothing.
 *
 * Contact email is here on purpose. The mirror writes into the organiser's own
 * base and a speaker roster without addresses is not a roster. Everything else
 * is programme metadata the event publishes anyway — including the `Speakers`
 * column on the session tables, which is a list of DISPLAY NAMES, not of
 * addresses.
 *
 * ⚠️ THIS LIST IS A UNION AND CANNOT SEE TABLES. It is a static source scan, so
 * it knows which names the mirror can write but not which table each one lands
 * in, and it never reads the expression assigned to a name. Two mutations
 * therefore pass here and must be caught elsewhere: moving an approved column
 * onto the wrong table, and keeping an approved column's NAME while changing
 * what it carries (`Bio: row.bio` -> `Bio: someSecret`, or `Speakers` going
 * back to joined email addresses). Both are pinned in `airtable.test.ts`
 * against the real payload, per table and by value, under "PII containment".
 */
const REVIEWED_FIELDS = [
  "Bio",
  "Callboard ID",
  "Company",
  "Email",
  "Ends At",
  "Name",
  "Public",
  "Reference",
  "Room",
  "Speakers",
  "Starts At",
  "Status",
  "Title",
  "Track",
  "Updated At",
];

/** Shapes that must never become a column, whatever anyone names them. */
const FORBIDDEN = [
  { label: "internal double-underscore keys", pattern: /^__/ },
  { label: "raw submission answers", pattern: /answer/i },
  { label: "auth material", pattern: /token|secret|password|hash|api[_ -]?key/i },
  { label: "request telemetry", pattern: /ip[_ -]?address|user[_ -]?agent/i },
];

describe("the extractor works before we trust it", () => {
  it("NEGATIVE CONTROL: it finds the fields that really are in the mirror", () => {
    const fields = projectedFields(MIRROR_SOURCE);
    // If this were empty every assertion below would pass vacuously.
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain("Callboard ID"); // the computed [AIRTABLE_MERGE_FIELD]
    expect(fields).toContain("Updated At"); // a quoted key
    expect(fields).toContain("Email"); // a bare key
    expect(fields).toContain("Room"); // an assignment
    expect(fields).toContain("Starts At"); // a bracketed assignment
  });

  it("MUST FIRE: it catches a `__` key added to a fields literal", () => {
    const mutated = `const r = { fields: { Email: a, __internalScore: b } };`;
    expect(projectedFields(mutated)).toContain("__internalScore");
  });

  it("MUST FIRE: it catches an answers dump added by assignment", () => {
    const mutated = `record.fields["Answers JSON"] = JSON.stringify(row.answers);`;
    expect(projectedFields(mutated)).toContain("Answers JSON");
  });

  it("MUST NOT FIRE: it does not invent fields from unrelated object literals", () => {
    const unrelated = `const options = { headers: { authorization: token }, method: "PATCH" };`;
    expect(projectedFields(unrelated)).toEqual([]);
  });
});

describe("the mirror only writes reviewed columns", () => {
  const fields = projectedFields(MIRROR_SOURCE);

  it("serializes nothing outside the reviewed allowlist", () => {
    const unexpected = fields.filter((field) => !REVIEWED_FIELDS.includes(field));
    expect(unexpected).toEqual([]);
  });

  it("MUST NOT FIRE: no forbidden shape reaches Airtable", () => {
    for (const { label, pattern } of FORBIDDEN) {
      const hits = fields.filter((field) => pattern.test(field));
      expect(hits, `${label} must never be mirrored`).toEqual([]);
    }
  });

  it("MUST FIRE: the forbidden patterns actually match the things they name", () => {
    // A guard whose patterns match nothing would pass the test above forever.
    const samples = ["__provenance", "Answers JSON", "API Key", "IP Address"];
    for (const sample of samples) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample)), sample).toBe(true);
    }
  });

  it("the reviewed list has no dead entries", () => {
    // Keeps the allowlist honest in the other direction: a column that was
    // removed from the mirror should not linger here as pre-approval.
    const unused = REVIEWED_FIELDS.filter((field) => !fields.includes(field));
    expect(unused).toEqual([]);
  });
});

describe("the base schema matches what the mirror sends", () => {
  const projected = projectedFields(MIRROR_SOURCE);
  const declared = [
    ...new Set(Object.values(MIRROR_FIELD_SPEC).flatMap((f) => f.map((x) => x.name))),
  ].sort();

  it("every column the mirror writes is one the preflight would create", () => {
    // Drift here is the 422-on-every-push failure: the mirror sends a field the
    // base was never given a column for.
    expect(projected.filter((field) => !declared.includes(field))).toEqual([]);
  });

  it("the preflight creates no column the mirror never writes", () => {
    expect(declared.filter((field) => !projected.includes(field))).toEqual([]);
  });
});

/**
 * The same containment guarantee `write-path.test.ts` gives the mirror, for the
 * preflight module. It holds a schema-WRITE credential; it belongs nowhere near
 * a request handler.
 */
describe("the preflight stays off the write path", () => {
  const PATTERN = /from\s+["'][^"']*integrations\/airtable-schema\.server["']/;
  const ALLOWED = [
    "lib/integrations/airtable-projection.test.ts",
    "lib/integrations/airtable-schema.test.ts",
  ];

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) yield full;
    }
  }

  const found: string[] = [];
  for (const file of walk(APP_DIR)) {
    if (PATTERN.test(readFileSync(file, "utf8"))) {
      found.push(relative(APP_DIR, file).replace(/\\/g, "/"));
    }
  }
  found.sort();

  it("NEGATIVE CONTROL: the scanner really does find imports", () => {
    expect(found).toContain("lib/integrations/airtable-projection.test.ts");
  });

  it("no route or request-path module imports it", () => {
    // The job registry reaches it through a dynamic import inside `run()`, so it
    // is absent from this static list by design — nothing loads a schema-write
    // credential just to render the jobs page.
    expect(found.filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });

  it("MUST NOT FIRE: the pattern does not match the mirror module", () => {
    /*
     * Assembled rather than written out, because `write-path.test.ts` scans this
     * file's raw SOURCE for the mirror's import line — a literal here would look
     * to that scanner like a real import and fail a spec we are not violating.
     * The `${""}` splits the text on disk; the value at runtime is exact.
     */
    const mirrorImport = `from "~/lib/integrations/airtable${""}.server"`;
    expect(mirrorImport).toBe('from "~/lib/integrations/airtable' + '.server"');

    expect(PATTERN.test(mirrorImport)).toBe(false);
    expect(PATTERN.test('from "~/lib/integrations/airtable-schema.server"')).toBe(true);
  });
});
