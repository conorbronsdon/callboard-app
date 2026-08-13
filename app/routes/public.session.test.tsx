import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, sessionParticipants, sessions } from "~/db/schema";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";
import { loader } from "./public.session";
import { loader as scheduleLoader } from "./public.schedule";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const args = (
  sessionId: string,
  slug = EVENT_SLUG,
  query = "",
) =>
  ({
    request: new Request(`https://x.test/e/${slug}/schedule/${sessionId}${query}`),
    params: { slug, sessionId },
    context: {},
  }) as unknown as LoaderArgs;

const load = (sessionId = fixture.programSessionIds[0], query = "") =>
  loader(args(sessionId, EVENT_SLUG, query));

async function markupFor(data: LoaderData): Promise<string> {
  const { default: PublicSession } = await import("./public.session");
  const Stub = createRoutesStub([
    {
      path: "/e/:slug/schedule/:sessionId",
      Component: () =>
        PublicSession({ loaderData: data } as unknown as Parameters<
          typeof PublicSession
        >[0]),
    },
  ]);
  return renderToStaticMarkup(
    <Stub initialEntries={[`/e/${EVENT_SLUG}/schedule/${data.slot.id}`]} />,
  );
}

describe("public session detail", () => {
  it("wires the Organizers doorway href (shell.test.tsx and public.event.test.tsx cover the /admin vs /demo branch)", async () => {
    const data = await load();
    expect(data.organizersHref).toBe("/admin");
  });

  it("MUST FIRE: returns and renders range, metadata, description and full speaker identity", async () => {
    const data = await load();
    expect(data).toMatchObject({
      dayLabel: "Wed, Oct 7, 2026",
      slot: {
        title: "Shipping agents that survive contact with users",
        timeLabel: "3:00 PM – 3:30 PM",
        roomName: "Main Stage",
        trackName: "Agents",
        formatName: "Talk",
        description: "Program session composed from the accepted abstract.",
        speakers: [
          { name: "Sam Speaker", title: "Demo Speaker", company: "Company 0" },
        ],
      },
    });
    const markup = await markupFor(data);
    for (const text of [
      "Wed, Oct 7, 2026",
      "3:00 PM – 3:30 PM",
      "Main Stage",
      "Agents",
      "Format: Talk",
      "Program session composed from the accepted abstract.",
      "Sam Speaker",
      "Demo Speaker",
      "Company 0",
      "Add to calendar (.ics)",
      "Google Calendar",
      "Outlook",
    ]) {
      expect(markup).toContain(text);
    }
    expect(data.calendarLinks.google).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?/);
    expect(data.calendarLinks.outlook).toMatch(/^https:\/\/outlook\.live\.com\/calendar\/0\/action\/compose\?/);
    expect(markup).toContain(`href="${data.calendarLinks.google.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain(`href="${data.calendarLinks.outlook.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain(`data-public-session-detail="${fixture.programSessionIds[0]}"`);
  });

  it("round-trips the canonical filter/day query and restores the card anchor", async () => {
    const data = await load(
      fixture.programSessionIds[0],
      "?room=Main%20Stage&day=2026-10-07&q=Speaker&ignored=unsafe",
    );
    expect(data.backHref).toBe(
      `/e/${EVENT_SLUG}/schedule?q=Speaker&room=Main+Stage&day=2026-10-07#public-session-${fixture.programSessionIds[0]}`,
    );
  });

  it("MUST NOT FIRE: null speaker role fields render no empty role or comma, and non-speakers stay hidden", async () => {
    await ctx.db
      .update(people)
      .set({ title: null, company: null })
      .where(eq(people.id, fixture.speakerIds[0]));
    await ctx.db.insert(sessionParticipants).values({
      sessionId: fixture.programSessionIds[0],
      personId: fixture.speakerIds[2],
      role: "moderator",
      isPrimary: false,
      order: 1,
    });
    const data = await load();
    expect(data.slot.speakers).toEqual([
      { personId: fixture.speakerIds[0], name: "Sam Speaker", title: null, company: null },
    ]);
    const markup = await markupFor(data);
    expect(markup).toContain("Sam Speaker");
    expect(markup).not.toContain("data-speaker-role");
    expect(markup).not.toContain("Dev Patel");
  });

  it("MUST NOT FIRE: an unpublished session 404s", async () => {
    await ctx.db.update(sessions).set({ isPublic: false }).where(eq(sessions.id, fixture.programSessionIds[0]));
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: an abstract id 404s", async () => {
    await expect(load(fixture.abstractIds[0])).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: a soft-deleted session 404s", async () => {
    await ctx.db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.id, fixture.programSessionIds[0]));
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: a session from another event 404s", async () => {
    const other = await seedOtherEvent(ctx.db);
    await expect(load(other.programSessionId)).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: a session without a start 404s", async () => {
    await ctx.db.update(sessions).set({ startsAt: null }).where(eq(sessions.id, fixture.programSessionIds[0]));
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });
});

describe("schedule/detail consistency", () => {
  it("MUST FIRE: both loaders expose the same shared slot fields", async () => {
    const schedule = await scheduleLoader({
      request: new Request(`https://x.test/e/${EVENT_SLUG}/schedule`),
      params: { slug: EVENT_SLUG },
      context: {},
    } as unknown as Parameters<typeof scheduleLoader>[0]);
    const detail = await load();
    const card = schedule.days.flatMap((day) => day.sessions).find((slot) => slot.id === detail.slot.id);
    expect(card).toBeDefined();
    for (const field of ["title", "timeLabel", "roomName", "trackName", "formatName"] as const) {
      expect(card?.[field], field).toBe(detail.slot[field]);
    }
  });
});
