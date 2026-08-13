/**
 * Public schedule: the publish gate is the whole point of this page.
 *
 * The must-not-fire case is an UNPUBLISHED session — if a draft placement leaked
 * onto the public schedule, an organiser could never rearrange the programme in
 * daylight.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, people, sessionParticipants, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, EVENT_SLUG, type DemoFixture } from "~/test/fixtures";

import { loader } from "./public.schedule";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const asLoaderArgs = (slug: string, search = "") =>
  ({
    request: new Request(`https://x.test/e/${slug}/schedule${search}`),
    params: { slug },
    context: {},
  }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const load = (slug = EVENT_SLUG): Promise<LoaderData> => loader(asLoaderArgs(slug));

describe("loader", () => {
  it("wires the Organizers doorway href (shell.test.tsx and public.event.test.tsx cover the /admin vs /demo branch)", async () => {
    const data = await load();
    expect(data.organizersHref).toBe("/admin");
  });

  it("MUST FIRE: published, scheduled sessions appear grouped by day", async () => {
    const data = await load();

    expect(data.total).toBe(2);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].label).toBe("Wed, Oct 7, 2026");
    expect(data.days[0].sessions.map((row) => row.timeLabel)).toEqual([
      "3:00 PM – 3:30 PM",
      "4:00 PM – 4:30 PM",
    ]);
    expect(data.days[0].sessions[0].roomName).toBe("Main Stage");
    expect(data.days[0].sessions[0].trackName).toBe("Agents");
    expect(data.days[0].sessions[0].speakers).toEqual([
      { personId: fixture.speakerIds[0], name: "Sam Speaker", title: "Demo Speaker", company: "Company 0" },
    ]);
    expect(data.days[0].sessions[0].formatName).toBe("Talk");
  });

  it("MUST NOT FIRE: an unpublished session is invisible to the public", async () => {
    await ctx.db
      .update(sessions)
      .set({ isPublic: false })
      .where(eq(sessions.id, fixture.programSessionIds[0]));

    const data = await load();
    expect(data.total).toBe(1);
    expect(data.days[0].sessions.map((row) => row.id)).toEqual([
      fixture.programSessionIds[1],
    ]);
    expect(
      data.days
        .flatMap((day) => day.sessions)
        .flatMap((row) => row.speakers)
        .map((speaker) => speaker.name),
    ).not.toContain("Sam Speaker");
  });

  it("MUST NOT FIRE: a published session with NO time is not on the schedule", async () => {
    await ctx.db
      .update(sessions)
      .set({ startsAt: null, endsAt: null })
      .where(eq(sessions.id, fixture.programSessionIds[0]));

    const data = await load();
    expect(data.total).toBe(1);
  });

  it("MUST NOT FIRE: abstracts never reach the public schedule", async () => {
    // Give an accepted ABSTRACT a time and publish it — it must still be hidden.
    await ctx.db
      .update(sessions)
      .set({
        isPublic: true,
        startsAt: new Date(Date.UTC(2026, 9, 7, 20)),
        endsAt: new Date(Date.UTC(2026, 9, 7, 21)),
      })
      .where(eq(sessions.id, fixture.abstractIds[0]));

    const data = await load();
    expect(data.total).toBe(2);
    expect(data.days[0].sessions.map((row) => row.id)).not.toContain(fixture.abstractIds[0]);
  });

  it("404s for an unknown event slug", async () => {
    await expect(load("no-such-event")).rejects.toBeInstanceOf(Response);
  });

  it("returns an empty schedule when nothing is published", async () => {
    await ctx.db.update(sessions).set({ isPublic: false });
    const data = await load();
    expect(data.total).toBe(0);
    expect(data.days).toEqual([]);
  });

  it("MUST FIRE: ordered speaker and co-speaker names accompany a public session", async () => {
    await ctx.db.insert(sessionParticipants).values({
      sessionId: fixture.programSessionIds[0],
      personId: fixture.speakerIds[6],
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });

    const data = await load();
    expect(data.days[0].sessions[0].speakers).toEqual([
      { personId: fixture.speakerIds[0], name: "Sam Speaker", title: "Demo Speaker", company: "Company 0" },
      { personId: fixture.speakerIds[6], name: "Jonas Weir", title: "Engineer", company: "Company 6" },
    ]);
  });

  it("MUST NOT FIRE: participants from another event never leak into this schedule", async () => {
    const otherEventId = "other-ev-0000-4000-8000-000000000001";
    const otherPersonId = "other-pe-0000-4000-8000-000000000001";
    const otherSessionId = "other-se-0000-4000-8000-000000000001";
    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other conference",
      slug: "other-conference",
      timezone: "UTC",
    });
    await ctx.db.insert(people).values({
      id: otherPersonId,
      email: "other@example.com",
      fullName: "Cross-event Speaker",
      role: "speaker",
    });
    await ctx.db.insert(sessions).values({
      id: otherSessionId,
      eventId: otherEventId,
      title: "Other event session",
      status: "accepted",
      isAbstract: false,
      isPublic: true,
      startsAt: new Date(Date.UTC(2026, 9, 7, 22)),
      endsAt: new Date(Date.UTC(2026, 9, 7, 23)),
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: otherSessionId,
      personId: otherPersonId,
      role: "speaker",
      isPrimary: true,
      order: 0,
    });

    const data = await load();
    expect(data.total).toBe(2);
    expect(
      data.days
        .flatMap((day) => day.sessions)
        .flatMap((row) => row.speakers)
        .map((speaker) => speaker.name),
    ).not.toContain("Cross-event Speaker");
  });

  it("MUST NOT FIRE: a public session without participants still renders", async () => {
    await ctx.db
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, fixture.programSessionIds[0]));

    const data = await load();
    expect(data.days[0].sessions[0]).toMatchObject({
      id: fixture.programSessionIds[0],
      speakers: [],
    });
  });
});

describe("render", () => {
  /** The page uses `Shell`, whose NavLink needs a router — stub one. */
  async function markupFor(data: LoaderData): Promise<string> {
    const { default: PublicSchedule } = await import("./public.schedule");
    const Stub = createRoutesStub([
      {
        path: "/e/:slug/schedule",
        Component: () =>
          PublicSchedule({ loaderData: data } as unknown as Parameters<
            typeof PublicSchedule
          >[0]),
      },
    ]);
    return renderToStaticMarkup(<Stub initialEntries={[`/e/${EVENT_SLUG}/schedule`]} />);
  }

  it("renders the published programme", async () => {
    const markup = await markupFor(await load());
    expect(markup).toContain("Wed, Oct 7, 2026");
    expect(markup).toContain("Shipping agents that survive contact with users");
    expect(markup).toContain("3:00 PM – 3:30 PM");
    expect(markup).toContain("Main Stage");
    expect(markup).toContain("Sam Speaker");
    expect(markup).toContain("Demo Speaker");
    expect(markup).toContain("Company 0");
    expect(markup).toContain("Format: Talk");
    expect(markup).toContain(`data-public-session="${fixture.programSessionIds[0]}"`);
  });

  it("renders the zero state when nothing is published", async () => {
    await ctx.db.update(sessions).set({ isPublic: false });
    const markup = await markupFor(await load());
    expect(markup).toContain("The schedule is not published yet.");
    expect(markup).not.toContain("data-public-session");
  });

  /*
   * The server half of the shared search predicate. "composed" appears only in
   * the seeded ABSTRACT text, never in a title or a speaker name, so a hit here
   * can only have come from the description reaching the haystack.
   */
  it("MUST FIRE: ?q= matching only abstract text renders those sessions server-side", async () => {
    const data = await loader(asLoaderArgs(EVENT_SLUG, "?q=composed"));
    expect(data.initialFilter.q).toBe("composed");
    const markup = await markupFor(data);
    expect(markup).toContain("Shipping agents that survive contact with users");
    expect(markup).toContain('data-result-count="2"');
    expect(markup).not.toContain("No sessions match these filters.");
  });

  it("MUST NOT FIRE: a ?q= that matches no title, speaker OR abstract renders empty", async () => {
    const data = await loader(asLoaderArgs(EVENT_SLUG, "?q=nowhere-in-this-event"));
    const markup = await markupFor(data);
    expect(markup).toContain("No sessions match these filters.");
    expect(markup).toContain('data-result-count="0"');
  });

  it("MUST FIRE: the whole-schedule ICS feed is linked from the schedule page", async () => {
    const markup = await markupFor(await load());
    expect(markup).toContain(`href="/e/${EVENT_SLUG}/schedule.ics"`);
    expect(markup).toContain("Export full schedule (.ics)");
  });

  it("MUST NOT FIRE: no export link when there is no published schedule to export", async () => {
    await ctx.db.update(sessions).set({ isPublic: false });
    const markup = await markupFor(await load());
    expect(markup).not.toContain("Export full schedule (.ics)");
  });
});
