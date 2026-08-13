/**
 * The public home card carries the open-call COUNT, not just "CFP open".
 *
 * The count was already in the loader — `openCalls`, one grouped aggregate
 * across every listed event, paid for on every render — and the card threw it
 * away, so an event with one open call and an event with five rendered
 * identically. This is the page behind the wordmark on all sixteen organizer
 * screens, and the count is the one fact a speaker landing on it is shopping
 * for.
 *
 * Every assertion below is paired. The must-fire case would go green on a card
 * that printed a hardcoded "1 open call"; the must-not-fire case is the one
 * that catches it — an event with NO open call must show neither the pill nor a
 * count, and a card that always prints something fails it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, forms } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture } from "~/test/fixtures";

import PublicHome, { loader } from "./public.home";

const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb();
  await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/** `Shell` renders `NavLink`, which needs a router. */
async function homeMarkup(): Promise<string> {
  const data = await loader(args(new Request("https://x.test/")));
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () =>
        PublicHome({ loaderData: data } as unknown as Parameters<typeof PublicHome>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}

/** Every `data-open-calls` value on the page, in document order. */
function countsIn(markup: string): string[] {
  return [...markup.matchAll(/data-open-calls="(\d+)"/g)].map((match) => match[1]);
}

async function closeEveryCall() {
  await ctx.db
    .update(forms)
    .set({ status: "closed" })
    .where(and(eq(forms.eventId, EVENT_ID), eq(forms.surface, "cfp")));
}

async function addOpenCall(name: string) {
  await ctx.db.insert(forms).values({
    eventId: EVENT_ID,
    name,
    target: "submission",
    surface: "cfp",
    status: "open",
    schema: { version: 1, fields: [] },
  });
}

describe("open-call count on the event card", () => {
  it("MUST FIRE: the seeded event shows its real count, not a fixed string", async () => {
    // The fixture seeds exactly one open cfp call.
    const before = await loader(args(new Request("https://x.test/")));
    expect(before.events.find((event) => event.slug === EVENT_SLUG)?.openCalls).toBe(1);
    expect(await homeMarkup()).toContain("1 open call");

    // Two more, and the card must move with the data. A hardcoded label, or a
    // card reading the pill instead of the number, dies here.
    await addOpenCall("Sponsor track call");
    await addOpenCall("Lightning talks call");
    const markup = await homeMarkup();
    expect(markup).toContain("3 open calls");
    expect(markup).not.toContain("1 open call");
    expect(countsIn(markup)).toContain("3");
  });

  it("MUST NOT FIRE: an event with nothing open shows no pill and no count", async () => {
    await closeEveryCall();

    const data = await loader(args(new Request("https://x.test/")));
    expect(data.events.find((event) => event.slug === EVENT_SLUG)?.openCalls).toBe(0);

    const markup = await homeMarkup();
    // The event itself is still listed — this is the complement that catches a
    // "fix" which simply stopped rendering the card.
    expect(markup).toContain(`/e/${EVENT_SLUG}`);
    expect(markup).not.toContain("CFP open");
    expect(markup).not.toContain("open call");
    expect(countsIn(markup)).toEqual([]);
  });

  it("pluralises on the count, not on the pill", async () => {
    await closeEveryCall();
    await addOpenCall("Only call");
    expect(await homeMarkup()).toContain("1 open call<");

    await addOpenCall("Second call");
    expect(await homeMarkup()).toContain("2 open calls");
  });
});

describe("the card grid scales its columns to how many events there are", () => {
  it("MUST NOT FIRE: a single event does not request columns it cannot fill", async () => {
    // The fixture seeds exactly one event. Unconditionally requesting
    // sm:grid-cols-2 and lg:grid-cols-3 here left two dead, empty columns
    // beside the lone card on any screen sm and up.
    const markup = await homeMarkup();
    expect(markup).toContain('class="grid gap-4"');
    expect(markup).not.toContain("sm:grid-cols-2");
    expect(markup).not.toContain("lg:grid-cols-3");
  });

  it("two events add the sm two-up step, but not lg", async () => {
    await ctx.db.insert(events).values({ name: "Second Conference", slug: "second-conference" });
    const markup = await homeMarkup();
    expect(markup).toContain('class="grid gap-4 sm:grid-cols-2"');
    expect(markup).not.toContain("lg:grid-cols-3");
  });

  it("MUST FIRE: three or more events add the lg three-up step", async () => {
    await ctx.db.insert(events).values({ name: "Second Conference", slug: "second-conference" });
    await ctx.db.insert(events).values({ name: "Third Conference", slug: "third-conference" });
    expect(await homeMarkup()).toContain("grid gap-4 sm:grid-cols-2 lg:grid-cols-3");
  });

  it("cards carry the resting shadow, not a hover-only one", async () => {
    // `hover:shadow-card` appeared exactly once in the whole product, here.
    // A card that becomes an object only while a pointer is over it never
    // becomes one on a touch screen.
    const markup = await homeMarkup();
    expect(markup).toContain("shadow-card");
    expect(markup).not.toContain("hover:shadow-card");
  });
});
