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

  it("MUST FIRE: a selection naming only ids that resolve to nothing is 404, not an empty 200", async () => {
    // The reported paper-cut: a garbage id downloaded a valid, empty calendar.
    await expect(load("not-a-uuid")).rejects.toMatchObject({ status: 404 });
    // Well-formed but unknown takes the same answer — the codebase 404s unknown
    // ids on every other public route, and a uniform reply is also what keeps
    // this from becoming an existence oracle for unpublished sessions.
    await expect(load("invalid0-0000-4000-8000-00000000dead")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("MUST NOT FIRE: a stale selection still exports the sessions that DO resolve", async () => {
    /*
     * The complement of the 404 above, and the reason it is not a blanket
     * rule: an attendee whose saved itinerary has gone partly stale must still
     * get the sessions that are live, not an error page. This is also the test
     * that would catch "throw 404 whenever anything is missing".
     */
    const { response, body } = await load(
      [fixture.programSessionIds[0], "invalid0-0000-4000-8000-00000000dead"].join(","),
    );
    expect(response.status).toBe(200);
    expect(icsValues(parseIcs(body), "SUMMARY")).toEqual([
      "Shipping agents that survive contact with users",
    ]);
  });

  it("MUST NOT FIRE: the whole-event feed stays 200 even with nothing published", async () => {
    // A subscribed calendar client polling before the schedule goes live wants
    // an empty calendar, not a hard error.
    await ctx.db.update(sessions).set({ isPublic: false });
    const { response, body } = await load();
    expect(response.status).toBe(200);
    expect(icsValues(parseIcs(body), "SUMMARY")).toEqual([]);
  });

  it("MUST FIRE: unpublished, abstract, deleted and other-event ids leak nothing and 404", async () => {
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

    /*
     * These four resolve to nothing for four different reasons, and every one
     * of them now answers exactly as a garbage id does. The content assertion
     * this test used to make (no SUMMARY leaks) is strictly preserved by a
     * 404 — a thrown response carries no session data at all — while the
     * uniform status is what stops the reply from distinguishing "unpublished"
     * from "never existed".
     */
    await expect(
      load([unpublishedId, fixture.abstractIds[0], deletedId, other.programSessionId].join(",")),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: an explicitly empty selection is a valid empty calendar", async () => {
    const { response, body } = await load("");
    expect(response.status).toBe(200);
    expect(icsValues(parseIcs(body), "SUMMARY")).toEqual([]);
  });

  /*
   * REGRESSION TEST for GitHub issue #199 (blindspot audit). Fixed in
   * app/routes/public.calendar.ts: the loader used to set no `cache-control`
   * at all — only `Content-Type` and `Content-Disposition` (asserted above).
   * This URL is STABLE while its content is not: session times, rooms,
   * titles, publication state, and speakers can all change after an attendee
   * has downloaded or subscribed to this exact `.ics` URL. Every other
   * live-D1 export route in this codebase — app/routes/
   * admin.integrations.csv.ts, app/routes/admin.submissions.scores.csv.ts —
   * already set `cache-control: no-store` for exactly this reason; this route
   * now matches.
   *
   * `Content-Disposition: attachment` has no caching semantics of its own —
   * it does not make a response any less cacheable. With no cache-control and
   * no validator (no ETag/Last-Modified either), an intermediary or browser
   * was otherwise free to apply HTTP heuristic freshness (RFC 9111 §4.2.2)
   * and reuse a stale copy.
   */
  it("the mutable schedule export sets cache-control: no-store, matching the CSV export routes (#199)", async () => {
    const { response } = await load();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
