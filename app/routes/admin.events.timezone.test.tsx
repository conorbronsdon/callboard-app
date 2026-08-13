/**
 * `events.timezone` is free text on two organizer screens and it is read by the
 * PUBLIC HOME loader, which formats every listed event's dates in that zone.
 * `Intl` throws `RangeError` on a zone it does not know, so one organizer
 * typing "Pacific" instead of "America/Los_Angeles" used to serve the root
 * ErrorBoundary — a 500 on the front page — to every visitor of the site.
 *
 * The fix is two-sided and so is this file:
 *   WRITE — both screens reject a zone `Intl` cannot use, as a field error.
 *   READ  — a bad value already in the table degrades to a dateless card.
 *
 * The read half deliberately writes the bad zone STRAIGHT INTO THE TABLE with
 * drizzle rather than through the form, because the point is the row that got
 * there before the validation existed. A test that could only produce a bad row
 * through the form would go green the moment the form was fixed and stop
 * measuring the loader at all.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as createEventAction } from "./admin.events.new";
import { action as settingsAction } from "./admin.settings";
import { loader as homeLoader } from "./public.home";

const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function adminPost(path: string, fields: [string, string][]): Promise<Request> {
  const url = `https://x.test${path}`;
  const session = (await createLoginSession(new Request(url), fixture.adminId)).split(";")[0];
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return new Request(url, {
    method: "POST",
    headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/** `/admin/events/new` with a name and slug derived from the zone under test. */
async function createWithTimezone(timezone: string, slug: string) {
  return createEventAction(
    args(
      await adminPost("/admin/events/new", [
        ["name", `Event ${slug}`],
        ["slug", slug],
        ["startsOn", "2027-04-10"],
        ["endsOn", "2027-04-12"],
        ["timezone", timezone],
      ]),
    ),
  );
}

/** `/admin/settings` saving the seeded event with a different zone. */
async function saveSettingsTimezone(timezone: string) {
  return settingsAction(
    args(
      await adminPost("/admin/settings", [
        ["name", "Frontier AI Summit 2026"],
        ["slug", EVENT_SLUG],
        ["timezone", timezone],
      ]),
    ),
  );
}

const timezoneOf = async (slug: string) =>
  (await ctx.db.query.events.findFirst({ where: eq(events.slug, slug) }))?.timezone;

const BAD_ZONE = "Pacific";

describe("the bad zone is genuinely bad", () => {
  it("CONTROL: Intl rejects it and accepts the zones the must-still-fire cases use", () => {
    // Without this, a build whose ICU happened to accept "Pacific" would make
    // every assertion below pass for the wrong reason.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: BAD_ZONE })).toThrow(RangeError);
    for (const zone of ["America/Los_Angeles", "US/Pacific", "PST"]) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone).not.toThrow();
    }
  });
});

describe("WRITE: /admin/events/new validates the timezone", () => {
  it("MUST FIRE: a typo'd zone is a field error and no row is written", async () => {
    // Red on the unfixed tree: this returned a 302 and stored "Pacific".
    const before = (await ctx.db.select({ id: events.id }).from(events)).length;
    const result = await createWithTimezone(BAD_ZONE, "typo-zone");

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(BAD_ZONE),
      values: { timezone: BAD_ZONE },
    });
    expect((await ctx.db.select({ id: events.id }).from(events)).length).toBe(before);
    expect(await timezoneOf("typo-zone")).toBeUndefined();
  });

  it("MUST FIRE: a UTC-offset string is refused too", async () => {
    expect(await createWithTimezone("GMT+2", "offset-zone")).toMatchObject({ ok: false });
    expect(await timezoneOf("offset-zone")).toBeUndefined();
  });

  it("MUST STILL FIRE: the IANA names and aliases people type are accepted", async () => {
    // The complement. A validator that rejected everything would pass the two
    // cases above; these are the values that must keep working, including the
    // legacy aliases `Intl` still resolves.
    for (const [index, zone] of ["America/Los_Angeles", "US/Pacific", "PST"].entries()) {
      const slug = `good-zone-${index}`;
      const response = (await createWithTimezone(zone, slug)) as Response;
      expect(response.status, zone).toBe(302);
      expect(await timezoneOf(slug), zone).toBe(zone);
    }
  });

  it("MUST STILL FIRE: a blank field still takes the default", async () => {
    const response = (await createWithTimezone("   ", "blank-zone")) as Response;
    expect(response.status).toBe(302);
    expect(await timezoneOf("blank-zone")).toBe("America/Los_Angeles");
  });
});

