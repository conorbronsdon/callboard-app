#!/usr/bin/env node
/**
 * Repo guards for the two mistakes that break a Worker only in production.
 *
 * Run by `npm run check` and by CI.
 *
 *   1. `process.env` — undefined on Workers. Config goes through
 *      app/lib/env.server.ts. (scripts/ is exempt; it is Node.)
 *   2. `.transaction(` — D1 has no interactive transactions; Drizzle's
 *      transaction helper throws on the D1 driver. Use `db.batch([...])`.
 *
 * A plain `grep -rn` cannot do this: it flags the prose in the very files that
 * explain the rule. So the scan strips comments and string literals first, and
 * then PROVES it still works by running known-positive and known-negative
 * fixtures through the same code path. If the self-test does not behave, this
 * exits non-zero without scanning — a detector that cannot fire is not a gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SCAN_DIRS = ["app", "workers"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

const RULES = [
  {
    id: "no-process-env",
    pattern: /process\s*\.\s*env/,
    message:
      "`process.env` is undefined in a deployed Worker. Read config via app/lib/env.server.ts.",
  },
  {
    id: "no-d1-transaction",
    pattern: /\.\s*transaction\s*\(/,
    message:
      "D1 has no interactive transactions — Drizzle's transaction helper throws. Use db.batch([...]).",
  },
];

/**
 * Blank out comments and string/template literal contents, preserving line
 * structure so reported line numbers stay accurate. Character-by-character
 * because `https://…` inside a string is not a comment, and the rule text in a
 * doc comment is not code.
 *
 * Template literals are NOT blanked wholesale: the text between backticks is
 * inert, but a `${...}` interpolation is live code. Blanking the whole literal
 * let `` `${process.env.X}` `` through the guard — a violation that shipped
 * would have been undetectable. Interpolations are therefore recursed into,
 * with nesting handled (a `${}` may contain a template literal of its own).
 */
export function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;

  const keepNewlines = (text) => text.replace(/[^\n]/g, " ");

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
      continue;
    }

    const char = source[i];

    if (char === "`") {
      out += "`";
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          // Keep any newline that follows, so line numbers do not drift.
          out += " " + (source[i + 1] === "\n" ? "\n" : " ");
          i += 2;
          continue;
        }
        if (source[i] === "`") break;
        if (source[i] === "$" && source[i + 1] === "{") {
          const end = findInterpolationEnd(source, i + 2);
          // Recurse: the expression is code, and may itself hold literals.
          out += "${" + stripCommentsAndStrings(source.slice(i + 2, end));
          if (end < n) out += "}";
          i = end + 1;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += i < n ? "`" : "";
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j += 1;
      }
      const stop = Math.min(j + 1, n);
      // Keep the quotes so the token still looks like a literal, blank the body.
      out += quote + keepNewlines(source.slice(i + 1, stop - 1)) + (source[stop - 1] ?? "");
      i = stop;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * Index of the `}` closing an interpolation that starts at `start`, counting
 * braces while skipping over quoted strings and nested template literals so a
 * `}` inside `"…"` or a nested `` `${}` `` does not close it early.
 */
function findInterpolationEnd(source, start) {
  let depth = 1;
  let i = start;
  const n = source.length;

  while (i < n) {
    const char = source[i];

    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      while (i < n && source[i] !== quote) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (char === "`") {
      // Skip the nested template literal, honouring ITS interpolations.
      i += 1;
      while (i < n && source[i] !== "`") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          i = findInterpolationEnd(source, i + 2) + 1;
          continue;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return n;
}

export function scanSource(source) {
  const code = stripCommentsAndStrings(source);
  const lines = code.split("\n");
  const hits = [];
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({ rule, line: index + 1, text: line.trim() });
      }
    }
  });
  return hits;
}

/* ------------------------------------------------------- self-test */

