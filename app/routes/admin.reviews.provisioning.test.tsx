/**
 * Reviewer provisioning, direct assignment, and reviewer-output visibility.
 *
 * Covers CFP-10 (an organizer can create a reviewer who is NOT an organizer),
 * ABS-05 (assign named submissions to a named reviewer; the queue holds exactly
 * those), and CFP-11 (the organizer can read every reviewer's per-criterion
 * scores and comment text).
 *
 * Every claim here is a PAIR. The interesting half is usually the second one:
 * "an organizer can add a reviewer" passes trivially if the reviewer is minted
 * as a global admin, which is the bug the item exists to catch — so the
 * must-not-fire assertions carry the weight, and several of them ship with a
 * control proving the assertion is discriminating rather than vacuous.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  eventPeople,
  people,
  reviewAssignments,
  reviewRounds,
  reviews,
  reviewTeamMembers,
  reviewTeams,
  tasks,
} from "~/db/schema";
import { createLoginSession } from "~/lib/auth/auth.server";
import { selectRecipients } from "~/lib/comms/bulk";
import { loadComposeRecipients } from "~/lib/comms/bulk.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";
import { env } from "~/test/workers-env";

import {
  ReviewOperationsView,
  action as reviewsAction,
  loader as reviewsLoader,
  type ReviewActionData,
} from "./admin.reviews";
import { loader as speakersLoader } from "./admin.speakers";
import {
  loader as submissionLoader,
  submissionLoaderPayload,
} from "./admin.submission";
import { action as tasksAction, loader as tasksLoader } from "./admin.tasks";
import { action as reviewerAction, loader as reviewerLoader } from "./review.index";
import { loader as portalSubmissionsLoader } from "./portal.submissions";

type Args = { request: Request; params: Record<string, string>; context: unknown };
const args = (request: Request, params: Record<string, string> = {}) =>
  ({ request, params, context: {} }) as unknown as Args as never;

const ROUND = "a1000000-0000-4000-8000-000000000001";
const RIVAL_TEAM = "a1000000-0000-4000-8000-000000000002";
const RIVAL_MEMBER = "a1000000-0000-4000-8000-000000000003";
const REVIEWER_EMAIL = "sam.whitfield@example.com";

/** Weights 2 and 1, so a 4/3 score totals 4*2 + 3*1 = 11. */
const RUBRIC = {
  criteria: [
    { key: "fit", label: "Programme fit", min: 1, max: 5, weight: 2 },
    { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
  ],
};

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(reviewRounds).values({
    id: ROUND,
    eventId: fixture.eventId,
    name: "Screening",
    ordinal: 1,
    rubric: RUBRIC,
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60_000),
  });
});
afterEach(() => ctx.close());

/* ------------------------------------------------------------- helpers */

