import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reviewAssignments,
  reviewRounds,
  reviewTeams,
  sessions,
} from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { action, loader, ReviewOperationsView } from "./admin.reviews";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const BASE = "https://x.test/admin/reviews";
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

async function setupRoundAndTeam() {
  const roundId = "assign-round-0000-4000-8000-000000000001";
  const teamId = "assign-team-0000-4000-8000-000000000001";
  await ctx.db.insert(reviewRounds).values({
    id: roundId,
    eventId: fixture.eventId,
    name: "Assignment round",
    ordinal: 1,
  });
  await ctx.db.insert(reviewTeams).values({
    id: teamId,
    eventId: fixture.eventId,
    name: "Assignment team",
  });
  return { roundId, teamId };
}

async function post(fields: Record<string, string>) {
  return action(
    asActionArgs(await signedInPost(BASE, fixture.adminId, fields)),
  );
}

async function assignmentsFor(roundId: string) {
  return ctx.db
    .select()
    .from(reviewAssignments)
    .where(eq(reviewAssignments.roundId, roundId));
}

describe("track-filtered bulk review assignment", () => {
  it("must fire only for every matching abstract and stays idempotent", async () => {
    const { roundId, teamId } = await setupRoundAndTeam();
    const trackId = fixture.trackIds[2];

    const first = await post({
      intent: "assign-all-matching",
      roundId,
      teamId,
      assignTrack: trackId,
    });
    expect((first as Response).status).toBe(302);

    const inTrack = new Set([fixture.abstractIds[2], fixture.abstractIds[5]]);
    let assigned = await assignmentsFor(roundId);
    expect(assigned.filter((row) => inTrack.has(row.sessionId))).toHaveLength(2);
    expect(assigned.filter((row) => !inTrack.has(row.sessionId))).toHaveLength(0);

    await post({ intent: "assign-all-matching", roundId, teamId, assignTrack: trackId });
    assigned = await assignmentsFor(roundId);
    expect(assigned).toHaveLength(2);
    expect(new Set(assigned.map((row) => row.sessionId)).size).toBe(2);
  });

  it("must not fire for abstracts belonging to another event", async () => {
    const other = await seedOtherEvent(ctx.db);
    const { roundId, teamId } = await setupRoundAndTeam();

    await post({ intent: "assign-all-matching", roundId, teamId, assignTrack: "" });

    const assigned = await assignmentsFor(roundId);
    expect(assigned).toHaveLength(4);
    expect(assigned.filter((row) => other.abstractIds.includes(row.sessionId))).toHaveLength(0);
  });

  it("must fire in the loader only for a valid selected-event track", async () => {
    const unfiltered = await loader(
      asLoaderArgs(await signedInGet(BASE, fixture.adminId)),
    );
    const filtered = await loader(
      asLoaderArgs(
        await signedInGet(`${BASE}?assignTrack=${fixture.trackIds[2]}`, fixture.adminId),
      ),
    );
    const unknown = await loader(
      asLoaderArgs(await signedInGet(`${BASE}?assignTrack=unknown`, fixture.adminId)),
    );

    expect(unfiltered.submissions).toHaveLength(4);
    expect(filtered.submissions).toHaveLength(2);
    expect(filtered.submissions.every((row) => row.trackId === fixture.trackIds[2])).toBe(true);
    expect(filtered.submissions.map((row) => row.trackName)).toEqual([
      "Infrastructure",
      "Infrastructure",
    ]);
    expect(unknown.submissions).toHaveLength(4);
    expect(unknown.assignTrack).toBeNull();
  });

  it("rejects a round or team outside the selected event", async () => {
    const other = await seedOtherEvent(ctx.db);
    const { roundId, teamId } = await setupRoundAndTeam();

    expect(
      await post({
        intent: "assign-all-matching",
        roundId: other.roundId,
        teamId,
        assignTrack: "",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await post({
        intent: "assign-all-matching",
        roundId,
        teamId: other.teamId,
        assignTrack: "",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await ctx.db
        .select()
        .from(reviewAssignments)
        .where(
          and(
            eq(reviewAssignments.roundId, roundId),
            eq(reviewAssignments.teamId, teamId),
          ),
        ),
    ).toHaveLength(0);
  });
});

/**
 * ABS-06 — the bulk assign that looked like it did nothing.
 *
 * The write was never the problem (the suite above already proved it fires and
 * stays idempotent). The organizer filtered 13 abstracts down to 2, pressed
 * "Assign all matching", and got a bare redirect back to a page that looked
 * exactly as it had before — no count, no banner, no way to tell a successful
 * bulk write from a silent no-op without going and reading the database.
 *
 * These assert the RESULT the organizer can actually see, through the same
 * `role="status"` banner the reminder action already reports through, and they
 * pin the one number that is easy to get wrong: `onConflictDoNothing` means the
 * rows SENT are not the rows written, so a second press must not claim to have
 * assigned everything a second time.
 */
describe("the organizer can see that the bulk assign happened", () => {
  /** Follow the action's redirect into the loader, the way a browser does. */
  async function noticeAfter(response: Response) {
    const location = response.headers.get("location") as string;
    const data = await loader(
      asLoaderArgs(await signedInGet(`https://x.test${location}`, fixture.adminId)),
    );
    return data.notice;
  }

  it("must fire: the count of what was assigned reaches the screen", async () => {
    const { roundId, teamId } = await setupRoundAndTeam();
    const trackId = fixture.trackIds[2];

    const response = (await post({
      intent: "assign-all-matching",
      roundId,
      teamId,
      assignTrack: trackId,
    })) as Response;

    // The write, and the number the organizer is told about it, must agree.
    expect(await assignmentsFor(roundId)).toHaveLength(2);
    expect(await noticeAfter(response)).toBe("Assigned 2 submissions to that review team.");

    // And it is rendered, not merely returned.
    const data = await loader(
      asLoaderArgs(
        await signedInGet(
          `https://x.test${response.headers.get("location")}`,
          fixture.adminId,
        ),
      ),
    );
    const viewProps = data as unknown as Parameters<typeof ReviewOperationsView>[0];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewOperationsView {...viewProps} />
      </MemoryRouter>,
    );
    expect(html).toContain("Assigned 2 submissions to that review team.");
    expect(html).toContain('role="status"');
  });

  it("must NOT fire: a second press does not claim to have assigned them again", async () => {
    const { roundId, teamId } = await setupRoundAndTeam();
    const fields = { intent: "assign-all-matching", roundId, teamId, assignTrack: fixture.trackIds[2] };

    await post(fields);
    const second = (await post(fields)) as Response;

    expect(await assignmentsFor(roundId)).toHaveLength(2);
    expect(await noticeAfter(second)).toBe(
      "2 submissions matched, and every one was already assigned to that team.",
    );
  });

  it("must NOT fire: a filter that matches nothing does not report a success", async () => {
    const { roundId, teamId } = await setupRoundAndTeam();
    // Every abstract in this track is already assigned to a DIFFERENT team, so
    // "matched" and "already assigned to THIS team" must not be conflated.
    const emptyTrack = fixture.trackIds[1];
    await ctx.db
      .update(sessions)
      .set({ status: "withdrawn" })
      .where(eq(sessions.trackId, emptyTrack));

    const response = (await post({
      intent: "assign-all-matching",
      roundId,
      teamId,
      assignTrack: emptyTrack,
    })) as Response;

    expect(await assignmentsFor(roundId)).toHaveLength(0);
    expect(await noticeAfter(response)).toBe(
      "No submissions matched that filter — nothing to assign.",
    );
  });

  it("must NOT fire: an unrelated visit to the page shows no assignment banner", async () => {
    // The notice is derived from the query string, so a plain page load — and a
    // hand-typed nonsense value — must stay silent rather than invent a receipt.
    for (const query of ["", "?assigned=", "?assigned=-1", "?assigned=5&matched=2"]) {
      const data = await loader(
        asLoaderArgs(await signedInGet(`${BASE}${query}`, fixture.adminId)),
      );
      expect(data.notice, query).toBeNull();
    }
  });
});
