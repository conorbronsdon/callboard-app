/**
 * The self-proving embed on the public home page.
 *
 * The point of this section is that it is not a claim. It frames the SAME
 * `/embed/<slug>/agenda` route an organizer pastes into their own site, so the
 * assertions below are about that route being the src — a screenshot, a mock
 * widget or a hand-rolled copy of the agenda would all fail here.
 *
 * The pairing that matters is the empty one: an iframe whose event has nothing
 * published renders the widget's empty state INSIDE a frame on the front page,
 * which is worse evidence than no frame. The section must disappear, and the
 * rest of the home page must survive its disappearance.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, FIXTURE_NOW, seedDemoFixture } from "~/test/fixtures";

import PublicHome, { loader } from "./public.home";

const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb();
  await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const load = () => loader(args(new Request("https://x.test/")));

async function homeMarkup(): Promise<string> {
  const data = await load();
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () =>
        PublicHome({ loaderData: data } as unknown as Parameters<typeof PublicHome>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}

/** Unpublish the seeded programme without deleting the event. */
async function unpublishEverything() {
  await ctx.db
    .update(sessions)
    .set({ isPublic: false })
    .where(eq(sessions.eventId, EVENT_ID));
}

describe("MUST FIRE: the home page frames its own widget", () => {
  it("points the iframe at the real embed route for the primary event", async () => {
    const data = await load();

    expect(data.embed).toEqual({
      name: "Frontier AI Summit 2026",
      src: `/embed/${EVENT_SLUG}/agenda?theme=auto`,
    });

    const markup = await homeMarkup();
    expect(markup).toContain('data-testid="home-embed-proof"');
    expect(markup).toContain(`src="/embed/${EVENT_SLUG}/agenda?theme=auto"`);
    expect(markup).toContain("This is the live embed");
    expect(markup).toContain("an organizer pastes");
  });

  it("carries loading=lazy, and sits below the events list", async () => {
    // The ATTRIBUTE is what is asserted. How near the viewport a browser starts
    // fetching a lazy frame is implementation-defined, so no server-rendered
    // test can honestly claim "it does not load below the fold".
    const markup = await homeMarkup();
    expect(markup).toContain('loading="lazy"');
    // Below, not above: the frame must follow the last event card.
    expect(markup.indexOf(`/e/${EVENT_SLUG}"`)).toBeLessThan(
      markup.indexOf('data-testid="home-embed-proof"'),
    );
  });

  it("the src is a route this app actually serves, and one that permits framing", async () => {
    const { embed } = await load();
    const path = new URL(embed!.src, "https://x.test").pathname;
    // Same predicate the security headers key the framing exception off.
    const { isEmbeddablePath } = await import("~/lib/security-headers");
    expect(isEmbeddablePath(path)).toBe(true);
    expect(path).toBe(`/embed/${EVENT_SLUG}/agenda`);
  });

  it("the framed widget really renders the seeded agenda", async () => {
    // The src is only evidence if that URL has something in it. Load the
    // widget's own loader for the same slug and check it carries the seed's
    // published sessions.
    const { loader: agendaLoader } = await import("./embed.agenda");
    const widget = await agendaLoader({
      request: new Request(`https://x.test/embed/${EVENT_SLUG}/agenda?theme=auto`),
      params: { slug: EVENT_SLUG },
      context: {},
    } as never);

    expect(widget.theme).toBe("auto");
    expect(widget.total).toBe(2);
    expect(widget.days.flatMap((day) => day.sessions).map((slot) => slot.title)).toContain(
      "Shipping agents that survive contact with users",
    );
  });
});

describe("MUST NOT FIRE: nothing published means no frame", () => {
  it("hides the section rather than framing an empty widget", async () => {
    await unpublishEverything();

    const data = await load();
    expect(data.embed).toBeNull();

    const markup = await homeMarkup();
    expect(markup).not.toContain("home-embed-proof");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("This is the live embed");

    // The complement that catches a "fix" which just stopped rendering the
    // page: the events list itself is untouched.
    expect(markup).toContain(`/e/${EVENT_SLUG}`);
    // Apostrophe entity-escaped by the renderer, as it is on the card.
    expect(markup).toContain("Frontier AI Summit 2026");
  });

  it("a scheduled but soft-deleted session does not resurrect the frame", async () => {
    await ctx.db
      .update(sessions)
      .set({ deletedAt: new Date(FIXTURE_NOW) })
      .where(eq(sessions.eventId, EVENT_ID));
    expect((await load()).embed).toBeNull();
  });

  it("an unscheduled published session does not count as an agenda", async () => {
    await ctx.db
      .update(sessions)
      .set({ startsAt: null })
      .where(eq(sessions.eventId, EVENT_ID));
    expect((await load()).embed).toBeNull();
  });

  it("abstracts are not sessions: a CFP full of them frames nothing", async () => {
    await unpublishEverything();
    // Every abstract made public and given a time — still not programme rows.
    await ctx.db
      .update(sessions)
      .set({ isPublic: true })
      .where(eq(sessions.isAbstract, true));
    expect((await load()).embed).toBeNull();
  });

  it("no events at all is a home page, not a crash", async () => {
    await ctx.db.delete(sessions);
    await ctx.db.delete(events);
    const data = await load();
    expect(data.embed).toBeNull();
    expect(data.events).toEqual([]);
    expect(await homeMarkup()).toContain("No events yet");
  });
});

describe("the primary event is the one the rest of the product calls primary", () => {
  it("picks the OLDEST event, matching the admin default, not whichever row came back first", async () => {
    // A newer event with a published, scheduled session of its own. If the
    // loader picked "any event with an agenda" or "the last row", this is the
    // one it would find.
    const newerId = "newer-event";
    await ctx.db.insert(events).values({
      id: newerId,
      name: "Later Conference",
      slug: "later-conference",
      timezone: "UTC",
      createdAt: new Date(FIXTURE_NOW + 86_400_000),
      updatedAt: new Date(FIXTURE_NOW + 86_400_000),
    });
    await ctx.db.insert(sessions).values({
      id: "newer-session",
      eventId: newerId,
      title: "A later talk",
      isAbstract: false,
      status: "accepted",
      isPublic: true,
      startsAt: new Date(FIXTURE_NOW + 90 * 86_400_000),
      endsAt: new Date(FIXTURE_NOW + 90 * 86_400_000 + 1_800_000),
    });

    const data = await load();
    expect(data.embed?.src).toContain(`/embed/${EVENT_SLUG}/agenda`);
    expect(data.embed?.src).not.toContain("later-conference");
    // Oldest first in the card list too, so the framed event is the one at the
    // top of the page rather than an arbitrary row.
    expect(data.events[0].slug).toBe(EVENT_SLUG);

    // MUST FIRE the other way: with the seeded event unpublished, the section
    // goes away — it does not fall through to the newer event's agenda.
    await unpublishEverything();
    expect((await load()).embed).toBeNull();
  });
});
