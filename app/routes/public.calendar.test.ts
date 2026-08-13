import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { icsValues, parseIcs } from "~/lib/comms/ics";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";
import { loader } from "./public.calendar";

type LoaderArgs = Parameters<typeof loader>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(selection?: string): Promise<{ response: Response; body: string }> {
  const query = selection === undefined ? "" : `?s=${encodeURIComponent(selection)}`;
  const response = await loader({
    request: new Request(`https://calendar.test/e/${EVENT_SLUG}/schedule.ics${query}`),
    params: { slug: EVENT_SLUG },
    context: {},
  } as unknown as LoaderArgs);
  return { response, body: await response.text() };
}

describe("public calendar feed", () => {
  it("MUST FIRE: a two-id subset returns two parsed VEVENTs and download headers", async () => {
    const { response, body } = await load(fixture.programSessionIds.join(","));
    const properties = parseIcs(body);
    expect(icsValues(properties, "BEGIN").filter((value) => value === "VEVENT")).toHaveLength(2);
    expect(icsValues(properties, "SUMMARY")).toEqual([
      "Shipping agents that survive contact with users",
      "Evals that actually predict production failures",
    ]);
    expect(icsValues(properties, "DTSTART")).toEqual([
      "20261007T220000Z",
      "20261007T230000Z",
    ]);
    expect(icsValues(properties, "DTEND")).toEqual([
      "20261007T223000Z",
      "20261007T233000Z",
    ]);
    expect(icsValues(properties, "LOCATION")).toEqual(["Main Stage", "Workshop Room 1"]);
    expect(icsValues(properties, "DESCRIPTION")[0]).toContain(
      "Speakers: Sam Speaker (Demo Speaker\\, Company 0)",
    );
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${EVENT_SLUG}-schedule.ics"`,
    );
    expect(body).toMatch(/\r\n$/);
    expect(body.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("MUST FIRE: no selection includes the whole published schedule", async () => {
    const { body } = await load();
    expect(icsValues(parseIcs(body), "SUMMARY")).toEqual([
      "Shipping agents that survive contact with users",
      "Evals that actually predict production failures",
    ]);
  });

  it("uses the documented 60-minute end when the database end is missing", async () => {
    await ctx.db
      .update(sessions)
      .set({ endsAt: null })
      .where(eq(sessions.id, fixture.programSessionIds[0]));
    const { body } = await load(fixture.programSessionIds[0]);
    expect(icsValues(parseIcs(body), "DTEND")).toEqual(["20261007T230000Z"]);
  });

  it("MUST NOT FIRE: unpublished, abstract, deleted and other-event ids yield no events", async () => {
    const unpublishedId = "invalid0-0000-4000-8000-000000000001";
    const deletedId = "invalid0-0000-4000-8000-000000000002";
    const startsAt = new Date("2026-10-08T18:00:00Z");
    await ctx.db.insert(sessions).values([
      {
        id: unpublishedId,
        eventId: fixture.eventId,
        title: "Hidden draft",
        isAbstract: false,
        isPublic: false,
        startsAt,
      },
      {
        id: deletedId,
        eventId: fixture.eventId,
        title: "Deleted public session",
        isAbstract: false,
        isPublic: true,
        startsAt,
        deletedAt: new Date("2026-08-12T00:00:00Z"),
      },
    ]);
    await ctx.db
      .update(sessions)
      .set({ isPublic: true, startsAt })
      .where(eq(sessions.id, fixture.abstractIds[0]));
    const other = await seedOtherEvent(ctx.db);

    const { body } = await load(
      [unpublishedId, fixture.abstractIds[0], deletedId, other.programSessionId].join(","),
    );
    const properties = parseIcs(body);
    expect(icsValues(properties, "BEGIN").filter((value) => value === "VEVENT")).toEqual([]);
    expect(icsValues(properties, "SUMMARY")).toEqual([]);
  });

  it("MUST NOT FIRE: an explicitly empty selection is a valid empty calendar", async () => {
    const { response, body } = await load("");
    expect(response.status).toBe(200);
    expect(icsValues(parseIcs(body), "SUMMARY")).toEqual([]);
  });
});
