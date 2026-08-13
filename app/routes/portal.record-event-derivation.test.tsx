/**
 * SPK-09 / CNT-02 — "every task link on the portal list 404s".
 *
 * The portal list renders `/portal/tasks/${task.id}` with no event context
 * (portal.index.tsx, portal.tasks.tsx) and `portal-progress.ts` builds the same
 * bare link for the "next action" card. That is fine for a single-event speaker
 * and broken for everyone else, because the DETAIL route re-derived its event
 * from ambient portal resolution rather than from the record the URL names.
 *
 * ── The mechanism ────────────────────────────────────────────────────────────
 * `portalContext` (issue #86) answers "which event is this portal showing?" from
 * the speaker's MEMBERSHIPS: one membership wins outright, several fall back to
 * the request's event when the speaker belongs to it. A multi-event speaker
 * browsing under `?event=B` therefore sees event B's tasks in the list — and
 * every link on that list drops the query param, so the detail request resolves
 * the DEFAULT event A one click later. `requireOwnTask` then filters
 * `taskId AND personId AND eventId=A`, the row is in B, and the speaker gets a
 * confident 404 on a task that is unambiguously theirs.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * Same principle as #86: the input that is actually about this request wins. The
 * URL names a RECORD, so the record's own event is the answer — look the task up
 * by id and owner, take its `event_id`, then verify the acting speaker's
 * membership in THAT event and scope the page to it. Ambient resolution never
 * gets a vote on a record-addressed page.
 *
 * ── What keeps this honest ───────────────────────────────────────────────────
 * The must-not-fires are the whole test. "Trust the record's event" without the
 * membership re-check would hand a removed speaker their old event's tasks back,
 * and dropping the `personId` filter to "simplify" the lookup would expose every
 * other speaker's task — so both are asserted red-handed below, alongside the
 * single-membership path that must not move at all.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventPeople, tasks } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
  type OtherEventFixture,
} from "~/test/fixtures";

import { loader as portalTaskLoader } from "./portal.task";
import { loader as portalSubmissionEditLoader } from "./portal.submission.edit";

let ctx: TestDbContext;
let fixture: DemoFixture;
let other: OtherEventFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  other = await seedOtherEvent(ctx.db);
});
afterEach(() => ctx.close());

const taskArgs = (request: Request, taskId: string) =>
  ({ request, params: { taskId }, context: {} }) as unknown as Parameters<
    typeof portalTaskLoader
  >[0];

const submissionArgs = (request: Request, sessionId: string) =>
  ({ request, params: { sessionId }, context: {} }) as unknown as Parameters<
    typeof portalSubmissionEditLoader
  >[0];

/**
 * Attach the second event's speaker to the DEFAULT event as well.
 *
 * This is the shape that breaks: `currentEvent()` returns the oldest event off
 * `/admin`, the speaker now belongs to it, so `portalContext` resolves the
 * default event for a bare `/portal/tasks/:id` — while every record this speaker
 * actually owns lives in the second event.
 */
async function alsoJoinDefaultEvent(personId: string) {
  await ctx.db.insert(eventPeople).values({
    eventId: fixture.eventId,
    personId,
    eventRole: "speaker",
  });
}

describe("a task link resolves the task's OWN event", () => {
  it("must fire: a multi-event speaker opens their task with no ?event= and gets it", async () => {
    await alsoJoinDefaultEvent(other.speakerId);

    const request = await signedInGet(
      `https://x.test/portal/tasks/${other.taskId}`,
      other.speakerId,
    );
    const data = await portalTaskLoader(taskArgs(request, other.taskId));

    // Not merely "did not throw": the payload is the task the URL named.
    expect(data.task.id).toBe(other.taskId);
    expect(data.task.title).toBe("Confirm your slot");
  });

  it("must fire: the same link works from a list rendered under the OTHER event's ?event=", async () => {
    // The list was browsed under `?event=<default>`; the link drops the param.
    // Neither the ambient default nor a stale query param may decide the record.
    await alsoJoinDefaultEvent(other.speakerId);

    const url = `https://x.test/portal/tasks/${other.taskId}?event=${EVENT_SLUG}`;
    const signed = await signedInGet(url, other.speakerId);
    const data = await portalTaskLoader(taskArgs(signed, other.taskId));
    expect(data.task.id).toBe(other.taskId);
  });

  it("must NOT fire: a single-membership speaker's task is unchanged", async () => {
    // No second membership: this is the path #86 fixed and this change must not
    // touch. The default event's speaker owns the default event's tasks.
    const row = await ctx.db.query.tasks.findFirst({
      where: eq(tasks.personId, fixture.speakerIds[0]),
    });
    const request = await signedInGet(
      `https://x.test/portal/tasks/${row!.id}`,
      fixture.speakerIds[0],
    );
    const data = await portalTaskLoader(taskArgs(request, row!.id));
    expect(data.task.id).toBe(row!.id);
  });

  it("must NOT fire: another speaker's task is still a 404", async () => {
    // Deriving the event from the record must not weaken the OWNER filter --
    // the event id was never the thing doing the authorising.
    await alsoJoinDefaultEvent(other.speakerId);
    const request = await signedInGet(
      `https://x.test/portal/tasks/${other.taskId}`,
      fixture.speakerIds[0],
    );
    await expect(portalTaskLoader(taskArgs(request, other.taskId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("must NOT fire: a task in an event the speaker was removed from is a 404", async () => {
    // The record's event is a POINTER, not a permission. Drop the membership and
    // the task must go with it, or "trust the record" becomes a way back in.
    await ctx.db
      .delete(eventPeople)
      .where(
        and(
          eq(eventPeople.eventId, other.eventId),
          eq(eventPeople.personId, other.speakerId),
        ),
      );
    await alsoJoinDefaultEvent(other.speakerId);

    const request = await signedInGet(
      `https://x.test/portal/tasks/${other.taskId}`,
      other.speakerId,
    );
    await expect(portalTaskLoader(taskArgs(request, other.taskId))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("a submission edit link resolves the submission's OWN event", () => {
  it("must fire: a multi-event speaker edits their submission with no ?event=", async () => {
    await alsoJoinDefaultEvent(other.speakerId);

    const sessionId = other.abstractIds[1];
    const request = await signedInGet(
      `https://x.test/portal/submissions/${sessionId}/edit`,
      other.speakerId,
    );
    const data = await portalSubmissionEditLoader(submissionArgs(request, sessionId));
    expect(data.submission.id).toBe(sessionId);
  });

  it("must NOT fire: a submission the speaker does not own is still a 404", async () => {
    await alsoJoinDefaultEvent(other.speakerId);
    const sessionId = other.abstractIds[1];
    const request = await signedInGet(
      `https://x.test/portal/submissions/${sessionId}/edit`,
      fixture.speakerIds[0],
    );
    await expect(
      portalSubmissionEditLoader(submissionArgs(request, sessionId)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("must NOT fire: a single-membership speaker's submission edit is unchanged", async () => {
    const sessionId = fixture.abstractIds[0];
    const request = await signedInGet(
      `https://x.test/portal/submissions/${sessionId}/edit`,
      fixture.speakerIds[0],
    );
    const data = await portalSubmissionEditLoader(submissionArgs(request, sessionId));
    expect(data.submission.id).toBe(sessionId);
  });
});