async function postAs(url: string, personId: string, entries: [string, string][]) {
  const cookie = (await createLoginSession(new Request(url), personId)).split(";")[0];
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return new Request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const REVIEWS_URL = "https://x.test/admin/reviews";

async function adminPost(entries: [string, string][]) {
  return reviewsAction(args(await postAs(REVIEWS_URL, fixture.adminId, entries)));
}

async function adminLoad() {
  return reviewsLoader(args(await signedInGet(REVIEWS_URL, fixture.adminId)));
}

/** The Response a guard threw, or the value it resolved with. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (error) => error,
  );
}

async function inviteReviewer(name = "Sam Whitfield", email = REVIEWER_EMAIL) {
  const result = await adminPost([
    ["intent", "invite-reviewer"],
    ["name", name],
    ["email", email],
  ]);
  const person = await ctx.db.query.people.findFirst({ where: eq(people.email, email) });
  return { result, person };
}

/* ---------------------------------------------------------- CFP-10 */

describe("CFP-10 — provisioning a reviewer", () => {
  it("must fire: creates a reviewer-capable identity from a name and email", async () => {
    const { result, person } = await inviteReviewer();

    expect(result).toMatchObject({ ok: true });
    expect(person?.fullName).toBe("Sam Whitfield");

    const membership = await ctx.db.query.eventPeople.findFirst({
      where: and(
        eq(eventPeople.eventId, fixture.eventId),
        eq(eventPeople.personId, person!.id),
      ),
    });
    expect(membership?.eventRole).toBe("reviewer");

    // And the organizer can now actually pick them: the dropdown is fed by the
    // loader, so a person who never reaches it cannot be added to a team.
    const data = await adminLoad();
    expect(data.reviewers.map((reviewer) => reviewer.email)).toContain(REVIEWER_EMAIL);
  });

  it("must NOT fire: the new reviewer is never granted the global admin role", async () => {
    const { person } = await inviteReviewer();
    expect(person?.role).toBe("speaker");

    // Control: `role` really is where admin authority lives, and the seeded
    // organizer carries it — so "not admin" is a discriminating assertion and
    // not one that a schema without the column would also pass.
    const organizer = await ctx.db.query.people.findFirst({
      where: eq(people.id, fixture.adminId),
    });
    expect(organizer?.role).toBe("admin");
  });

  it("must fire: an existing person is promoted in place, not duplicated", async () => {
    const speakerId = fixture.speakerIds[2];
    const existing = await ctx.db.query.people.findFirst({ where: eq(people.id, speakerId) });

    const result = await adminPost([
      ["intent", "invite-reviewer"],
      ["name", "Ignored — they already have a name"],
      ["email", existing!.email],
    ]);
    expect(result).toMatchObject({ ok: true });

    const rows = await ctx.db.select().from(people).where(eq(people.email, existing!.email));
    expect(rows).toHaveLength(1);
    expect(rows[0].fullName).toBe(existing!.fullName);

    // ADDITIVE. `event_role` is untouched and `is_reviewer` carries the grant —
    // see the "promotion is additive" block below for why overwriting the role
    // deleted this person from three shipped surfaces.
    const membership = await ctx.db.query.eventPeople.findFirst({
      where: and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, speakerId)),
    });
    expect(membership?.eventRole).toBe("speaker");
    expect(membership?.isReviewer).toBe(true);

    // And the grant is real: the organizer can now pick them for a committee.
    const data = await adminLoad();
    expect(data.reviewers.map((reviewer) => reviewer.id)).toContain(speakerId);
  });

  it("must NOT fire: a plain event speaker is neither offered nor accepted as a reviewer", async () => {
    const speakerId = fixture.speakerIds[0];
    await adminPost([["intent", "create-team"], ["name", "Programme committee"]]);
    const [team] = await ctx.db.select().from(reviewTeams).where(eq(reviewTeams.eventId, fixture.eventId));

    const before = await adminLoad();
    expect(before.reviewers.map((reviewer) => reviewer.id)).not.toContain(speakerId);

    // The dropdown is only chrome. A hand-built POST naming them must be
    // refused SERVER-side, and must leave no membership row behind.
    const rejected = await adminPost([
      ["intent", "add-member"],
      ["teamId", team.id],
      ["personId", speakerId],
    ]);
    expect(rejected).toMatchObject({ ok: false });

    const members = await ctx.db
      .select()
      .from(reviewTeamMembers)
      .where(eq(reviewTeamMembers.teamId, team.id));
    expect(members).toHaveLength(0);

    // Control: the same POST for a reviewer-capable person DOES land, so the
    // rejection above is the predicate working and not the route being broken.
    const { person } = await inviteReviewer();
    const accepted = await adminPost([
      ["intent", "add-member"],
      ["teamId", team.id],
      ["personId", person!.id],
    ]);
    expect(accepted).toBeInstanceOf(Response);
    const after = await ctx.db
      .select()
      .from(reviewTeamMembers)
      .where(eq(reviewTeamMembers.teamId, team.id));
    expect(after.map((row) => row.personId)).toEqual([person!.id]);
  });
});

/* ------------------------------ promotion is ADDITIVE, not a replacement */

