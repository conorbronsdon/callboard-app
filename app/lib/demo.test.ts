import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNTS, DEMO_EVENT_SLUG, DEMO_ROLES } from "./demo";

/**
 * Anchor test. `scripts/seed.mjs` is plain Node (no TS imports), so it hardcodes
 * the demo emails and event slug. If either side is edited alone, the /demo
 * one-click sign-in silently stops finding its accounts — this goes red instead.
 */
const seedSource = readFileSync(
  fileURLToPath(new URL("../../scripts/seed.mjs", import.meta.url)),
  "utf8",
);

describe("demo constants stay in sync with the seed script", () => {
  it("seeds every account /demo can sign in as", () => {
    for (const role of DEMO_ROLES) {
      expect(
        seedSource.includes(`"${DEMO_ACCOUNTS[role].email}"`),
        `scripts/seed.mjs does not create ${DEMO_ACCOUNTS[role].email} (role: ${role})`,
      ).toBe(true);
    }
  });

  it("seeds the demo event slug", () => {
    expect(seedSource.includes(`"${DEMO_EVENT_SLUG}"`)).toBe(true);
  });

  it("guards against a typo passing the check (negative control)", () => {
    // The same assertion with a wrong value must fail, or the test above proves nothing.
    expect(seedSource.includes('"admin@callboard.example"')).toBe(false);
  });

  it("lands each role somewhere that role can actually reach", () => {
    expect(DEMO_ACCOUNTS.admin.landing).toBe("/admin");
    expect(DEMO_ACCOUNTS.speaker.landing).toBe("/portal");
  });
});
