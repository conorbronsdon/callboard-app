/**
 * In-app event creation is load-bearing at three seams: the row must be
 * complete, the selection cookie must put the organizer inside that row, and
 * inserting a newer event must not move the deployment's oldest-event default.
 * Each seam is asserted against the database or the real selection helpers;
 * a redirect by itself is not creation evidence.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { currentEvent, EVENT_COOKIE_NAME, listEvents } from "~/lib/event.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { loader as layoutLoader } from "./admin.layout";
import { action, loader } from "./admin.events.new";

type AnyArgs = { request: Request; params: Record<string, string>; context: unknown };
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

/** A signed-in admin GET, optionally carrying the event-selection cookie. */
async function adminGet(path: string, eventSlug?: string): Promise<Request> {
  const url = `https://x.test${path}`;
  const session = (await createLoginSession(new Request(url), fixture.adminId)).split(";")[0];
  const cookie = eventSlug
    ? `${session}; ${EVENT_COOKIE_NAME}=${encodeURIComponent(eventSlug)}`
    : session;
  return new Request(url, { headers: { cookie } });
}

async function adminPost(
  path: string,
  fields: [string, string][],
  options: { eventSlug?: string; personId?: string } = {},
): Promise<Request> {
  const url = `https://x.test${path}`;
  const session = (
    await createLoginSession(new Request(url), options.personId ?? fixture.adminId)
  ).split(";")[0];
  const cookie = options.eventSlug
    ? `${session}; ${EVENT_COOKIE_NAME}=${encodeURIComponent(options.eventSlug)}`
    : session;
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return new Request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const NEW_SLUG = "agent-systems-summit-2027";
const validFields: [string, string][] = [
  ["name", "  Agent Systems Summit 2027  "],
  ["slug", NEW_SLUG],
  ["location", "  Oakland, CA  "],
  ["startsOn", "2027-04-10"],
  ["endsOn", "2027-04-12"],
  ["timezone", "  America/Los_Angeles  "],
];

async function createEvent(fields = validFields): Promise<Response> {
  return (await action(args(await adminPost("/admin/events/new", fields)) as never)) as Response;
}

async function eventCount(): Promise<number> {
  return (await ctx.db.select({ id: events.id }).from(events)).length;
}

describe("POST /admin/events/new", () => {
  it("creates the complete event and selects it in the admin cookie", async () => {
    const response = await createEvent();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${EVENT_COOKIE_NAME}=${NEW_SLUG}`);
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const row = await ctx.db.query.events.findFirst({ where: eq(events.slug, NEW_SLUG) });
    expect(row).toMatchObject({
      name: "Agent Systems Summit 2027",
      slug: NEW_SLUG,
      location: "Oakland, CA",
      timezone: "America/Los_Angeles",
    });
    expect(row?.startsOn?.toISOString()).toBe("2027-04-10T00:00:00.000Z");
    expect(row?.endsOn?.toISOString()).toBe("2027-04-12T00:00:00.000Z");
  });

  it("keeps the oldest event as default while the creation cookie selects the new one", async () => {
    await createEvent();

    const cookieLess = await adminGet("/admin");
    expect((await currentEvent(cookieLess))?.slug).toBe(EVENT_SLUG);
    expect((await listEvents())[0].slug).toBe(EVENT_SLUG);

    // Complement: this would fail if the action redirected without creating
    // the row, while the two oldest-first assertions above would still pass.
    const selected = await adminGet("/admin", NEW_SLUG);
    expect((await currentEvent(selected))?.slug).toBe(NEW_SLUG);
  });

  it("feeds the new event to the layout and resolves it from the selection cookie", async () => {
    await createEvent();

    const data = await layoutLoader(args(await adminGet("/admin", NEW_SLUG)) as never);
    expect(data.events.map((row) => row.slug)).toContain(NEW_SLUG);
    expect(data.event?.slug).toBe(NEW_SLUG);
  });

  it("rejects a blank name without inserting a row and returns the submitted values", async () => {
    const before = await eventCount();
    const result = await action(
      args(
        await adminPost("/admin/events/new", [
          ["name", "   "],
          ["slug", "kept-on-error"],
          ["location", "San Jose"],
        ]),
      ) as never,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.any(String),
      values: { name: "   ", slug: "kept-on-error", location: "San Jose" },
    });
    expect(await eventCount()).toBe(before);
  });

  it("rejects a name over 120 characters and accepts the boundary", async () => {
    const before = await eventCount();
    const tooLong = await action(
      args(
        await adminPost("/admin/events/new", [
          ["name", "x".repeat(121)],
          ["slug", "too-long"],
        ]),
      ) as never,
    );
    expect(tooLong).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await eventCount()).toBe(before);

    const response = await createEvent([
      ["name", "x".repeat(120)],
      ["slug", "exactly-120"],
    ]);
    expect(response.status).toBe(302);
    expect(await eventCount()).toBe(before + 1);
  });

  it("returns a clean validation result for a slug collision", async () => {
    const before = await eventCount();
    const result = await action(
      args(
        await adminPost("/admin/events/new", [
          ["name", "Duplicate event"],
          ["slug", EVENT_SLUG],
        ]),
      ) as never,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(result).not.toBeInstanceOf(Response);
    expect(await eventCount()).toBe(before);
    const matches = await ctx.db.select().from(events).where(eq(events.slug, EVENT_SLUG));
    expect(matches).toHaveLength(1);
  });

  it("rejects an end date before the start date and inserts nothing", async () => {
    const before = await eventCount();
    const result = await action(
      args(
        await adminPost("/admin/events/new", [
          ["name", "Backwards dates"],
          ["slug", "backwards-dates"],
          ["startsOn", "2027-04-12"],
          ["endsOn", "2027-04-10"],
        ]),
      ) as never,
    );

    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await eventCount()).toBe(before);
  });

  it("derives and normalizes the slug when the field is blank", async () => {
    const response = await createEvent([
      ["name", "  Mixed CASE! Product + AI Summit  "],
      ["slug", ""],
      ["location", "   "],
      ["timezone", "   "],
    ]);

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain(
      `${EVENT_COOKIE_NAME}=mixed-case-product-ai-summit`,
    );
    const row = await ctx.db.query.events.findFirst({
      where: eq(events.slug, "mixed-case-product-ai-summit"),
    });
    expect(row).toMatchObject({
      name: "Mixed CASE! Product + AI Summit",
      location: null,
      timezone: "America/Los_Angeles",
      startsOn: null,
      endsOn: null,
    });
  });

  it("rejects a derived slug with no letters or numbers", async () => {
    const before = await eventCount();
    const result = await action(
      args(
        await adminPost("/admin/events/new", [
          ["name", "!!!"],
          ["slug", ""],
        ]),
      ) as never,
    );
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await eventCount()).toBe(before);
  });
});

describe("admin authorization", () => {
  it("rejects a signed-in non-admin from both the action and loader", async () => {
    const speakerId = fixture.speakerIds[0];
    await expect(
      action(
        args(
          await adminPost("/admin/events/new", validFields, {
            personId: speakerId,
          }),
        ) as never,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const request = await adminGet("/admin/events/new");
    const speakerCookie = (
      await createLoginSession(new Request(request.url), speakerId)
    ).split(";")[0];
    await expect(
      loader(args(new Request(request.url, { headers: { cookie: speakerCookie } })) as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/* Keeps the unused-type lint honest — `args` is deliberately loose. */
export type _AnyArgs = AnyArgs;