/**
 * Inviting an existing SPEAKER as a reviewer used to run
 *
 *     else if (membership.eventRole === "speaker")
 *       set({ eventRole: "reviewer" })
 *
 * and `event_people` holds ONE row per person per event, so that update was a
 * silent DELETE from every surface reading `event_role = 'speaker'` by equality.
 * Three shipped surfaces do exactly that, and none of them errors — they just
 * return one row fewer, which is why nothing caught it:
 *
 *   1. `speakerRoster()` in admin.tasks — the task-assignee list, AND the
 *      allow-list the create action validates against, so the person also
 *      stopped being a legal assignee.
 *   2. `selectRecipients()` in comms/bulk — every audience is derived from
 *      `candidates.filter(c => c.eventRole === "speaker")`, so an ACCEPTED
 *      speaker who agreed to review stopped matching `all_speakers` and never
 *      received another logistics email.
 *   3. the /admin/speakers roster row, which renders `event_role` as the label.
 *
 * Each case below is a pair: the promoted speaker must still be there, and a
 * person who is ONLY a reviewer must still be absent. Without the second half
 * every assertion would also pass on "delete the speaker filter entirely",
 * which fixes the symptom by breaking the surface.
 */
describe("inviting an existing speaker grants review capability without removing them", () => {
  /** Speaker 3 owns abstract 3 (see the CFP-11 block), so their portal is non-empty. */
  const SPEAKER = 3;

  /** Promote the fixture speaker, and return their id plus a reviewer-only foil. */
  async function promotedSpeaker() {
    const speaker = await ctx.db.query.people.findFirst({
      where: eq(people.id, fixture.speakerIds[SPEAKER]),
    });
    await adminPost([
      ["intent", "invite-reviewer"],
      ["name", ""],
      ["email", speaker!.email],
    ]);
    // The foil: provisioned the same way, but with no prior membership, so they
    // are a reviewer and nothing else.
    const { person: reviewerOnly } = await inviteReviewer();
    return { speakerId: speaker!.id, reviewerOnlyId: reviewerOnly!.id };
  }

  it("must fire: the promoted speaker keeps their speaker role and gains the flag", async () => {
    const { speakerId } = await promotedSpeaker();
    const membership = await ctx.db.query.eventPeople.findFirst({
      where: and(eq(eventPeople.eventId, fixture.eventId), eq(eventPeople.personId, speakerId)),
    });

    expect(membership?.eventRole).toBe("speaker");
    expect(membership?.isReviewer).toBe(true);
  });

  it("must fire: they stay on the task-assignee roster, and a task still assigns", async () => {
    const { speakerId, reviewerOnlyId } = await promotedSpeaker();

    const data = await tasksLoader(
      args(await signedInGet("https://x.test/admin/tasks", fixture.adminId)),
    );
    expect(data.roster.map((person) => person.id)).toContain(speakerId);

    // The loader only feeds the dropdown; the ACTION re-derives the roster and
    // refuses an assignee who is not on it. Assert the write, not the widget.
    const created = await tasksAction(
      args(
        await postAs("https://x.test/admin/tasks", fixture.adminId, [
          ["intent", "create"],
          ["title", "Send us your slides"],
          ["taskType", "general"],
          ["dueOn", ""],
          ["assignTo", "selected"],
          ["personIds", speakerId],
        ]),
      ),
    );
    expect(created).toBeInstanceOf(Response);
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.personId, speakerId));
    expect(rows.map((row) => row.title)).toContain("Send us your slides");

    // MUST NOT FIRE: the reviewer-only foil is not a speaker and is still
    // refused — so the assertions above are the role surviving, not the filter
    // having been deleted.
    expect(data.roster.map((person) => person.id)).not.toContain(reviewerOnlyId);
    const refused = await tasksAction(
      args(
        await postAs("https://x.test/admin/tasks", fixture.adminId, [
          ["intent", "create"],
          ["title", "Not for a reviewer"],
          ["taskType", "general"],
          ["dueOn", ""],
          ["assignTo", "selected"],
          ["personIds", reviewerOnlyId],
        ]),
      ),
    );
    expect(refused).toMatchObject({ ok: false });
  });

  it("must fire: they still match the all_speakers comms audience", async () => {
    const { speakerId, reviewerOnlyId } = await promotedSpeaker();
    const candidates = await loadComposeRecipients({ eventId: fixture.eventId, db: ctx.db });
    const audience = selectRecipients(candidates, "all_speakers").map((row) => row.personId);

    expect(audience).toContain(speakerId);
    // MUST NOT FIRE: the reviewer-only foil is in `candidates` — the roster
    // query has no role filter — and is excluded by `selectRecipients`. That is
    // the complement that makes the assertion above discriminating.
    expect(candidates.map((row) => row.personId)).toContain(reviewerOnlyId);
    expect(audience).not.toContain(reviewerOnlyId);
  });

  it("must fire: the /admin/speakers roster still labels them a speaker", async () => {
    const { speakerId, reviewerOnlyId } = await promotedSpeaker();
    const data = await speakersLoader(
      args(await signedInGet("https://x.test/admin/speakers", fixture.adminId)),
    );
    const row = data.speakers.find((person) => person.id === speakerId);

    expect(row?.eventRole).toBe("speaker");
    // The roster lists every membership, so the foil appears too — but labelled
    // as what they are. A roster that printed "reviewer" for the promoted
    // speaker would be the old bug rendered.
    expect(data.speakers.find((person) => person.id === reviewerOnlyId)?.eventRole).toBe("reviewer");
  });

  it("must fire: their portal still resolves and still shows their submission", async () => {
    const { speakerId } = await promotedSpeaker();
    const portal = await portalSubmissionsLoader(
      args(await signedInGet("https://x.test/portal/submissions", speakerId)),
    );

    expect(portal.submissions.length).toBeGreaterThan(0);
    expect(JSON.stringify(portal)).toContain(fixture.abstractIds[SPEAKER]);
  });

  it("must NOT fire: the promoted speaker gains no organizer surface", async () => {
    const { speakerId } = await promotedSpeaker();

    const surfaces: [string, unknown][] = [
      [
        "GET /admin/reviews",
        await thrownBy(reviewsLoader(args(await signedInGet(REVIEWS_URL, speakerId)))),
      ],
      [
        "GET /admin/tasks",
        await thrownBy(
          tasksLoader(args(await signedInGet("https://x.test/admin/tasks", speakerId))),
        ),
      ],
      [
        "GET /admin/speakers",
        await thrownBy(
          speakersLoader(args(await signedInGet("https://x.test/admin/speakers", speakerId))),
        ),
      ],
    ];

    for (const [label, outcome] of surfaces) {
      expect(outcome, `${label} did not throw`).toBeInstanceOf(Response);
      expect((outcome as Response).status, label).toBe(403);
    }

    // And the grant did not reach the GLOBAL role, which is where /admin lives.
    const person = await ctx.db.query.people.findFirst({ where: eq(people.id, speakerId) });
    expect(person?.role).toBe("speaker");
    // Control: the organizer reaches all three, so 403 is about this identity.
    await expect(adminLoad()).resolves.toBeTruthy();
  });
});

