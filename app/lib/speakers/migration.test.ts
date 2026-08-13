import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Renumbered 0003 → 0004 when this branch rebased onto a main that had landed
 * its own 0003 (`0003_smiling_killraven`, ALTER reviews ADD recused_at). The
 * migration was REGENERATED from schema.ts on the rebased tree rather than
 * renamed by hand, so the journal and snapshot agree with the filename.
 */
const migrationPath = resolve("app/db/migrations/0004_stormy_terrax.sql");

describe("speaker status migration", () => {
  it("is one additive column with a non-null invited default", () => {
    const sql = readFileSync(migrationPath, "utf8").trim();

    expect(sql).toBe(
      "ALTER TABLE `event_people` ADD `status` text DEFAULT 'invited' NOT NULL;",
    );
    expect(sql.toUpperCase()).not.toContain("DROP");
    expect(sql.toUpperCase()).not.toContain("CREATE TABLE");
    expect(sql.toUpperCase()).not.toContain("INSERT INTO");
  });
});
