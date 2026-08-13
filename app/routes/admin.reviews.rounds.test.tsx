import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewRounds } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, seedOtherEvent, type DemoFixture } from "~/test/fixtures";

import { ReviewOperationsView, action, loader } from "./admin.reviews";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

async function post(fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost("https://x.test/admin/reviews", fixture.adminId, fields)));
}

async function load() {
  return loader(asLoaderArgs(await signedInGet("https://x.test/admin/reviews", fixture.adminId)));
}

async function roundNamed(name: string) {
  return ctx.db.query.reviewRounds.findFirst({
    where: and(eq(reviewRounds.eventId, fixture.eventId), eq(reviewRounds.name, name)),
  });
}

describe("independent review-round date windows", () => {
  it("must fire: create and save persist distinct windows through a loader reload", async () => {
    await post({
      intent: "create-round",
      name: "Initial Review",
      opensAt: "2026-08-01",
      closesAt: "2026-10-15",
    });
    await post({
      intent: "create-round",
      name: "Final Review",
      opensAt: "2026-10-16",
      closesAt: "2026-11-30",
    });

    const initial = await roundNamed("Initial Review");
    expect(initial?.opensAt?.toISOString()).toBe("2026-08-01T07:00:00.000Z");
    expect(initial?.closesAt?.toISOString()).toBe("2026-10-16T06:59:00.000Z");

    await post({
      intent: "save-round-dates",
      roundId: initial!.id,
      opensAt: "2026-08-02",
      closesAt: "2026-10-14",
    });

    const payload = await load();
    expect(payload.rounds.map(({ name, opensAt, closesAt }) => ({ name, opensAt, closesAt }))).toEqual([
      {
        name: "Initial Review",
        opensAt: "2026-08-02T07:00:00.000Z",
        closesAt: "2026-10-15T06:59:00.000Z",
      },
      {
        name: "Final Review",
        opensAt: "2026-10-16T07:00:00.000Z",
        closesAt: "2026-12-01T07:59:00.000Z",
      },
    ]);
  });

  it("must fire: saving a blank close date clears the persisted close", async () => {
    await post({ intent: "create-round", name: "Screening", opensAt: "2026-08-01", closesAt: "2026-10-15" });
    const round = await roundNamed("Screening");
    await post({ intent: "save-round-dates", roundId: round!.id, opensAt: "2026-08-01", closesAt: "" });

    expect((await roundNamed("Screening"))?.closesAt).toBeNull();
  });

  it("must NOT fire: an inverted window is rejected without changing either date", async () => {
    await post({ intent: "create-round", name: "Screening", opensAt: "2026-08-01", closesAt: "2026-10-15" });
    const before = await roundNamed("Screening");
    const response = await post({
      intent: "save-round-dates",
      roundId: before!.id,
      opensAt: "2026-11-30",
      closesAt: "2026-10-16",
    });

    expect(response).toEqual({ ok: false, error: "The close date must be after the open date." });
    const after = await roundNamed("Screening");
    expect(after?.opensAt?.toISOString()).toBe(before?.opensAt?.toISOString());
    expect(after?.closesAt?.toISOString()).toBe(before?.closesAt?.toISOString());
  });

  it("must NOT fire: another event's round cannot be changed", async () => {
    const other = await seedOtherEvent(ctx.db);
    const before = await ctx.db.query.reviewRounds.findFirst({ where: eq(reviewRounds.id, other.roundId) });
    expect(await post({
      intent: "save-round-dates",
      roundId: other.roundId,
      opensAt: "2026-08-01",
      closesAt: "2026-10-15",
    })).toEqual({ ok: false, error: "That review round does not belong to this event." });
    const after = await ctx.db.query.reviewRounds.findFirst({ where: eq(reviewRounds.id, other.roundId) });
    expect(after?.opensAt?.toISOString()).toBe(before?.opensAt?.toISOString());
    expect(after?.closesAt?.toISOString()).toBe(before?.closesAt?.toISOString());
  });

  it("must fire: dated and dateless rounds render their visible window state", async () => {
    await post({ intent: "create-round", name: "Dated", opensAt: "2026-08-01", closesAt: "2026-10-15" });
    await post({ intent: "create-round", name: "Dateless" });
    const dateless = await roundNamed("Dateless");
    await post({ intent: "save-round-dates", roundId: dateless!.id, opensAt: "", closesAt: "" });
    const payload = await load();
    const html = renderToStaticMarkup(<ReviewOperationsView {...payload} />);

    expect(html).toContain("Open Aug 1, 2026 – Oct 15, 2026");
    expect(html).toContain("No dates set");
  });
});
