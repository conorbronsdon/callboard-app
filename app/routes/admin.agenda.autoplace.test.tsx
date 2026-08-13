import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { findConflicts } from "~/lib/agenda/conflicts";
import { loadProgramme } from "~/lib/agenda/programme.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { AgendaScreen, action, loader } from "./admin.agenda";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
const BASE = "https://x.test/admin/agenda";
const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function addUnscheduled(id: string, eventId: string, title: string) {
  await ctx.db.insert(sessions).values({
    id,
    eventId,
    title,
    status: "accepted",
    isAbstract: false,
  });
}

describe("agenda auto-place action", () => {
  it("must place remaining sessions in one action and render the result", async () => {
    const first = "auto-route-session-0000-4000-8000-000000000001";
    const second = "auto-route-session-0000-4000-8000-000000000002";
    await addUnscheduled(first, fixture.eventId, "Auto Alpha");
    await addUnscheduled(second, fixture.eventId, "Auto Beta");

    const response = (await action(
      asActionArgs(
        await signedInPost(BASE, fixture.adminId, {
          intent: "auto-place",
          view: "list",
        }),
      ),
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("placed=2");
    expect(response.headers.get("location")).toContain("unplaced=0");

    for (const id of [first, second]) {
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      expect(row?.roomId).toBeTruthy();
      expect(row?.startsAt).toBeInstanceOf(Date);
      expect(row?.endsAt).toBeInstanceOf(Date);
    }
    expect(findConflicts((await loadProgramme(fixture.eventId)).sessions)).toEqual([]);

    const landingUrl = `https://x.test${response.headers.get("location")}`;
    const data = await loader(
      asLoaderArgs(await signedInGet(landingUrl, fixture.adminId)),
    );
    expect(data.notice).toBe(
      "Placed 2 session(s). 0 could not be placed without a conflict.",
    );
    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain("Auto-place remaining");
    expect(markup).toContain(
      "Placed 2 session(s). 0 could not be placed without a conflict.",
    );
  });

  it("must not place an abstract or another event's programme session", async () => {
    const current = "auto-current-session-0000-4000-8000-000000000001";
    const otherSession = "auto-other-session-0000-4000-8000-000000000001";
    const other = await seedOtherEvent(ctx.db);
    await addUnscheduled(current, fixture.eventId, "Current event session");
    await addUnscheduled(otherSession, other.eventId, "Other event session");
    const abstractBefore = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[3]),
    });

    await action(
      asActionArgs(
        await signedInPost(BASE, fixture.adminId, {
          intent: "auto-place",
          view: "list",
        }),
      ),
    );

    const placed = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, current) });
    const untouchedOther = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, otherSession),
    });
    const abstractAfter = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.abstractIds[3]),
    });
    expect(placed?.startsAt).toBeInstanceOf(Date);
    expect(untouchedOther?.startsAt).toBeNull();
    expect(untouchedOther?.roomId).toBeNull();
    expect(abstractAfter?.startsAt).toEqual(abstractBefore?.startsAt);
    expect(abstractAfter?.roomId).toEqual(abstractBefore?.roomId);
  });
});
