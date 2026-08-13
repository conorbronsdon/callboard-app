import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  ADMIN_ID,
  EVENT_ID,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { mayAttachTo } from "./upload-access.server";

const OTHER_EVENT_ID = "event-0000-4000-8000-000000000002";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(events).values({
    id: OTHER_EVENT_ID,
    name: "Another event",
    slug: "another-event",
  });
});
afterEach(() => ctx.close());

describe("upload global person owner boundary", () => {
  it("must NOT fire: a speaker may attach to their own global profile from another event context", async () => {
    await expect(
      mayAttachTo(
        { id: fixture.speakerIds[0], role: "speaker" },
        OTHER_EVENT_ID,
        "person",
        fixture.speakerIds[0],
      ),
    ).resolves.toBe(true);
  });

  it("must fire: a speaker cannot attach to another global person", async () => {
    await expect(
      mayAttachTo(
        { id: fixture.speakerIds[0], role: "speaker" },
        EVENT_ID,
        "person",
        fixture.speakerIds[1],
      ),
    ).resolves.toBe(false);
  });

  it("must NOT fire: a global admin may attach to an existing person outside selected-event membership", async () => {
    // No eventPeople row links this person to OTHER_EVENT_ID. That is
    // intentional: people/profile assets and admin authority are global.
    await expect(
      mayAttachTo(
        { id: ADMIN_ID, role: "admin" },
        OTHER_EVENT_ID,
        "person",
        fixture.speakerIds[0],
      ),
    ).resolves.toBe(true);
  });

  it("must fire: admin authority cannot create an orphan person-owned upload", async () => {
    await expect(
      mayAttachTo(
        { id: ADMIN_ID, role: "admin" },
        EVENT_ID,
        "person",
        "missing-person-id",
      ),
    ).resolves.toBe(false);
  });
});

describe("upload session owner event boundary", () => {
  it("must NOT fire: a speaker may attach to their session in the selected event", async () => {
    await expect(
      mayAttachTo(
        { id: fixture.speakerIds[0], role: "speaker" },
        EVENT_ID,
        "session",
        fixture.abstractIds[0],
      ),
    ).resolves.toBe(true);
  });

  it("must fire: a speaker cannot attach an event-B upload to their event-A session", async () => {
    await expect(
      mayAttachTo(
        { id: fixture.speakerIds[0], role: "speaker" },
        OTHER_EVENT_ID,
        "session",
        fixture.abstractIds[0],
      ),
    ).resolves.toBe(false);
  });

  it("must NOT fire: an admin may attach to a session in the selected event", async () => {
    await expect(
      mayAttachTo(
        { id: ADMIN_ID, role: "admin" },
        EVENT_ID,
        "session",
        fixture.abstractIds[0],
      ),
    ).resolves.toBe(true);
  });

  it("must fire: admin authority cannot create a cross-event owner mismatch", async () => {
    await expect(
      mayAttachTo(
        { id: ADMIN_ID, role: "admin" },
        OTHER_EVENT_ID,
        "session",
        fixture.abstractIds[0],
      ),
    ).resolves.toBe(false);
  });

  it("preserves the same-event participant ownership check", async () => {
    await expect(
      mayAttachTo(
        { id: fixture.speakerIds[1], role: "speaker" },
        EVENT_ID,
        "session",
        fixture.abstractIds[0],
      ),
    ).resolves.toBe(false);
  });
});