/* -------------------------------------- CFP-10: separation from admin */

describe("CFP-10 — a reviewer is not an organizer", () => {
  async function provisionedReviewer() {
    const { person } = await inviteReviewer();
    await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", fixture.abstractIds[3]],
    ]);
    return person!;
  }

  it("must fire: the non-admin reviewer can score the abstract assigned to them", async () => {
    const reviewer = await provisionedReviewer();
    const response = await reviewerAction(
      args(
        await postAs("https://x.test/review", reviewer.id, [
          ["intent", "save-review"],
          ["roundId", ROUND],
          ["sessionId", fixture.abstractIds[3]],
          ["score-fit", "4"],
          ["score-clarity", "3"],
          ["comment", "Solid, but the demo needs a rehearsal."],
        ]),
      ),
    );

    expect(response).toBeInstanceOf(Response);
    const stored = await ctx.db.query.reviews.findFirst({
      where: and(eq(reviews.roundId, ROUND), eq(reviews.reviewerId, reviewer.id)),
    });
    expect(stored?.totalScore).toBe(11);
    expect(stored?.comment).toBe("Solid, but the demo needs a rehearsal.");
    expect(stored?.submittedAt).not.toBeNull();
  });

  it("must NOT fire: the same reviewer is refused by every organizer entry point", async () => {
    const reviewer = await provisionedReviewer();

    const surfaces: [string, unknown][] = [
      [
        "GET /admin/reviews",
        await thrownBy(reviewsLoader(args(await signedInGet(REVIEWS_URL, reviewer.id)))),
      ],
      [
        "POST /admin/reviews",
        await thrownBy(
          reviewsAction(
            args(
              await postAs(REVIEWS_URL, reviewer.id, [
                ["intent", "create-team"],
                ["name", "Committee of one"],
              ]),
            ),
          ),
        ),
      ],
      [
        "GET /admin/submissions/:id",
        await thrownBy(
          submissionLoader(
            args(
              await signedInGet(
                `https://x.test/admin/submissions/${fixture.abstractIds[3]}`,
                reviewer.id,
              ),
              { id: fixture.abstractIds[3] },
            ),
          ),
        ),
      ],
    ];

    for (const [label, outcome] of surfaces) {
      expect(outcome, `${label} did not throw`).toBeInstanceOf(Response);
      expect((outcome as Response).status, label).toBe(403);
    }

    // Control: the organizer reaches all three, so 403 is about this identity
    // and not about the request shape these assertions build.
    await expect(adminLoad()).resolves.toBeTruthy();
  });
});

