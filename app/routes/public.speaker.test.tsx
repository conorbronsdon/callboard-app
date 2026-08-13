import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, people, sessionParticipants, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, EVENT_SLUG, type DemoFixture } from "~/test/fixtures";

import { BIO_CLAMP_CHARS, loader } from "./public.speaker";

type LoaderData = Awaited<ReturnType<typeof loader>>;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const load = (personId: string, search = "", slug = EVENT_SLUG) =>
  loader({
    request: new Request(`https://x.test/e/${slug}/speakers/${personId}${search}`),
    params: { slug, personId },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);

async function addHiddenSession(
  id: string,
  title: string,
  personId: string,
  overrides: Partial<typeof sessions.$inferInsert>,
) {
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    title,
    status: "accepted",
    isAbstract: false,
    isPublic: true,
    startsAt: new Date(Date.UTC(2026, 9, 8, 18)),
    ...overrides,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: id,
    personId,
    role: "speaker",
    isPrimary: true,
    order: 0,
  });
}

describe("loader", () => {
  it("wires the Organizers doorway href (shell.test.tsx and public.event.test.tsx cover the /admin vs /demo branch)", async () => {
    const data = await load(fixture.speakerIds[0]);
    expect(data.organizersHref).toBe("/admin");
  });

  it("MUST FIRE: public profile and every public-session field are present", async () => {
    const data = await load(fixture.speakerIds[0]);
    expect(data.speaker).toMatchObject({
      displayName: "Sam Speaker",
      title: "Demo Speaker",
      company: "Company 0",
      bio: "Sam Speaker works on speaker.",
    });
    expect(data.sessions).toEqual([
      expect.objectContaining({
        id: fixture.programSessionIds[0],
        title: "Shipping agents that survive contact with users",
        dateLabel: "Wed, Oct 7, 2026",
        timeLabel: "3:00 PM – 3:30 PM",
        roomName: "Main Stage",
        href: `/e/${EVENT_SLUG}/schedule/${fixture.programSessionIds[0]}`,
      }),
    ]);
  });

  it("MUST FIRE: a co-speaker's public session appears on their detail", async () => {
    await ctx.db.insert(sessionParticipants).values({
      sessionId: fixture.programSessionIds[0],
      personId: fixture.speakerIds[6],
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });
    expect((await load(fixture.speakerIds[6])).sessions.map((row) => row.id)).toEqual([
      fixture.programSessionIds[0],
    ]);
  });

  it("MUST NOT FIRE: abstract, unpublished, and other-event sessions stay out", async () => {
    const personId = fixture.speakerIds[0];
    await addHiddenSession("hidden-abstract", "Private abstract", personId, {
      isAbstract: true,
    });
    await addHiddenSession("hidden-unpublished", "Unpublished slot", personId, {
      isPublic: false,
    });
    await ctx.db.insert(events).values({
      id: "detail-other-event",
      name: "Other event",
      slug: "detail-other-event",
      timezone: "UTC",
    });
    await addHiddenSession("hidden-other", "Other-event slot", personId, {
      eventId: "detail-other-event",
    });

    const titles = (await load(personId)).sessions.map((row) => row.title);
    expect(titles).toEqual(["Shipping agents that survive contact with users"]);
    expect(titles).not.toContain("Private abstract");
    expect(titles).not.toContain("Unpublished slot");
    expect(titles).not.toContain("Other-event slot");
  });

  /*
   * EMB-13. The Back link is built from the URL the card handed over, so a
   * visitor who came from the gallery with a search returns to that grid with
   * the search intact. The complement is the point: a detail URL with no
   * back-state must NOT invent `?view=gallery`.
   */
  it("MUST FIRE: back state restores the gallery view and the search query", async () => {
    const data = await load(fixture.speakerIds[0], "?view=gallery&q=Speaker");
    expect(data.back).toMatchObject({ view: "gallery", q: "Speaker" });
    expect(data.back.href).toBe(`/e/${EVENT_SLUG}/speakers?view=gallery&q=Speaker`);
    expect(data.back.label).toContain("gallery");
  });

  it("MUST NOT FIRE: a bare detail URL returns to the plain list, with no invented params", async () => {
    const data = await load(fixture.speakerIds[0]);
    expect(data.back.href).toBe(`/e/${EVENT_SLUG}/speakers`);
    expect(data.back.href).not.toContain("view=");
    expect(data.back.href).not.toContain("q=");
    expect(data.back).toMatchObject({ view: "list", q: "" });

    // A search with no view returns to the LIST, carrying only the query.
    const searched = await load(fixture.speakerIds[0], "?q=Speaker");
    expect(searched.back.href).toBe(`/e/${EVENT_SLUG}/speakers?q=Speaker`);
    expect(searched.back.href).not.toContain("view=");

    // An unknown view value is not a view: it falls back to the list.
    const bogus = await load(fixture.speakerIds[0], "?view=carousel");
    expect(bogus.back.href).toBe(`/e/${EVENT_SLUG}/speakers`);
  });

  it("MUST NOT FIRE: a person with no public session receives 404", async () => {
    await expect(load(fixture.speakerIds[2])).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: an unknown person receives the same 404", async () => {
    await expect(load("unknown-person")).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: a person qualifying only at another event receives 404", async () => {
    await ctx.db.insert(events).values({
      id: "qualify-other-event",
      name: "Other event",
      slug: "qualify-other-event",
      timezone: "UTC",
    });
    await ctx.db.insert(people).values({
      id: "qualify-other-person",
      email: "qualify-other@example.test",
      fullName: "Else Where",
      role: "speaker",
    });
    await ctx.db.insert(sessions).values({
      id: "qualify-other-session",
      eventId: "qualify-other-event",
      title: "Public elsewhere",
      status: "accepted",
      isAbstract: false,
      isPublic: true,
      startsAt: new Date(Date.UTC(2026, 9, 8, 18)),
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: "qualify-other-session",
      personId: "qualify-other-person",
      role: "speaker",
      isPrimary: true,
      order: 0,
    });
    await expect(load("qualify-other-person")).rejects.toMatchObject({ status: 404 });
  });
});

