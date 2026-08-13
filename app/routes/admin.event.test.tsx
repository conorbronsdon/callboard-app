/**
 * WS12 — multi-event administration.
 *
 * Three things have to hold, and each one is asserted against BOTH events so a
 * "returns event A's rows for everything" implementation cannot pass:
 *
 *   1. every major admin loader scoped to event B returns zero event-A rows,
 *      and vice versa;
 *   2. an action fired from an event-B page writes an event-B row — the loader
 *      and the action must agree about which event the organizer is looking at;
 *   3. the switcher renders only when there is something to switch between, and
 *      exists in exactly one route module (the admin layout), so the portal,
 *      reviewer and public surfaces cannot grow one by accident.
 *
 * The cookie's own resolution rules — precedence, tampering, the /admin scope —
 * live in app/lib/event.server.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewTeams } from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { EVENT_COOKIE_NAME, safeAdminRedirect } from "~/lib/event.server";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  ADMIN_EMAIL,
  EVENT_SLUG,
  OTHER_EVENT_NAME,
  OTHER_EVENT_SLUG,
  SPEAKERS,
  SUBMISSIONS,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";

import { loader as agendaLoader } from "./admin.agenda";
import { loader as commsLoader } from "./admin.comms";
import { action as eventAction } from "./admin.event";
import { loader as dashboardLoader } from "./admin.index";
import { EventSwitcher, loader as layoutLoader } from "./admin.layout";
import { action as reviewsAction, loader as reviewsLoader } from "./admin.reviews";
import { loader as speakersLoader } from "./admin.speakers";
import { loader as submissionsLoader } from "./admin.submissions";

type AnyArgs = { request: Request; params: Record<string, string>; context: unknown };
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;

const EVENT_A_TEAM = "12000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
  // Both events need review teams, or "event B's teams do not leak into A"
  // would pass against an empty list and prove nothing.
  await ctx.db
    .insert(reviewTeams)
    .values({ id: EVENT_A_TEAM, eventId: fixture.eventId, name: "Frontier AI Summit committee" });
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

/* ══════════════════════════════════ 1. loader isolation, both directions ══ */

/** Titles that exist ONLY on the primary event, and only on the other one. */
const EVENT_A_TITLES = SUBMISSIONS.map(([title]) => title);
const EVENT_B_TITLES = [
  "Running inference on a European latency budget",
  "Retrieval that survives four languages",
];

async function submissionTitles(eventSlug?: string): Promise<string[]> {
  const tabs = [
    "accepted",
    "accept_queue",
    "pending",
    "decline_queue",
    "declined",
    "withdrawn",
    "draft",
  ];
  const titles: string[] = [];
  for (const tab of tabs) {
    const data = await submissionsLoader(
      args(await adminGet(`/admin/submissions?tab=${tab}`, eventSlug)) as never,
    );
    titles.push(...data.rows.map((row) => row.title));
  }
  return titles;
}