/* ---------------------------------------------------------- ABS-05 */

describe("ABS-05 — direct per-submission assignment", () => {
  async function assignedReviewer() {
    const { person } = await inviteReviewer();
    await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", fixture.abstractIds[3]],
      ["sessionId", fixture.abstractIds[4]],
    ]);
    return person!;
  }

  it("must fire: the queue holds exactly the two abstracts that were named", async () => {
    const reviewer = await assignedReviewer();
    const data = await reviewerLoader(args(await signedInGet("https://x.test/review", reviewer.id)));

    expect(data.assignments.map((entry) => entry.sessionId).sort()).toEqual(
      [fixture.abstractIds[3], fixture.abstractIds[4]].sort(),
    );
    expect(data.assignments).toHaveLength(2);
  });

  it("must NOT fire: an abstract assigned to another committee stays out of that queue", async () => {
    const reviewer = await assignedReviewer();

    // A rival committee, holding a THIRD abstract in the same open round.
    await ctx.db.insert(reviewTeams).values({
      id: RIVAL_TEAM,
      eventId: fixture.eventId,
      name: "Evals committee",
    });
    await ctx.db.insert(people).values({
      id: RIVAL_MEMBER,
      email: "rival@example.com",
      fullName: "Rival Reviewer",
      role: "speaker",
    });
    await ctx.db.insert(reviewTeamMembers).values({ teamId: RIVAL_TEAM, personId: RIVAL_MEMBER });
    await ctx.db.insert(reviewAssignments).values({
      id: "a1000000-0000-4000-8000-000000000004",
      roundId: ROUND,
      sessionId: fixture.abstractIds[5],
      teamId: RIVAL_TEAM,
    });

    const mine = await reviewerLoader(args(await signedInGet("https://x.test/review", reviewer.id)));
    expect(mine.assignments.map((entry) => entry.sessionId)).not.toContain(fixture.abstractIds[5]);
    expect(mine.assignments).toHaveLength(2);

    // Control: that third abstract IS assigned and reachable — by the person it
    // was assigned to. Without this, an always-empty queue would pass above.
    const theirs = await reviewerLoader(
      args(await signedInGet("https://x.test/review", RIVAL_MEMBER)),
    );
    expect(theirs.assignments.map((entry) => entry.sessionId)).toEqual([fixture.abstractIds[5]]);
  });

  it("must NOT fire: submissions from another event are refused for a named reviewer", async () => {
    const { person } = await inviteReviewer();
    const rejected = await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", "00000000-0000-4000-8000-000000000999"],
    ]);
    expect(rejected).toMatchObject({ ok: false });
    const rows = await ctx.db.select().from(reviewAssignments).where(eq(reviewAssignments.roundId, ROUND));
    expect(rows).toHaveLength(0);
  });
});