describe("render", () => {
  async function markupFor(data: LoaderData): Promise<string> {
    const { default: PublicSpeaker } = await import("./public.speaker");
    const Stub = createRoutesStub([
      {
        path: "/e/:slug/speakers/:personId",
        Component: () =>
          PublicSpeaker({ loaderData: data } as unknown as Parameters<typeof PublicSpeaker>[0]),
      },
    ]);
    return renderToStaticMarkup(
      <Stub initialEntries={[`/e/${EVENT_SLUG}/speakers/${data.speaker.id}`]} />,
    );
  }

  it("MUST FIRE: detail markup includes the profile and session selectors", async () => {
    const markup = await markupFor(await load(fixture.speakerIds[0]));
    expect(markup).toContain(`data-speaker-detail="${fixture.speakerIds[0]}"`);
    expect(markup).toContain(`data-speaker-session="${fixture.programSessionIds[0]}"`);
    expect(markup).toContain("Sam Speaker works on speaker.");
    expect(markup).toContain("Main Stage");
    expect(markup).toContain("3:00 PM – 3:30 PM");
  });

  it("MUST FIRE: a long bio collapses behind Show more, with the full text still in the HTML", async () => {
    const longBio = `${"Ingrid has spent a decade on inference infrastructure. ".repeat(6)}End marker.`;
    expect(longBio.length).toBeGreaterThan(BIO_CLAMP_CHARS);
    await ctx.db
      .update(people)
      .set({ bio: longBio })
      .where(eq(people.id, fixture.speakerIds[0]));

    const markup = await markupFor(await load(fixture.speakerIds[0]));
    expect(markup).toContain("<details");
    expect(markup).toContain("Show more");
    expect(markup).toContain("Show less");
    expect(markup).toContain("line-clamp-3");
    // Readable with scripts and styles off: the whole bio ships in the HTML.
    expect(markup).toContain("End marker.");
  });

  it("MUST NOT FIRE: a short bio renders as a plain paragraph with no expander", async () => {
    const markup = await markupFor(await load(fixture.speakerIds[0]));
    expect(markup).toContain("Sam Speaker works on speaker.");
    expect(markup).toContain("data-speaker-bio");
    expect(markup).not.toContain("Show more");
    expect(markup).not.toContain("<details");
  });

  it("MUST FIRE: the rendered Back link carries the gallery view and search", async () => {
    const markup = await markupFor(
      await load(fixture.speakerIds[0], "?view=gallery&q=Speaker"),
    );
    expect(markup).toContain('data-speaker-back="gallery"');
    expect(markup).toContain(`href="/e/${EVENT_SLUG}/speakers?view=gallery&amp;q=Speaker"`);

    const plain = await markupFor(await load(fixture.speakerIds[0]));
    expect(plain).toContain('data-speaker-back="list"');
    expect(plain).toContain(`href="/e/${EVENT_SLUG}/speakers"`);
    expect(plain).not.toContain("view=gallery");
  });

  it("MUST NOT FIRE: a bio-less qualifying speaker renders an honest line, not an empty block", async () => {
    await ctx.db.insert(sessionParticipants).values({
      sessionId: fixture.programSessionIds[0],
      personId: fixture.speakerIds[6],
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });
    const markup = await markupFor(await load(fixture.speakerIds[6]));
    expect(markup).toContain("Speakers write their own from the speaker portal");
    expect(markup).toContain("data-speaker-bio-empty");
    expect(markup).not.toContain("data-speaker-bio=\"");
  });
});
