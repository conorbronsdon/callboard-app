/**
 * The queued decision must not leave the SERVER.
 *
 * `statusPresentation` collapses `accept_queue` and `decline_queue` into an
 * identical "Under review" pill, and `portal-progress.test.ts` proves it does.
 * Both of those things are true one layer above where the leak was:
 * `react-router.config.ts` sets `ssr: true`, so every loader payload is
 * serialised into the document for hydration. A speaker on `/portal` could hit
 * view-source and read `"status":"accept_queue"` before the organiser committed
 * anything — the presentation layer masked a value the server had already sent.
 *
 * So the assertions below are on the WIRE, not on the component: they execute
 * the real loaders and search the serialised payload for the raw tokens. A
 * component-level check cannot fail on this defect, which is exactly how it
 * shipped green.
 *
 * Three kinds of assertion, deliberately side by side:
 *
 *  - **must-fire** — neither queue token appears in any portal loader payload.
 *    Red on the unfixed tree for `/portal`, `/portal/submissions` and the edit
 *    route.
 *  - **must-still-fire** — a COMMITTED `accepted` / `declined` / `pending` /
 *    `withdrawn` / `draft` still serialises truthfully. Masking the queue must
 *    not mask the decision; a loader that stripped `status` entirely would pass
 *    every must-fire and break the product.
 *  - **UI unchanged** — the rendered markup for every status is pinned by exact
 *    copy. These pass on the unfixed tree AND on the fixed one, which is what
 *    makes "the visible UI does not change" a measured claim rather than an
 *    intention.
 *
 * Organiser surfaces are out of scope by design: an organiser legitimately sees
 * the raw queue, and `admin.reviews` / `admin.submissions` keep their own
 * coverage of that.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_STATUSES, sessionParticipants, sessions, type SessionStatus } from "~/db/schema";
import { speakerVisibleStatus, statusPresentation } from "~/lib/portal-progress";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { loader as portalHome } from "./portal.index";
import { loader as portalSubmissions } from "./portal.submissions";
import { loader as portalEdit } from "./portal.submission.edit";

const args = (request: Request, params: Record<string, string> = {}) =>
  ({ request, params, context: {} }) as never;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

const homeFor = async (personId: string) =>
  portalHome(args(await signedInGet("https://x.test/portal", personId)));

const listFor = async (personId: string) =>
  portalSubmissions(args(await signedInGet("https://x.test/portal/submissions", personId)));

const editFor = async (personId: string, sessionId: string) =>
  portalEdit(
    args(
      await signedInGet(`https://x.test/portal/submissions/${sessionId}/edit`, personId),
      { sessionId },
    ),
  );

/** Every portal payload a speaker can pull for one of their own submissions. */
async function payloadsFor(personId: string, sessionId: string) {
  return [
    ["/portal", await homeFor(personId)],
    ["/portal/submissions", await listFor(personId)],
    ["/portal/submissions/:id/edit", await editFor(personId, sessionId)],
  ] as const;
}

/**
 * What SSR puts in the document. `JSON.stringify` is the honest proxy: the
 * serializer react-router uses emits the same string VALUES, and the defect is
 * one of those string values being present at all.
 */
const wire = (payload: unknown): string => JSON.stringify(payload);

const statusOf = async (sessionId: string) =>
  (await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) }))?.status;

const setStatus = (sessionId: string, status: SessionStatus) =>
  ctx.db.update(sessions).set({ status }).where(eq(sessions.id, sessionId));

/* ─────────────────────────────────────── the projection, in isolation ───── */

describe("speakerVisibleStatus", () => {
  it("must fire: both queues collapse onto one token", () => {
    expect(speakerVisibleStatus("accept_queue")).toBe("pending");
    expect(speakerVisibleStatus("decline_queue")).toBe("pending");
    expect(speakerVisibleStatus("accept_queue")).toBe(speakerVisibleStatus("decline_queue"));
  });

  it("must NOT fire: every other status passes through unchanged", () => {
    // The control. A projection that flattened everything to "pending" would
    // satisfy the test above and erase the decision the portal exists to show.
    for (const status of SESSION_STATUSES) {
      if (status === "accept_queue" || status === "decline_queue") continue;
      expect(speakerVisibleStatus(status)).toBe(status);
    }
  });

  it("projects onto the token whose presentation is already identical", () => {
    // Why `pending` and not a new token: the pill must not move a pixel.
    for (const status of ["accept_queue", "decline_queue"] as const) {
      expect(statusPresentation(speakerVisibleStatus(status))).toEqual(
        statusPresentation(status),
      );
    }
  });
});

/* ────────────────────────────────────── must-fire: the leak itself ───── */