/* ---------------------------------------------------------- ABS-02 */

describe("ABS-02 — the per-round reviewer pool is legible", () => {
  it("must fire: a round card names the committee holding its assignments", async () => {
    const { person } = await inviteReviewer();
    await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", fixture.abstractIds[3]],
    ]);

    const html = renderToStaticMarkup(<ReviewOperationsView {...(await adminLoad())} />);

    expect(html).toContain("Round 1 reviewer pool");
    expect(html).toContain("Solo · Sam Whitfield");
    expect(html).toContain("Committees (shared across rounds)");
    // The link that makes the two-level model navigable rather than merely true.
    expect(html).toContain('href="#reviewer-teams"');
    expect(html).toContain('id="reviewer-teams"');
  });

  it("must NOT fire: a committee with no assignments in the round is left out of its pool", async () => {
    const { person } = await inviteReviewer();
    await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", fixture.abstractIds[3]],
    ]);
    // A second committee that exists but holds nothing in this round. If the
    // pool were rendered from the global team list — the bug this item is
    // about — it would appear here anyway.
    await adminPost([["intent", "create-team"], ["name", "Idle committee"]]);

    const html = renderToStaticMarkup(<ReviewOperationsView {...(await adminLoad())} />);
    const poolBlock = html.slice(
      html.indexOf("Round 1 reviewer pool"),
      html.indexOf("Reviewer progress"),
    );

    expect(poolBlock).not.toContain("Idle committee");
    // Controls: the slice really is the pool block, and the idle committee IS
    // on the page — so its absence above is scoping, not a missing team.
    expect(poolBlock).toContain("Solo · Sam Whitfield");
    expect(html).toContain("Idle committee");
  });
});

/* ---------------------------------------------------------- CFP-11 */