describe("WRITE: /admin/settings validates the same field", () => {
  it("MUST FIRE: saving a typo'd zone reports an error and changes nothing", async () => {
    // Red on the unfixed tree: settings accepted any non-empty string, so the
    // edit screen could break the front page even with the create screen fixed.
    const before = await timezoneOf(EVENT_SLUG);
    expect(await saveSettingsTimezone(BAD_ZONE)).toMatchObject({
      ok: false,
      error: expect.stringContaining(BAD_ZONE),
    });
    expect(await timezoneOf(EVENT_SLUG)).toBe(before);
  });

  it("MUST STILL FIRE: a valid zone still saves", async () => {
    expect(await saveSettingsTimezone("Europe/Amsterdam")).toMatchObject({ ok: true });
    expect(await timezoneOf(EVENT_SLUG)).toBe("Europe/Amsterdam");
  });
});

describe("READ: the public home page survives a bad zone already in the table", () => {
  /** Bypass validation the way a pre-fix row, a migration or psql would. */
  async function poisonSeededEvent() {
    await ctx.db
      .update(events)
      .set({ timezone: BAD_ZONE, startsOn: new Date("2027-04-10T00:00:00Z"), endsOn: null })
      .where(eq(events.id, EVENT_ID));
  }

  it("MUST FIRE: the loader returns the event with no dates instead of throwing", async () => {
    // Red on the unfixed tree: this threw RangeError, which React Router turns
    // into the root ErrorBoundary — "Something went wrong (500)" on `/`.
    await poisonSeededEvent();

    const data = await homeLoader(args(new Request("https://x.test/")));
    const poisoned = data.events.find((event) => event.slug === EVENT_SLUG);

    expect(poisoned).toBeDefined();
    expect(poisoned?.dates).toBeNull();
    expect(poisoned?.name).toBe("Frontier AI Summit 2026");
  });

  it("MUST FIRE: the page still renders the event, without a date line", async () => {
    await poisonSeededEvent();
    const markup = await homeMarkup();

    // `toContain` on raw markup: match the leading words of the seeded name
    // rather than the full string, so the year can't drift the assertion.
    expect(markup).toContain("Frontier AI Summit");
    expect(markup).toContain(`/e/${EVENT_SLUG}`);
    expect(markup).not.toContain("Something went wrong");
    expect(markup).not.toContain("2027");
  });

  it("MUST STILL FIRE: a valid zone still puts the dates on the card", async () => {
    // The complement that catches a "fix" which simply stopped showing dates.
    await ctx.db
      .update(events)
      .set({ timezone: "UTC", startsOn: new Date("2027-04-10T00:00:00Z"), endsOn: null })
      .where(eq(events.id, EVENT_ID));

    const data = await homeLoader(args(new Request("https://x.test/")));
    expect(data.events.find((event) => event.slug === EVENT_SLUG)?.dates).toBe("Apr 10, 2027");
    expect(await homeMarkup()).toContain("Apr 10, 2027");
  });
});

/** The home page uses `Shell`, whose NavLink needs a router — stub one. */
async function homeMarkup(): Promise<string> {
  const data = await homeLoader(args(new Request("https://x.test/")));
  const { default: PublicHome } = await import("./public.home");
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () =>
        PublicHome({ loaderData: data } as unknown as Parameters<typeof PublicHome>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}
