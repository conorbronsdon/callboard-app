import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unjournaledMigrations } from "./check-migrations-lib.mjs";

let fixtureDir;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "callboard-check-migrations-"));
  mkdirSync(join(fixtureDir, "meta"));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixture(files, tags) {
  for (const file of files) writeFileSync(join(fixtureDir, file), "-- fixture\n");
  writeFileSync(
    join(fixtureDir, "meta", "_journal.json"),
    JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
  );
}

describe("unjournaledMigrations", () => {
  it("MUST FIRE: reports a SQL file absent from the journal", () => {
    writeFixture(["0000_known.sql", "0099_x.sql"], ["0000_known"]);

    expect(unjournaledMigrations(fixtureDir, [])).toEqual({
      unjournaled: ["0099_x.sql"],
      allowlisted: [],
    });
  });

  it("MUST NOT FIRE: moves an explicitly allowed file out of warnings", () => {
    writeFixture(["0000_known.sql", "0099_x.sql"], ["0000_known"]);

    expect(unjournaledMigrations(fixtureDir, ["0099_x.sql"])).toEqual({
      unjournaled: [],
      allowlisted: ["0099_x.sql"],
    });
  });

  it("MUST NOT FIRE: a fully journaled directory produces no findings", () => {
    writeFixture(["0000_known.sql"], ["0000_known"]);

    expect(unjournaledMigrations(fixtureDir, [])).toEqual({
      unjournaled: [],
      allowlisted: [],
    });
  });

  it("pins the repository's three intentional hand-written backfills", () => {
    const migrationsDir = fileURLToPath(new URL("../app/db/migrations", import.meta.url));

    expect(unjournaledMigrations(migrationsDir)).toEqual({
      unjournaled: [],
      allowlisted: [
        "0002_backfill_portal_surface.sql",
        "0013_backfill_session_revisions.sql",
        "0014_backfill_speaker_informed.sql",
      ],
    });
  });
});