describe("admin loaders are scoped to the selected event", () => {
  it("dashboard counts move to the selected event and only report its rows", async () => {
    const primary = await dashboardLoader(args(await adminGet("/admin")) as never);
    expect(primary.event?.slug).toBe(EVENT_SLUG);
    expect(primary.counts).toMatchObject({ abstracts: 8, accepted: 2, openTasks: 4 });

    const selected = await dashboardLoader(
      args(await adminGet("/admin", OTHER_EVENT_SLUG)) as never,
    );
    expect(selected.event?.name).toBe(OTHER_EVENT_NAME);
    // Different numbers on purpose: matching counts could not tell the two
    // events apart.
    expect(selected.counts).toMatchObject({ abstracts: 2, accepted: 1, openTasks: 1 });
  });

  it("submissions returns each event's abstracts and none of the other's", async () => {
    const primary = await submissionTitles();
    expect(primary).toEqual(expect.arrayContaining(EVENT_A_TITLES));
    for (const title of EVENT_B_TITLES) expect(primary).not.toContain(title);

    const selected = await submissionTitles(OTHER_EVENT_SLUG);
    expect(selected.sort()).toEqual([...EVENT_B_TITLES].sort());
    for (const title of EVENT_A_TITLES) expect(selected).not.toContain(title);
  });

  it("review ops shows the selected event's teams and rounds only", async () => {
    const primary = await reviewsLoader(args(await adminGet("/admin/reviews")) as never);
    expect(primary.teams.map((team) => team.name)).toEqual(["Frontier AI Summit committee"]);
    expect(primary.rounds).toHaveLength(0);

    const selected = await reviewsLoader(
      args(await adminGet("/admin/reviews", OTHER_EVENT_SLUG)) as never,
    );
    expect(selected.teams.map((team) => team.name)).toEqual(["Europe programme committee"]);
    expect(selected.rounds.map((round) => round.name)).toEqual(["Europe screening"]);
  });

  it("the agenda board shows the selected event's programme only", async () => {
    const primary = await agendaLoader(args(await adminGet("/admin/agenda")) as never);
    expect(primary.rows.map((row) => row.friendlyId)).toEqual(["SESS-1", "SESS-2"]);

    const selected = await agendaLoader(
      args(await adminGet("/admin/agenda", OTHER_EVENT_SLUG)) as never,
    );
    expect(selected.event?.name).toBe(OTHER_EVENT_NAME);
    expect(selected.rows.map((row) => row.friendlyId)).toEqual(["EU-SESS-1"]);
    expect(selected.rows.map((row) => row.roomName)).toEqual(["Zuiderzaal"]);
  });

  it("the speaker roster does not blend the two events", async () => {
    const primary = await speakersLoader(args(await adminGet("/admin/speakers")) as never);
    const primaryEmails = primary.speakers.map((row) => row.email);
    expect(primaryEmails).toEqual(expect.arrayContaining(SPEAKERS.map((s) => s.email)));
    expect(primaryEmails).not.toContain("ines.duarte@example.eu");

    const selected = await speakersLoader(
      args(await adminGet("/admin/speakers", OTHER_EVENT_SLUG)) as never,
    );
    // Exactly the organizer plus the one Europe speaker.
    expect(selected.speakers.map((row) => row.email).sort()).toEqual(
      [ADMIN_EMAIL, "ines.duarte@example.eu"].sort(),
    );
  });

  it("the comms roster follows the selection too", async () => {
    const primary = await commsLoader(args(await adminGet("/admin/comms")) as never);
    expect(primary.people.map((row) => row.email)).not.toContain("ines.duarte@example.eu");

    const selected = await commsLoader(
      args(await adminGet("/admin/comms", OTHER_EVENT_SLUG)) as never,
    );
    expect(selected.event?.name).toBe(OTHER_EVENT_NAME);
    expect(selected.people.map((row) => row.email).sort()).toEqual(
      [ADMIN_EMAIL, "ines.duarte@example.eu"].sort(),
    );
    for (const speaker of SPEAKERS) {
      expect(selected.people.map((row) => row.email)).not.toContain(speaker.email);
    }
  });
});

/* ══════════════════════════════ 2. action / loader pair consistency ══════ */

describe("an action resolves the same event as the page it was fired from", () => {
  it("writes to event B when the organizer is looking at event B", async () => {
    const response = await reviewsAction(
      args(
        await adminPost(
          "/admin/reviews",
          [
            ["intent", "create-team"],
            ["name", "Amsterdam screening crew"],
          ],
          { eventSlug: OTHER_EVENT_SLUG },
        ),
      ) as never,
    );
    expect((response as Response).status).toBe(302);

    const rows = await ctx.db
      .select()
      .from(reviewTeams)
      .where(eq(reviewTeams.name, "Amsterdam screening crew"));
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(other.eventId);
    // Must NOT fire: the row did not land on the default event.
    expect(rows[0].eventId).not.toBe(fixture.eventId);

    // And the event-B page it came from now shows it, while event A does not.
    const selected = await reviewsLoader(
      args(await adminGet("/admin/reviews", OTHER_EVENT_SLUG)) as never,
    );
    expect(selected.teams.map((team) => team.name).sort()).toEqual(
      ["Amsterdam screening crew", "Europe programme committee"].sort(),
    );
    const primary = await reviewsLoader(args(await adminGet("/admin/reviews")) as never);
    expect(primary.teams.map((team) => team.name)).toEqual(["Frontier AI Summit committee"]);
  });

  it("writes to the default event when nothing is selected", async () => {
    await reviewsAction(
      args(
        await adminPost("/admin/reviews", [
          ["intent", "create-team"],
          ["name", "Default lane crew"],
        ]),
      ) as never,
    );
    const [row] = await ctx.db
      .select()
      .from(reviewTeams)
      .where(eq(reviewTeams.name, "Default lane crew"));
    expect(row.eventId).toBe(fixture.eventId);
  });
});

/* ══════════════════════════════════ 3. the switcher: route + UI ══════════ */

