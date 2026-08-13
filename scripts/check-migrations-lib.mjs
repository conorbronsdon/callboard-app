import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const UNJOURNALED_MIGRATION_ALLOWLIST = [
  // Hand-written idempotent backfill, applied by Wrangler and deliberately
  // outside drizzle-kit's snapshot chain.
  "0002_backfill_portal_surface.sql",
  // Hand-written idempotent backfill, applied by Wrangler and deliberately
  // outside drizzle-kit's snapshot chain.
  "0013_backfill_session_revisions.sql",
  // Hand-written idempotent backfill, applied by Wrangler and deliberately
  // outside drizzle-kit's snapshot chain.
  "0014_backfill_speaker_informed.sql",
];

export function unjournaledMigrations(
  migrationsDir,
  allowlist = UNJOURNALED_MIGRATION_ALLOWLIST,
) {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  );
  const journaled = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  const allowed = new Set(allowlist);
  const unjournaled = [];
  const allowlisted = [];

  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    if (journaled.has(name)) continue;
    if (allowed.has(name)) allowlisted.push(name);
    else unjournaled.push(name);
  }

  return { unjournaled, allowlisted };
}