describe("CFP-11 — the organizer reads reviewer output", () => {
  const COMMENT = "Deepest treatment in the pile, but the speaker needs a run-through.";

  async function reviewerWhoScored() {
    const { person } = await inviteReviewer();
    await adminPost([
      ["intent", "assign-reviewer"],
      ["roundId", ROUND],
      ["personId", person!.id],
      ["sessionId", fixture.abstractIds[3]],
    ]);
    await reviewerAction(
      args(
        await postAs("https://x.test/review", person!.id, [
          ["intent", "save-review"],
          ["roundId", ROUND],
          ["sessionId", fixture.abstractIds[3]],
          ["score-fit", "4"],
          ["score-clarity", "3"],
          ["comment", COMMENT],
        ]),
      ),
    );
    return person!;
  }

  it("must fire: another reviewer's per-criterion scores and comment reach the organizer", async () => {
    const reviewer = await reviewerWhoScored();
    const data = submissionLoaderPayload(
      await submissionLoader(
        args(
          await signedInGet(
            `https://x.test/admin/submissions/${fixture.abstractIds[3]}`,
            fixture.adminId,
          ),
          { id: fixture.abstractIds[3] },
        ),
      ),
    );

    const round = data.rounds.find((entry) => entry.id === ROUND);
    expect(round?.submittedReviews).toHaveLength(1);
    const [entry] = round!.submittedReviews;
    expect(entry.reviewerName).toBe("Sam Whitfield");
    expect(entry.scores).toEqual({ fit: 4, clarity: 3 });
    expect(entry.totalScore).toBe(11);
    expect(entry.comment).toBe(COMMENT);
    expect(entry.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The organizer is NOT the author — this is the case the old self-scoped
    // `reviewerId === admin.id` lookup could never show.
    expect(entry.reviewerId).toBe(reviewer.id);
    expect(entry.reviewerId).not.toBe(fixture.adminId);
    // `round.review` stays the ADMIN's own editable draft, i.e. nothing.
    expect(round?.review).toBeNull();
  });

  it("must NOT fire: the comment never reaches a speaker-facing wire", async () => {
    await reviewerWhoScored();

    // Wire level, not component level: `ssr: true` serialises every loader
    // payload into the document, so a speaker could read a masked value from
    // view-source. The assertion is on the payload the server would send.
    const speakerId = fixture.speakerIds[3]; // owns abstractIds[3]
    const portal = await portalSubmissionsLoader(
      args(await signedInGet("https://x.test/portal/submissions", speakerId)),
    );
    const portalWire = JSON.stringify(portal);
    expect(portalWire).not.toContain(COMMENT);
    expect(portalWire).not.toContain("run-through");

    // Controls, both directions:
    //  1. the speaker's payload really is about this abstract — otherwise the
    //     absence above is just an empty object passing trivially.
    expect(portalWire).toContain(fixture.abstractIds[3]);
    //  2. the string is spelled the way the organizer's payload spells it, so a
    //     typo in COMMENT cannot make this test green on a leaking build.
    const admin = await submissionLoader(
      args(
        await signedInGet(
          `https://x.test/admin/submissions/${fixture.abstractIds[3]}`,
          fixture.adminId,
        ),
        { id: fixture.abstractIds[3] },
      ),
    );
    expect(JSON.stringify(admin)).toContain(COMMENT);
  });
});

/* ------------------------------- the invite panel's delivery claim is real */

/**
 * "A sign-in link was emailed to them" used to be printed because
 * `sendMagicLink()` returned without throwing:
 *
 *     mailed = true;   // inside the try
 *
 * `ConsoleMailer.send()` returns `{ ok: true }` unconditionally and has no
 * failure path at all, and MAIL_DRIVER=console is the default on a fresh clone,
 * what `scripts/run-e2e.mjs` pins, and what the judged demo runs. So the panel
 * made a delivery claim on precisely the configuration where nothing had been
 * delivered — and no test could have caught it, because the flag could not be
 * false.
 *
 * These cases drive the REAL selection path (`getMailer()` reading `appEnv()`),
 * not an injected stub: the bug lived in the gap between which driver is
 * configured and what the copy said, so a test that hands the route a mailer
 * would step over it. The three driver configurations are the three sentences,
 * and each case asserts BOTH the sentence that must appear and the one that
 * must not.
 */
describe("the invite panel reports the delivery the mailer observed", () => {
  const EMAILED = "A sign-in link was emailed to them";

  /** Render the success panel exactly as the route would, for one invite. */
  async function invitePanel(): Promise<string> {
    const result = (await inviteReviewer()).result as ReviewActionData;
    expect(result, "invite-reviewer did not succeed").toMatchObject({ ok: true });
    return renderToStaticMarkup(
      <ReviewOperationsView {...(await adminLoad())} actionData={result} />,
    );
  }

  /**
   * Point `getMailer()` at Resend and answer its ONE POST with `response`.
   *
   * `ResendMailer` captures `fetch.bind(globalThis)` in its constructor, so the
   * global has to be replaced before the route builds the mailer — which is
   * why this is a plain assignment made before the action runs, restored in
   * `afterEach` below.
   */
  const realFetch = globalThis.fetch;
  function useResend(response: () => Response) {
    delete env.MAIL_DRIVER;
    env.RESEND_API_KEY = "re_test_key";
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  }
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("must NOT fire: with MAIL_DRIVER=console the panel never claims an email was sent", async () => {
    env.MAIL_DRIVER = "console";
    const html = await invitePanel();

    expect(html).not.toContain(EMAILED);
    expect(html).not.toContain("emailed");
    // MUST FIRE: it says what DID happen, and names the driver that did it.
    expect(html).toContain("No email was sent");
    expect(html).toContain("console");
    // The reviewer is still provisioned — an honest report is not a failure.
    expect(html).toContain("as a reviewer on this event");
  });

  it("must fire: a provider that accepted the message earns the delivery claim", async () => {
    useResend(() => new Response('{"id":"1c1d"}', { status: 200 }));
    const html = await invitePanel();

    expect(html).toContain(EMAILED);
    // MUST NOT FIRE: the console sentence is gone. Without this, copy that
    // printed every state at once would pass the assertion above.
    expect(html).not.toContain("No email was sent");
    expect(html).not.toContain("may not have gone out");
  });

  it("must NOT fire: a provider rejection is never reported as a send", async () => {
    useResend(() => new Response("domain not verified", { status: 403 }));
    const html = await invitePanel();

    expect(html).not.toContain(EMAILED);
    // MUST FIRE: the failure is stated, with the provider's own reason, and the
    // organizer is told what to do next.
    expect(html).toContain("No delivery was confirmed");
    expect(html).toContain("HTTP 403");
    expect(html).toContain("Resend it from the sign-in page");
  });

  it("must NOT fire: a transport failure is never reported as a send either", async () => {
    // `ResendMailer` catches its own transport errors and returns `ok: false`,
    // so this arrives as the SAME state as a 403 — which is why the copy for it
    // says "no delivery was confirmed" rather than "the provider refused it".
    // A socket that hung up mid-POST may well have delivered the mail.
    useResend(() => {
      throw new Error("socket hang up");
    });
    const html = await invitePanel();

    expect(html).not.toContain(EMAILED);
    expect(html).toContain("No delivery was confirmed");
    expect(html).toContain("socket hang up");
    // The copy must not name a refuser that never spoke.
    expect(html).not.toContain("refused");
  });

  it("must fire: a send that never reaches the mailer is reported as indeterminate", async () => {
    // The rate limiter throws BEFORE `getMailer()` is reached — the route's own
    // catch, and the only path where the system genuinely has no observation to
    // report. `magicLinkEmail` is 5 per 15 minutes against the same address.
    //
    // `consumeRateLimit`'s window is FIXED, snapping to wall-clock :00/:15/:30/
    // :45 (`windowStart = Math.floor(now / windowMs) * windowMs` in
    // rate-limit.server.ts), and `sendMagicLink` never threads an injectable
    // `now` down to it — so a run straddling one of those marks resets the
    // counter mid-test and the 6th invite below stops being refused. Observed:
    // a run starting 12:44:54 had windowStart(12:44:58)=12:30:00 but
    // windowStart(12:45:02)=12:45:00. Pin the clock instead, the same
    // vi.useFakeTimers()/vi.setSystemTime() idiom
    // app/lib/admin/session-revisions.server.test.ts already uses for
    // wall-clock determinism elsewhere in this suite. 12:05:00 sits 5 minutes
    // clear of the nearest boundary on either side (:00 before, :15 after), so
    // the 6 sequential invites cannot roll into a fresh window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:05:00.000Z"));
    try {
      env.MAIL_DRIVER = "console";
      for (let attempt = 0; attempt < 5; attempt += 1) await inviteReviewer();
      const html = await invitePanel();

      expect(html).toContain("may not have gone out");
      expect(html).not.toContain(EMAILED);
      expect(html).not.toContain("No delivery was confirmed");
      // Control: the 5 attempts before the cap did NOT report this, so the state
      // is the rate limit firing and not the copy defaulting to it.
      expect(html).not.toContain("No email was sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("must fire: the four states are mutually exclusive on every driver", async () => {
    // The discriminator for the whole block. `mailed: boolean` could only ever
    // produce two sentences; if a future edit collapses the states back, one of
    // these renders will carry two of them and this fails where the individual
    // cases might not.
    const sentences = [
      EMAILED,
      "No email was sent",
      "No delivery was confirmed",
      "may not have gone out",
    ];
    const renders: [string, string][] = [];

    env.MAIL_DRIVER = "console";
    renders.push(["console", await invitePanel()]);
    useResend(() => new Response('{"id":"1c1d"}', { status: 200 }));
    renders.push(["resend ok", await invitePanel()]);
    useResend(() => new Response("nope", { status: 422 }));
    renders.push(["resend 422", await invitePanel()]);

    for (const [label, html] of renders) {
      expect(sentences.filter((sentence) => html.includes(sentence)), label).toHaveLength(1);
    }
  });
});
