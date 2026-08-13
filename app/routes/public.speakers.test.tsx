import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, people, sessionParticipants, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, EVENT_SLUG, SPEAKERS, type DemoFixture } from "~/test/fixtures";

import { loader as scheduleLoader } from "./public.schedule";
import { loader } from "./public.speakers";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const asLoaderArgs = (url = `https://x.test/e/${EVENT_SLUG}/speakers`) =>
  ({
    request: new Request(url),
    params: { slug: EVENT_SLUG },
    context: {},
  }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const load = (search = "") =>
  loader(asLoaderArgs(`https://x.test/e/${EVENT_SLUG}/speakers${search}`));

async function addProgramSpeaker({
  personId,
  sessionId,
  fullName,
  lastName,
  isPublic = true,
  startsAt = new Date(Date.UTC(2026, 9, 8, 18)),
  deletedAt = null,
}: {
  personId: string;
  sessionId: string;
  fullName: string;
  lastName?: string | null;
  isPublic?: boolean;
  startsAt?: Date | null;
  deletedAt?: Date | null;
}) {
  await ctx.db.insert(people).values({
    id: personId,
    email: `${personId}@example.test`,
    fullName,
    lastName,
    title: "Researcher",
    company: "Test Lab",
    role: "speaker",
  });
  await ctx.db.insert(sessions).values({
    id: sessionId,
    eventId: fixture.eventId,
    title: `${fullName}'s public session`,
    status: "accepted",
    isAbstract: false,
    isPublic,
    startsAt,
    endsAt: startsAt ? new Date(startsAt.getTime() + 30 * 60_000) : null,
    deletedAt,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId,
    personId,
    role: "speaker",
    isPrimary: true,
    order: 0,
  });
}

describe("loader", () => {
  it("MUST FIRE: speakers of published sessions include public profile fields and counts", async () => {
    const data = await load();
    expect(data.speakers).toEqual([
      expect.objectContaining({
        id: fixture.speakerIds[1],
        displayName: "Rina Okafor",
        title: "Engineer",
        company: "Company 1",
        sessionCount: 1,
      }),
      expect.objectContaining({
        id: fixture.speakerIds[0],
        displayName: "Sam Speaker",
        title: "Demo Speaker",
        company: "Company 0",
        sessionCount: 1,
      }),
    ]);
  });

  it("MUST FIRE: surname ordering is the exact public roster order", async () => {
    const data = await load();
    expect(data.speakers.map((row) => row.displayName.split(/\s+/).at(-1))).toEqual([
      "Okafor",
      "Speaker",
    ]);
  });

  it("MUST FIRE: surname sorting falls back to the last full-name token", async () => {
    await addProgramSpeaker({
      personId: "fallback-person",
      sessionId: "fallback-session",
      fullName: "Ari Quinn",
      lastName: null,
    });
    const data = await load();
    expect(data.speakers.map((row) => row.displayName)).toEqual([
      "Rina Okafor",
      "Ari Quinn",
      "Sam Speaker",
    ]);
  });

  it("MUST FIRE: a person with no stored name still gets a display name and monogram", async () => {
    /*
     * The regression guard for a `??` chain over `[].join(" ")`: an empty
     * string is not nullish, so the "Speaker" fallback was unreachable and a
     * nameless person rendered a blank row with a blank monogram. Asserting the
     * VALUES here — an assertion that the field merely exists passed the bug.
     */
    await addProgramSpeaker({
      personId: "nameless-person",
      sessionId: "nameless-session",
      fullName: null as unknown as string,
      lastName: null,
    });

    const nameless = (await load()).speakers.find((row) => row.id === "nameless-person");
    expect(nameless).toBeDefined();
    expect(nameless?.displayName).toBe("Speaker");
    expect(nameless?.initials).toBe("SP");
    expect(nameless?.groupInitial).toBe("#");
    // Unnamed people sort after every real surname rather than jumping to the top.
    expect((await load()).speakers.at(-1)?.id).toBe("nameless-person");
  });

  it("MUST NOT FIRE: a speaker whose only session is an abstract is absent", async () => {
    expect((await load()).speakers.map((row) => row.displayName)).not.toContain(SPEAKERS[2].name);
  });

  it("MUST NOT FIRE: a speaker whose only programme session is unpublished is absent", async () => {
    await addProgramSpeaker({
      personId: "unpublished-person",
      sessionId: "unpublished-session",
      fullName: "Una Published",
      isPublic: false,
    });
    expect((await load()).speakers.map((row) => row.displayName)).not.toContain("Una Published");
  });

  it("MUST NOT FIRE: a speaker whose only programme session has no start is absent", async () => {
    await addProgramSpeaker({
      personId: "unscheduled-person",
      sessionId: "unscheduled-session",
      fullName: "Noah Time",
      startsAt: null,
    });
    expect((await load()).speakers.map((row) => row.displayName)).not.toContain("Noah Time");
  });

  it("MUST NOT FIRE: a speaker whose only programme session is soft-deleted is absent", async () => {
    await addProgramSpeaker({
      personId: "deleted-person",
      sessionId: "deleted-session",
      fullName: "Del Eted",
      deletedAt: new Date(),
    });
    expect((await load()).speakers.map((row) => row.displayName)).not.toContain("Del Eted");
  });

  it("MUST NOT FIRE: a public speaker from another event is absent", async () => {
    await ctx.db.insert(events).values({
      id: "other-event",
      name: "Other event",
      slug: "other-event",
      timezone: "UTC",
    });
    await ctx.db.insert(people).values({
      id: "other-person",
      email: "other-person@example.test",
      fullName: "Cross Event",
      role: "speaker",
    });
    await ctx.db.insert(sessions).values({
      id: "other-session",
      eventId: "other-event",
      title: "Other programme",
      status: "accepted",
      isAbstract: false,
      isPublic: true,
      startsAt: new Date(Date.UTC(2026, 9, 8, 18)),
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: "other-session",
      personId: "other-person",
      role: "speaker",
      isPrimary: true,
      order: 0,
    });
    expect((await load()).speakers.map((row) => row.displayName)).not.toContain("Cross Event");
  });

  it("MUST NOT FIRE: the organizer without a public session is absent", async () => {
    expect((await load()).speakers.map((row) => row.id)).not.toContain(fixture.adminId);
  });

  it("Search MUST FIRE: a case-insensitive surname query narrows to its speaker", async () => {
    const data = await load("?q=oKaFoR");
    expect(data.speakers.map((row) => row.displayName)).toEqual(["Rina Okafor"]);
    expect(data.count).toBe(1);
    expect(data.total).toBe(2);
  });

  it("Search MUST NOT FIRE: surname search excludes other speakers", async () => {
    expect((await load("?q=okafor")).speakers.map((row) => row.displayName)).not.toContain(
      "Sam Speaker",
    );
  });

  it("Search MUST NOT FIRE: a no-match query returns an empty result, not the full list", async () => {
    const data = await load("?q=not-a-speaker");
    expect(data.speakers).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.total).toBe(2);
  });

  it("Predicate parity MUST FIRE: schedule and directory change together", async () => {
    const scheduleArgs = {
      request: new Request(`https://x.test/e/${EVENT_SLUG}/schedule`),
      params: { slug: EVENT_SLUG },
      context: {},
    } as unknown as Parameters<typeof scheduleLoader>[0];
    const scheduleNames = (await scheduleLoader(scheduleArgs)).days
      .flatMap((day) => day.sessions)
      .flatMap((session) => session.speakers.map((speaker) => speaker.name));
    expect(new Set(scheduleNames)).toEqual(
      new Set((await load()).speakers.map((speaker) => speaker.displayName)),
    );

    await ctx.db
      .update(sessions)
      .set({ isPublic: false })
      .where(eq(sessions.id, fixture.programSessionIds[0]));

    const changedScheduleNames = (await scheduleLoader(scheduleArgs)).days
      .flatMap((day) => day.sessions)
      .flatMap((session) => session.speakers.map((speaker) => speaker.name));
    expect(new Set(changedScheduleNames)).toEqual(
      new Set((await load()).speakers.map((speaker) => speaker.displayName)),
    );
    expect(new Set(changedScheduleNames)).toEqual(new Set(["Rina Okafor"]));
  });
});

