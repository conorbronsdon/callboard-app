#!/usr/bin/env node
/**
 * Generate migrations and fail if the committed migration directory changes.
 * `git diff` alone misses newly generated untracked migration files.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { unjournaledMigrations } from "./check-migrations-lib.mjs";

const shell = process.platform === "win32";
const MIGRATIONS_DIR = "app/db/migrations";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

/*
 * `drizzle-kit generate` exits 0 even when it could not LOAD the schema.
 * app/db/schema.ts briefly imported a `~/…` alias drizzle-kit cannot resolve;
 * it printed "Cannot find module", generated nothing, exited 0, and this
 * script went on to compare an unchanged migrations directory against itself
 * and declare "ok: migrations are up to date". The exit code is therefore not
 * evidence — the generator has to say it did the work.
 */
const generated = run("npm", ["run", "db:generate"], { capture: true });
process.stdout.write(generated);

const DID_WORK = ["No schema changes", "Your SQL migration file"];
const outcome = DID_WORK.find((marker) => generated.includes(marker));
if (!outcome) {
  console.error(
    "drizzle-kit did not report a generation outcome — it likely failed to load " +
      "app/db/schema.ts and exited 0 anyway. Expected one of: " +
      DID_WORK.map((marker) => JSON.stringify(marker)).join(", "),
  );
  process.exit(1);
}
if (/(^|\n)Error:/.test(generated) || generated.includes("MODULE_NOT_FOUND")) {
  console.error("drizzle-kit reported an error while loading the schema (and still exited 0).");
  process.exit(1);
}
/*
 * Name the branch we took. "ok: migrations are up to date" is printed on BOTH
 * outcomes, so on its own it cannot tell a reader whether drizzle-kit compared
 * the schema and found nothing, or wrote a brand new migration that happens to
 * already be committed. Print the marker that was actually matched.
 */
console.log(`migrations:check: drizzle-kit outcome ➜ ${JSON.stringify(outcome)}`);

/*
 * Wrangler reads the migration DIRECTORY configured by `migrations_dir`,
 * applies its `.sql` files in filename order, and records them in D1's
 * `d1_migrations` table; it never reads `meta/_journal.json`. The journal is
 * drizzle-kit's bookkeeping, written by `drizzle-kit generate` and read to
 * locate the last generated snapshot. The systems therefore key off different
 * state: a SQL file can be applied by Wrangler while remaining invisible to
 * drizzle-kit. Conversely, drizzle-kit compares SNAPSHOTS, so a journal tag
 * pointing at a missing file still produces "No schema changes" and a clean
 * `git status`. That is why the journal-to-disk direction below must go red.
 */
const journalPath = `${MIGRATIONS_DIR}/meta/_journal.json`;
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const onDisk = new Set(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")));
const journalProblems = [];
journal.entries.forEach((entry, position) => {
  if (entry.idx !== position) {
    journalProblems.push(`entry ${position} carries idx ${entry.idx} — the journal is not contiguous`);
  }
  const prefix = String(entry.idx).padStart(4, "0");
  if (!entry.tag.startsWith(`${prefix}_`)) {
    journalProblems.push(`idx ${entry.idx} is tagged "${entry.tag}", which does not start with "${prefix}_"`);
  }
  if (!onDisk.has(`${entry.tag}.sql`)) {
    journalProblems.push(`idx ${entry.idx} points at ${entry.tag}.sql, which is not in ${MIGRATIONS_DIR}`);
  }
});
if (journalProblems.length > 0) {
  console.error(`${journalPath} does not match the migration files on disk:`);
  for (const problem of journalProblems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`migrations:check: journal maps ${journal.entries.length} entries onto files on disk`);

const { unjournaled, allowlisted } = unjournaledMigrations(MIGRATIONS_DIR);
if (allowlisted.length > 0) {
  console.log(`migrations:check: skipping allowlisted unjournaled files: ${allowlisted.join(", ")}`);
}
if (unjournaled.length > 0) {
  console.error(
    "migrations:check: warning: SQL files exist on disk without drizzle journal entries:",
  );
  for (const name of unjournaled) console.error(`  - ${name}`);
}

const changes = run("git", ["status", "--porcelain", "--", "app/db/migrations"], {
  capture: true,
}).trim();

if (changes) {
  console.error("app/db/schema.ts and committed migrations differ. Run: npm run db:generate");
  console.error(changes);
  process.exit(1);
}

console.log("ok: migrations are up to date");