describe("no portal loader serialises a queued decision", () => {
  /*
   * Both queues, because the direction is not the point: telling a speaker they
   * are in the ACCEPT queue is the same leak wearing a smile. The fixture is
   * already in these states (app/test/fixtures.ts SUBMISSIONS), so each case
   * reads the status back out of the database instead of assuming it.
   */
  it.each([
    ["accept_queue", 2],
    ["decline_queue", 5],
  ] as const)("keeps %s out of every payload a speaker can pull", async (status, index) => {
    const personId = fixture.speakerIds[index];
    const sessionId = fixture.abstractIds[index];
    expect(await statusOf(sessionId)).toBe(status);

    for (const [route, payload] of await payloadsFor(personId, sessionId)) {
      expect(`${route} ${wire(payload)}`).not.toContain("accept_queue");
      expect(`${route} ${wire(payload)}`).not.toContain("decline_queue");
    }
  });

  it("keeps both queues out of the payload for a speaker who has one of each", async () => {
    // One person, two submissions, one queued each way — the case a per-row
    // mask that missed a code path would still look clean on.
    const personId = fixture.speakerIds[2];
    await ctx.db.insert(sessionParticipants).values({
      sessionId: fixture.abstractIds[5],
      personId,
      role: "co_speaker",
      isPrimary: false,
      order: 1,
    });

    const home = await homeFor(personId);
    const list = await listFor(personId);
    expect(home.submissions).toHaveLength(2);
    expect(wire(home)).not.toContain("accept_queue");
    expect(wire(home)).not.toContain("decline_queue");
    expect(wire(list)).not.toContain("accept_queue");
    expect(wire(list)).not.toContain("decline_queue");
  });
});

/* ─────────────────── must-still-fire: the decision still travels ───── */

describe("a committed decision still serialises truthfully", () => {
  /*
   * The control for every test above. A loader that dropped `status` from the
   * payload, or projected every status to "pending", would satisfy all of them
   * and quietly break the screen the walkthrough says must lead with acceptance
   * status.
   */
  it.each(["accepted", "declined", "pending", "withdrawn", "draft"] as const)(
    "still sends %s to the speaker who owns it",
    async (status) => {
      await setStatus(fixture.abstractIds[3], status);

      const home = await homeFor(fixture.speakerIds[3]);
      const list = await listFor(fixture.speakerIds[3]);
      expect(wire(home)).toContain(`"status":"${status}"`);
      expect(wire(list)).toContain(`"status":"${status}"`);
    },
  );

  it("keeps the acceptance card counting the committed accept", async () => {
    const home = await homeFor(fixture.speakerIds[0]);
    expect(home.submissions.map((row) => row.status)).toEqual(["accepted"]);
  });
});

/* ───────────────────────── UI unchanged: green before AND after ───── */

/**
 * What the speaker actually sees, per status, on `/portal/submissions`.
 *
 * `pending` and both queues share a pill because that is the mask. They do NOT
 * share the edit affordance: `speakerEditLockReason` locks a queued proposal
 * through `SPEAKER_EDITABLE_STATUSES`, which is a known leak of the FACT that
 * something was staged (sweep finding #2, decided as a ride-along). A
 * server-side projection must not move that in either direction — silently
 * REOPENING editing on a queued proposal would be a real behaviour change — so
 * the lock copy is pinned here per status.
 */
const EXPECTED: Record<SessionStatus, { pill: string; hint: string; affordance: string }> = {
  pending: {
    pill: "Under review",
    hint: "The program committee has not decided yet.",
    affordance: "Edit submission",
  },
  accept_queue: {
    pill: "Under review",
    hint: "The program committee has not decided yet.",
    affordance: "Editing is closed while the programme team reviews this proposal.",
  },
  decline_queue: {
    pill: "Under review",
    hint: "The program committee has not decided yet.",
    affordance: "Editing is closed while the programme team reviews this proposal.",
  },
  accepted: {
    pill: "Accepted",
    hint: "You&#x27;re on the program. Finish your onboarding tasks.",
    affordance: "Edit submission",
  },
  declined: {
    pill: "Not accepted",
    hint: "This one didn&#x27;t make the program this year.",
    affordance: "Editing is closed while the programme team reviews this proposal.",
  },
  withdrawn: {
    pill: "Withdrawn",
    hint: "You withdrew this submission.",
    affordance: "Editing is closed while the programme team reviews this proposal.",
  },
  draft: {
    pill: "Draft",
    hint: "Not submitted yet — finish it before the form closes.",
    affordance: "This draft can be resumed from its original submission link.",
  },
};

async function submissionsMarkup(personId: string): Promise<string> {
  const data = await listFor(personId);
  const { default: PortalSubmissions } = await import("./portal.submissions");
  const Stub = createRoutesStub([
    {
      path: "/portal/submissions",
      Component: () =>
        PortalSubmissions({ loaderData: data } as unknown as Parameters<
          typeof PortalSubmissions
        >[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/portal/submissions"]} />);
}

describe("the rendered portal is what it was", () => {
  it.each(Object.keys(EXPECTED) as SessionStatus[])(
    "renders a %s submission with the same copy as before the projection",
    async (status) => {
      await setStatus(fixture.abstractIds[3], status);

      const markup = await submissionsMarkup(fixture.speakerIds[3]);
      const expected = EXPECTED[status];
      expect(markup).toContain(expected.pill);
      expect(markup).toContain(expected.hint);
      expect(markup).toContain(expected.affordance);
    },
  );

  it("renders a queued accept and a queued decline identically", async () => {
    await setStatus(fixture.abstractIds[3], "accept_queue");
    const accept = await submissionsMarkup(fixture.speakerIds[3]);
    await setStatus(fixture.abstractIds[3], "decline_queue");
    const decline = await submissionsMarkup(fixture.speakerIds[3]);
    expect(accept).toBe(decline);
  });
});