describe("render", () => {
  async function markupFor(data: LoaderData): Promise<string> {
    const { default: PublicSpeakers } = await import("./public.speakers");
    const Stub = createRoutesStub([
      {
        path: "/e/:slug/speakers",
        Component: () =>
          PublicSpeakers({ loaderData: data } as unknown as Parameters<typeof PublicSpeakers>[0]),
      },
    ]);
    return renderToStaticMarkup(<Stub initialEntries={[`/e/${EVENT_SLUG}/speakers`]} />);
  }

  it("MUST FIRE: list and gallery render distinct selector shapes with public fields", async () => {
    const list = await markupFor(await load());
    const gallery = await markupFor(await load("?view=gallery"));
    expect(list).toContain('data-speaker-view="list"');
    expect(list).toContain(`data-speaker-row="${fixture.speakerIds[0]}"`);
    expect(gallery).toContain('data-speaker-view="gallery"');
    expect(gallery).toContain(`data-speaker-card="${fixture.speakerIds[0]}"`);
    expect(list).not.toBe(gallery);
    for (const markup of [list, gallery]) {
      expect(markup).toContain("Sam Speaker");
      expect(markup).toContain("Demo Speaker");
      expect(markup).toContain("Company 0");
    }
  });

  /*
   * EMB-13: the card link is what carries the grid + search state across the
   * navigation, so `public.speaker.tsx` can rebuild the Back link. A card link
   * without the view param lands the visitor back in the LIST view.
   */
  it("MUST FIRE: gallery cards carry view and search back-state in their href", async () => {
    const gallery = await markupFor(await load("?view=gallery&q=Speaker"));
    expect(gallery).toContain(
      `href="/e/${EVENT_SLUG}/speakers/${fixture.speakerIds[0]}?view=gallery&amp;q=Speaker"`,
    );
  });

  it("MUST NOT FIRE: list rows carry the search but never claim the gallery view", async () => {
    const list = await markupFor(await load("?q=Speaker"));
    expect(list).toContain(
      `href="/e/${EVENT_SLUG}/speakers/${fixture.speakerIds[0]}?q=Speaker"`,
    );
    expect(list).not.toContain(`speakers/${fixture.speakerIds[0]}?view=gallery`);

    // And with no search at all the detail href stays clean — no empty ?q=.
    const plain = await markupFor(await load());
    expect(plain).toContain(`href="/e/${EVENT_SLUG}/speakers/${fixture.speakerIds[0]}"`);
    expect(plain).not.toContain(`speakers/${fixture.speakerIds[0]}?`);
  });

  it("Search MUST FIRE: a no-match query renders the search empty state", async () => {
    const markup = await markupFor(await load("?q=not-a-speaker"));
    expect(markup).toContain("No speakers match that search.");
    expect(markup).toContain("Clear search");
    expect(markup).toContain("data-speaker-empty");
    expect(markup).not.toContain("data-speaker-row");
  });

  it("MUST NOT FIRE: the zero-speaker state contains no speaker selector", async () => {
    await ctx.db.update(sessions).set({ isPublic: false });
    const markup = await markupFor(await load());
    expect(markup).toContain("Speakers have not been announced yet.");
    expect(markup).toContain("data-speaker-empty");
    expect(markup).not.toContain("data-speaker-row");
    expect(markup).not.toContain("data-speaker-card");
  });
});
