/**
 * Dashboard tiles, asserted by VALUE against the demo seed.
 *
 * Both tiles were wrong in ways a rendered-page check cannot see:
 * `accepted` counted the abstract AND the program session composed from it, and
 * `openTasks` ignored `in_progress`, so a speaker who had started every task
 * looked finished.
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, forms, people, sessionParticipants, sessions, tasks } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { ProgrammeReadinessPanel, loader } from "./admin.index";

type LoaderArgs = Parameters<typeof loader>[0];
const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(url = "https://x.test/admin") {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}

describe("admin dashboard counts", () => {
  it("reports the seed's exact values", async () => {
    const data = await load();
    expect(data.counts).toMatchObject({
      abstracts: 8,
      accepted: 2,
      openTasks: 4,
      openForms: 1,
    });
    // Exact key set, so a tile added to the card without a count is caught here
    // rather than rendering `undefined` on the dashboard.
    expect(Object.keys(data.counts ?? {}).sort()).toEqual([
      "abstracts",
      "accepted",
      "openForms",
      "openTasks",
      "submissionsThisWeek",
    ]);
    expect(data.readiness).not.toBeNull();
    expect(data.readiness?.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["cfp", "ready"],
      ["reviews", "attention"],
      ["speakers", "attention"],
      ["agenda", "ready"],
    ]);
  });

  it("counts only forms that are OPEN, not every form on the event", async () => {
    const before = await load();
    expect(before.counts?.openForms).toBe(1);

    await ctx.db.insert(forms).values({
      id: "000000fo-0000-4000-8000-000000000090",
      eventId: fixture.eventId,
      name: "Sponsor sessions",
      target: "session",
      status: "draft",
    });
    // A draft form is not open, so the tile must not move.
    expect((await load()).counts?.openForms).toBe(1);

    await ctx.db
      .update(forms)
      .set({ status: "open" })
      .where(eq(forms.id, "000000fo-0000-4000-8000-000000000090"));
    expect((await load()).counts?.openForms).toBe(2);
  });

  it("counts submissions from the last 7 days, and only those", async () => {
    const baseline = (await load()).counts?.submissionsThisWeek ?? 0;

    await ctx.db.insert(sessions).values({
      id: "000000se-0000-4000-8000-000000000090",
      eventId: fixture.eventId,
      title: "Arrived today",
      isAbstract: true,
      status: "pending",
      createdAt: new Date(),
    });
    expect((await load()).counts?.submissionsThisWeek).toBe(baseline + 1);

    await ctx.db.insert(sessions).values({
      id: "000000se-0000-4000-8000-000000000091",
      eventId: fixture.eventId,
      title: "Arrived a month ago",
      isAbstract: true,
      status: "pending",
      createdAt: new Date(Date.now() - 30 * 86_400_000),
    });
    // Must NOT fire: outside the window.
    expect((await load()).counts?.submissionsThisWeek).toBe(baseline + 1);
  });

  it("counts accepted ABSTRACTS, not the program sessions composed from them", async () => {
    const data = await load();
    // The seed has 4 rows with status `accepted`: 2 abstracts + the 2 sessions
    // they were composed into. The tile must show 2.
    const allAccepted = ctx.sqlite
      .prepare("select count(*) as n from sessions where status = 'accepted'")
      .get() as { n: number };
    expect(allAccepted.n).toBe(4);
    expect(data.counts?.accepted).toBe(2);
  });

  it("counts in_progress tasks as outstanding", async () => {
    const before = await load();
    expect(before.counts?.openTasks).toBe(4);

    // A speaker who has started a task has NOT finished it.
    await ctx.db
      .update(tasks)
      .set({ status: "in_progress" })
      .where(eq(tasks.id, "000000ta-0000-4000-8000-000000000001"));

    const after = await load();
    expect(after.counts?.openTasks).toBe(5);
  });

  it("does not count complete or waived tasks", async () => {
    await ctx.db
      .update(tasks)
      .set({ status: "waived" })
      .where(eq(tasks.id, "000000ta-0000-4000-8000-000000000002"));

    const data = await load();
    // That id was a `pending` task in the seed, so waiving it drops the count.
    expect(data.counts?.openTasks).toBe(3);
  });

  it("returns the zero state when no event exists yet", async () => {
    ctx.close();
    ctx = installTestDb();
    const [admin] = await ctx.db
      .insert(people)
      .values({ email: "solo-admin@callboard.dev", role: "admin" })
      .returning();

    const data = await loader(
      asLoaderArgs(await signedInGet("https://x.test/admin", admin.id)),
    );
    expect(data).toEqual({ event: null, counts: null, readiness: null });
  });

  it("403s a signed-in non-admin instead of looping them to /login (DECISIONS #19)", async () => {
    const request = await signedInGet("https://x.test/admin", fixture.speakerIds[0]);
    await expect(loader(asLoaderArgs(request))).rejects.toMatchObject({ status: 403 });
  });
});

describe("admin dashboard readiness", () => {
  it("renders the seeded producer checklist with actionable, accessible targets", async () => {
    const data = await load();
    const html = renderToStaticMarkup(
      ProgrammeReadinessPanel({ readiness: data.readiness! }),
    );

    expect(html).toContain('aria-labelledby="programme-readiness-heading"');
    expect(html).toContain("Producer checklist");
    expect(html).toContain("2 need attention");
    expect(html).toContain("2 pending submissions without a review assignment");
    expect(html).toContain("Follow up with speakers");
    expect(html).toContain('href="/admin/reviews"');
    expect(html).toContain('href="/admin/agenda"');
    expect(html).toContain('href="/admin/embeds?w=agenda"');
    expect(html).toContain('href="/admin/embeds?w=speakers"');
  });

  it("renders useful waiting states when a configured event has no activity", async () => {
    await ctx.db.delete(tasks);
    await ctx.db.delete(sessionParticipants);
    await ctx.db.delete(sessions);

    const data = await load();
    const html = renderToStaticMarkup(
      ProgrammeReadinessPanel({ readiness: data.readiness! }),
    );

    expect(html).toContain("No submissions have arrived yet");
    expect(html).toContain("No accepted speakers need onboarding yet");
    expect(html).toContain("No accepted sessions are ready to schedule yet");
    expect(html).toContain("No current blockers");
    expect(html).not.toContain("w=agenda");
    expect(html).not.toContain("w=speakers");
  });

  it("counts person-level onboarding work for accepted speakers, but not other speakers", async () => {
    const before = await load();
    const beforeSpeakers = before.readiness?.stages.find((stage) => stage.id === "speakers");
    expect(beforeSpeakers?.details).toContain("4 speaker tasks still outstanding.");

    // Travel/hotel forms are often attached to the person rather than a talk.
    await ctx.db
      .update(tasks)
      .set({ sessionId: null })
      .where(eq(tasks.id, "000000ta-0000-4000-8000-000000000002"));
    const personLevel = await load();
    expect(personLevel.readiness?.stages.find((stage) => stage.id === "speakers")?.details).toContain(
      "4 speaker tasks still outstanding.",
    );

    // Must NOT fire: an open task for a speaker with no accepted programme
    // session is real work, but it is not accepted-speaker readiness work.
    await ctx.db.insert(tasks).values({
      id: "unaccepted-speaker-task",
      eventId: fixture.eventId,
      personId: fixture.speakerIds[6],
      title: "Not accepted yet",
      status: "pending",
    });
    const after = await load();
    expect(after.readiness?.stages.find((stage) => stage.id === "speakers")?.details).toContain(
      "4 speaker tasks still outstanding.",
    );
  });

  it("must fire for the selected event and must not include another event's blockers", async () => {
    const baseline = await load();
    const createdAt = new Date(Date.now() + 60_000);
    const otherEventId = "other-event";
    const otherSpeakerId = "other-speaker";
    const otherAbstractId = "other-abstract";
    const otherSessionId = "other-session";

    await ctx.db.insert(events).values({
      id: otherEventId,
      name: "Other Conference",
      slug: "other-conference",
      createdAt,
      updatedAt: createdAt,
    });
    await ctx.db.insert(people).values({
      id: otherSpeakerId,
      email: "other-speaker@example.com",
      fullName: "Other Speaker",
      role: "speaker",
    });
    await ctx.db.insert(forms).values({
      id: "other-form",
      eventId: otherEventId,
      name: "Other CFP",
      target: "submission",
      surface: "cfp",
      status: "open",
    });
    await ctx.db.insert(sessions).values([
      {
        id: otherAbstractId,
        eventId: otherEventId,
        title: "Other pending abstract",
        isAbstract: true,
        status: "pending",
      },
      {
        id: otherSessionId,
        eventId: otherEventId,
        title: "Other unscheduled session",
        isAbstract: false,
        status: "accepted",
        isPublic: false,
      },
    ]);
    await ctx.db.insert(sessionParticipants).values({
      sessionId: otherSessionId,
      personId: otherSpeakerId,
      role: "speaker",
      isPrimary: true,
    });
    await ctx.db.insert(tasks).values({
      id: "other-task",
      eventId: otherEventId,
      personId: otherSpeakerId,
      sessionId: otherSessionId,
      title: "Other event task",
      status: "pending",
    });

    expect((await load()).readiness).toEqual(baseline.readiness);

    const other = await load("https://x.test/admin?event=other-conference");
    expect(other.event?.name).toBe("Other Conference");
    expect(other.readiness?.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["cfp", "ready"],
      ["reviews", "attention"],
      ["speakers", "attention"],
      ["agenda", "attention"],
    ]);
    expect(other.readiness?.stages.find((stage) => stage.id === "reviews")?.details).toContain(
      "1 pending submission without a review assignment.",
    );
  });
});