const SELF_TESTS = [
  {
    name: "flags a real process.env read",
    source: "const key = process.env.SESSION_SECRET;",
    expect: "no-process-env",
  },
  {
    name: "flags a bracketed process.env read",
    source: 'const key = process.env["SESSION_SECRET"];',
    expect: "no-process-env",
  },
  {
    name: "flags a real db.transaction call",
    source: "await db.transaction(async (tx) => tx.insert(x));",
    expect: "no-d1-transaction",
  },
  {
    name: "ignores process.env named in a line comment",
    source: "// never use process.env here\nconst a = 1;",
    expect: null,
  },
  {
    name: "ignores process.env named in a block comment",
    source: "/**\n * `process.env` is undefined on Workers.\n */\nconst a = 1;",
    expect: null,
  },
  {
    name: "ignores .transaction( named in a doc comment",
    source: "/** db.transaction() throws on D1. */\nconst a = 1;",
    expect: null,
  },
  {
    name: "ignores a URL that contains // inside a string",
    source: 'const u = "https://example.com"; const k = process.env.X;',
    expect: "no-process-env",
  },
  {
    name: "ignores the rule text inside a string literal",
    source: 'throw new Error("do not use process.env");',
    expect: null,
  },
  /*
   * Template literals. The first four are the bug this stripper was rewritten
   * for: blanking a template literal wholesale hid live code inside `${…}`.
   */
  {
    name: "flags process.env inside a template interpolation",
    source: "const url = `${process.env.APP_URL}/verify`;",
    expect: "no-process-env",
  },
  {
    name: "flags process.env inside a NESTED template interpolation",
    source: "const s = `outer ${`inner ${process.env.X}`} end`;",
    expect: "no-process-env",
  },
  {
    name: "flags .transaction( inside a template interpolation",
    source: "const q = `${await db.transaction(fn)}`;",
    expect: "no-d1-transaction",
  },
  {
    name: "flags process.env in an interpolation containing braces and quotes",
    source: 'const s = `${fn({ a: "}" , b: process.env.X })}`;',
    expect: "no-process-env",
  },
  {
    name: "ignores the rule text in template TEXT, outside any interpolation",
    source: "const help = `never read process.env here`;",
    expect: null,
  },
  {
    name: "ignores rule text in a string INSIDE an interpolation",
    source: 'const s = `${warn("do not use process.env")}`;',
    expect: null,
  },
  {
    name: "ignores a comment inside an interpolation",
    source: "const s = `${value /* process.env is banned */}`;",
    expect: null,
  },
];

/**
 * The stripper reports line numbers by index, so it must be length- and
 * line-preserving. A recursion that ate or added a character would shift every
 * violation below it onto the wrong line.
 */
const INVARIANT_SOURCES = [
  "const a = 1;\nconst b = `x ${process.env.Y}\nspans lines`;\nconst c = 3;\n",
  "const s = `a\\\nb ${ nested(`${deep}`) } c`;\n// trailing comment\n",
  '/* block\n * comment\n */\nconst u = "https://example.com";\n',
];

let selfTestFailures = 0;

for (const source of INVARIANT_SOURCES) {
  const stripped = stripCommentsAndStrings(source);
  const sameLength = stripped.length === source.length;
  const sameLines = stripped.split("\n").length === source.split("\n").length;
  if (!sameLength || !sameLines) {
    console.error(
      `guards self-test FAILED: stripper changed shape (length ${source.length} -> ${stripped.length}, ` +
        `lines ${source.split("\n").length} -> ${stripped.split("\n").length}) — line numbers would be wrong.`,
    );
    selfTestFailures += 1;
  }
}

for (const test of SELF_TESTS) {
  const ids = scanSource(test.source).map((hit) => hit.rule.id);
  const passed = test.expect === null ? ids.length === 0 : ids.includes(test.expect);
  if (!passed) {
    console.error(
      `guards self-test FAILED: ${test.name} (expected ${test.expect ?? "no hits"}, got [${ids.join(", ")}])`,
    );
    selfTestFailures += 1;
  }
}

if (selfTestFailures > 0) {
  console.error(
    `guards: ${selfTestFailures}/${SELF_TESTS.length} self-tests failed — the scanner is broken, so its silence would mean nothing.`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------ scan */

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(extname(entry))) {
      yield full;
    }
  }
}

let violations = 0;
let scanned = 0;

for (const dir of SCAN_DIRS) {
  const absolute = resolve(root, dir);
  for (const file of walk(absolute)) {
    scanned += 1;
    for (const hit of scanSource(readFileSync(file, "utf8"))) {
      console.error(
        `${relative(root, file)}:${hit.line}  [${hit.rule.id}] ${hit.rule.message}\n    ${hit.text}`,
      );
      violations += 1;
    }
  }
}

if (violations > 0) {
  console.error(`\nguards: ${violations} violation(s) across ${scanned} files.`);
  process.exit(1);
}

console.log(
  `guards: ok — ${SELF_TESTS.length} self-tests passed, ${scanned} files scanned in ${SCAN_DIRS.join("/, ")}/, 0 violations.`,
);