describe("POST /admin/event", () => {
  it("persists the selection and returns to the page the organizer was on", async () => {
    const response = (await eventAction(
      args(
        await adminPost("/admin/event", [
          ["event", OTHER_EVENT_SLUG],
          ["redirectTo", "/admin/submissions?tab=pending"],
        ]),
      ) as never,
    )) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/submissions?tab=pending");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${EVENT_COOKIE_NAME}=${OTHER_EVENT_SLUG}`);
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("strips ?event from the destination so the new cookie is what decides", async () => {
    const response = (await eventAction(
      args(
        await adminPost("/admin/event", [
          ["event", OTHER_EVENT_SLUG],
          ["redirectTo", `/admin/agenda?view=list&event=${EVENT_SLUG}`],
        ]),
      ) as never,
    )) as Response;
    expect(response.headers.get("location")).toBe("/admin/agenda?view=list");
  });

  it("writes no cookie for a slug that does not exist", async () => {
    const response = (await eventAction(
      args(
        await adminPost("/admin/event", [
          ["event", "no-such-event"],
          ["redirectTo", "/admin"],
        ]),
      ) as never,
    )) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a non-admin", async () => {
    await expect(
      eventAction(
        args(
          await adminPost("/admin/event", [["event", OTHER_EVENT_SLUG]], {
            personId: fixture.speakerIds[0],
          }),
        ) as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("safeAdminRedirect only allows same-origin admin paths", () => {
    // Must fire.
    expect(safeAdminRedirect("/admin")).toBe("/admin");
    expect(safeAdminRedirect("/admin/comms?person=abc")).toBe("/admin/comms?person=abc");
    // Must NOT fire — every one of these would be an open redirect or an escape
    // from the chrome the cookie is scoped to.
    for (const hostile of [
      "https://evil.example/admin",
      "//evil.example",
      "/\\evil.example",
      "/portal",
      "/administrator",
      "javascript:alert(1)",
      "",
      null,
    ]) {
      expect(safeAdminRedirect(hostile), `${hostile} must collapse to /admin`).toBe("/admin");
    }
  });
});

describe("the switcher UI", () => {
  const both = [
    { name: "Frontier AI Summit 2026", slug: EVENT_SLUG },
    { name: OTHER_EVENT_NAME, slug: OTHER_EVENT_SLUG },
  ];

  it("lists every event, marks the current one and posts to the cookie writer", () => {
    const html = renderToStaticMarkup(
      <EventSwitcher events={both} currentSlug={OTHER_EVENT_SLUG} redirectTo="/admin/agenda" />,
    );

    expect(html).toContain('action="/admin/event"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="redirectTo" value="/admin/agenda"');
    expect(html).toContain("Frontier AI Summit 2026");
    expect(html).toContain(OTHER_EVENT_NAME);
    // The current event is the selected option, and it is the ONLY one.
    expect(html).toContain(`<option value="${OTHER_EVENT_SLUG}" selected=""`);
    expect(html.match(/selected=""/g)).toHaveLength(1);
    // Labelled, so the select is reachable by name and by keyboard.
    expect(html).toContain('for="admin-event-select"');
    expect(html).toContain('id="admin-event-select"');
  });

  it("renders NOTHING when there is nothing to switch between", () => {
    expect(
      renderToStaticMarkup(
        <EventSwitcher events={[both[0]]} currentSlug={EVENT_SLUG} redirectTo="/admin" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(<EventSwitcher events={[]} currentSlug={null} redirectTo="/admin" />),
    ).toBe("");
  });

  it("the admin layout loader feeds it every event, oldest first", async () => {
    const data = await layoutLoader(args(await adminGet("/admin", OTHER_EVENT_SLUG)) as never);
    expect(data.events.map((row) => row.slug)).toEqual([EVENT_SLUG, OTHER_EVENT_SLUG]);
    expect(data.event?.slug).toBe(OTHER_EVENT_SLUG);
  });

  /**
   * The structural half of "absent on portal/review/public". A functional test
   * can only prove the surfaces it renders; this one fails the moment any other
   * route module reaches for the switcher, which is the regression that would
   * put an event picker on a speaker's portal page.
   */
  it("exists in exactly one route module", () => {
    const routesDir = fileURLToPath(new URL("./", import.meta.url));
    const owners = readdirSync(routesDir)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."))
      .filter((file) => readFileSync(join(routesDir, file), "utf8").includes("EventSwitcher"));
    expect(owners).toEqual(["admin.layout.tsx"]);

    // Control: the scan really can find the string it is looking for.
    expect(
      readFileSync(join(routesDir, "admin.layout.tsx"), "utf8").includes("EventSwitcher"),
    ).toBe(true);
  });
});

/* Keeps the unused-type lint honest — `args` is deliberately loose. */
export type _AnyArgs = AnyArgs;
