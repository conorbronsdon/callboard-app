/**
 * Rooms config: CRUD rules with must-fire and must-not-fire, plus the zero
 * state (a fresh event has no rooms and the Day board is unusable until it does).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rooms, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { RoomsScreen, action, loader } from "./admin.agenda.rooms";
import type { RoomsData } from "./admin.agenda.rooms";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const BASE = "https://x.test/admin/agenda/rooms";
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

async function load(url = BASE): Promise<RoomsData> {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}
async function post(fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(BASE, fixture.adminId, fields)));
}

describe("loader", () => {
  it("lists the seeded rooms with capacity and assigned-session counts", async () => {
    const data = await load();
    expect(data.rooms.map((room) => room.name)).toEqual([
      "Main Stage",
      "Workshop Room 1",
      "Workshop Room 2",
    ]);
    expect(data.rooms[0].capacity).toBe(800);
    // Two seeded programme sessions, one in each of the first two rooms.
    expect(data.rooms.map((room) => room.sessionCount)).toEqual([1, 1, 0]);
  });
});

describe("action: create", () => {
  it("MUST FIRE: adds a room that the agenda can then use", async () => {
    const response = (await post({
      intent: "create",
      name: "Expo Theatre",
      capacity: "250",
    })) as Response;
    expect(response.status).toBe(302);

    const data = await load();
    const created = data.rooms.find((room) => room.name === "Expo Theatre");
    expect(created?.capacity).toBe(250);
    expect(created?.sessionCount).toBe(0);
  });

  it("accepts a room with no capacity", async () => {
    await post({ intent: "create", name: "Hallway Track", capacity: "" });
    const data = await load();
    expect(data.rooms.find((room) => room.name === "Hallway Track")?.capacity).toBeNull();
  });

  it("MUST NOT FIRE: a blank name, or a duplicate", async () => {
    expect(await post({ intent: "create", name: "   " })).toMatchObject({ ok: false });
    expect(await post({ intent: "create", name: "Main Stage" })).toMatchObject({
      ok: false,
    });
    expect((await load()).rooms).toHaveLength(3);
  });

  it("MUST NOT FIRE: an unknown intent", async () => {
    expect(await post({ intent: "truncate" })).toMatchObject({ ok: false });
  });
});

describe("action: update", () => {
  it("MUST FIRE: renames and re-caps a room", async () => {
    const target = fixture.roomIds[1];
    await post({
      intent: "update",
      roomId: target,
      name: "Workshop Room A",
      capacity: "90",
    });

    const row = await ctx.db.query.rooms.findFirst({ where: eq(rooms.id, target) });
    expect(row?.name).toBe("Workshop Room A");
    expect(row?.capacity).toBe(90);
  });

  it("MUST NOT FIRE: a blank name, or a room id from another event", async () => {
    const target = fixture.roomIds[1];
    expect(await post({ intent: "update", roomId: target, name: "" })).toMatchObject({
      ok: false,
    });
    expect(
      await post({ intent: "update", roomId: "not-a-room", name: "Anything" }),
    ).toMatchObject({ ok: false });

    const row = await ctx.db.query.rooms.findFirst({ where: eq(rooms.id, target) });
    expect(row?.name).toBe("Workshop Room 1");
  });
});

describe("action: delete", () => {
  it("MUST FIRE: removes the room and returns its sessions to the no-room bucket", async () => {
    const target = fixture.roomIds[0];
    const response = (await post({ intent: "delete", roomId: target })) as Response;
    expect(response.status).toBe(302);

    expect(await ctx.db.query.rooms.findFirst({ where: eq(rooms.id, target) })).toBeUndefined();

    // The session survives with room_id NULL (ON DELETE SET NULL) — it is not deleted.
    const session = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[0]),
    });
    expect(session).toBeDefined();
    expect(session?.roomId).toBeNull();
    expect(session?.startsAt).not.toBeNull();
  });

  it("MUST NOT FIRE: a room id that is not on this event", async () => {
    expect(await post({ intent: "delete", roomId: "nope" })).toMatchObject({ ok: false });
    expect((await load()).rooms).toHaveLength(3);
  });
});

describe("render", () => {
  it("renders the seeded rooms with an add form", async () => {
    const markup = renderToStaticMarkup(<RoomsScreen {...(await load())} />);
    expect(markup).toContain("Main Stage");
    expect(markup).toContain("Add room");
    expect(markup).toContain(`data-room-row="${fixture.roomIds[0]}"`);
  });

  it("renders the zero state when the event has no rooms", async () => {
    await ctx.db.delete(rooms);
    const markup = renderToStaticMarkup(<RoomsScreen {...(await load())} />);
    expect(markup).toContain("No rooms yet");
    expect(markup).toContain("Add room");
  });

  it("renders the no-event state", () => {
    const markup = renderToStaticMarkup(
      <RoomsScreen event={null} rooms={[]} notice={null} />,
    );
    expect(markup).toContain("rooms belong to an event");
    expect(markup).not.toContain("npm run seed");
  });
});
