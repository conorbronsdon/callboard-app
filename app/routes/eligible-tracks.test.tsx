/**
 * Eligible tracks, both ends: the organizer control that sets the allowlist and
 * the public submit path that is checked against it.
 *
 * The claim is "the organizer picks which tracks a form accepts, and a
 * submitter cannot land in any other one". A UI-only filter satisfies the first
 * half and none of the second, so every test here posts to the real route
 * action or calls `submitDraft` directly — no page is rendered, no select is
 * clicked, and the disallowed id used throughout is a REAL track on the same
 * event, because rejecting `"not-a-track"` would prove only that the id is
 * unknown, not that the allowlist is consulted.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, forms, sessions } from "~/db/schema";
import {
  ELIGIBLE_TRACK_INVALID_ERROR,
  ELIGIBLE_TRACK_UNSET_ERROR,
  checkEligibleTrack,
  parseFormSchema,
  resolveSubmittedTrack,
  toFormDefinition,
} from "~/lib/form-schema";
import { findDraft, submitDraft } from "~/lib/public-submit/draft.server";
import { TRACK_KEY } from "~/lib/public-submit/wizard";
import { signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  CFP_FORM_ID,
  EVENT_ID,
  EVENT_SLUG,
  seedDemoFixture,
  seedOtherEvent,
  type DemoFixture,
} from "~/test/fixtures";

import { action as builderAction } from "./admin.forms.edit";
import { action } from "./public.submit.step";

type ActionArgs = Parameters<typeof action>[0];

let ctx: TestDbContext;
let fixture: DemoFixture;
let speakerId: string;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  speakerId = fixture.speakerIds[0];
});
afterEach(() => ctx.close());

/** Turn the control on for the seeded CFP form. */
async function allowTracks(ids: string[]) {
  const row = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
  const schema = parseFormSchema(row.schema);
  await ctx.db
    .update(forms)
    .set({ schema: { ...schema, eligibleTrackIds: ids } as Record<string, unknown> })
    .where(eq(forms.id, CFP_FORM_ID));
}

const ABSTRACT = "A".repeat(220);

/** The submission step's happy-path body, plus whatever the test overrides. */
const body = (over: Record<string, string> = {}) => ({
  intent: "next",
  title: "Cost modelling for multi-agent systems",
  abstract: ABSTRACT,
  track: "Agents",
  format: "Talk",
  ...over,
});

async function postSubmissionStep(fields: Record<string, string>) {
  const url = `https://x.test/submit/${EVENT_SLUG}/${CFP_FORM_ID}/step/submission`;
  const request = await signedInPost(url, speakerId, fields);
  return action({
    request,
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID, step: "submission" },
    context: {},
  } as unknown as ActionArgs);
}

const errorsOf = async (result: unknown) => {
  const payload = await (result as { data: { errors: Record<string, string> } }).data;
  return payload.errors;
};

describe("eligible tracks — the public submit path", () => {
  it("rejects a disallowed track on a direct POST that bypasses the UI", async () => {
    const [allowed, disallowed] = fixture.trackIds;
    await allowTracks([allowed]);

    const result = await postSubmissionStep(body({ [TRACK_KEY]: disallowed }));

    expect((result as { init?: { status?: number } }).init?.status).toBe(400);
    expect((await errorsOf(result))[TRACK_KEY]).toBe(ELIGIBLE_TRACK_INVALID_ERROR);

    // …and the rejected id is not quietly kept on the draft for a later step to
    // inherit.
    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    expect(draft?.trackId ?? null).toBeNull();
  });

  it("rejects a blank track when the form requires one", async () => {
    await allowTracks([fixture.trackIds[0]]);
    const result = await postSubmissionStep(body({ [TRACK_KEY]: "" }));
    expect((result as { init?: { status?: number } }).init?.status).toBe(400);
    expect((await errorsOf(result))[TRACK_KEY]).toBe(ELIGIBLE_TRACK_UNSET_ERROR);
  });

  it("accepts an allowed track and stores it on the draft — must fire", async () => {
    const [allowed] = fixture.trackIds;
    await allowTracks([allowed, fixture.trackIds[1]]);

    const result = await postSubmissionStep(body({ [TRACK_KEY]: allowed }));
    // A redirect to the next step, not a 400.
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toContain("/step/participant");

    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    expect(draft?.trackId).toBe(allowed);
  });

  it("ignores a posted track when the control is off — must not fire", async () => {
    // No eligible tracks configured: the form asks nothing, so a hand-built
    // POST naming a real track must not become the submission's track either.
    const result = await postSubmissionStep(body({ [TRACK_KEY]: fixture.trackIds[2] }));
    expect(result).toBeInstanceOf(Response);

    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    expect(draft?.trackId ?? null).toBeNull();
  });
});

/* ------------------------------------------------- the gate next to the write */

describe("eligible tracks — the gate next to the write", () => {
  it("refuses a tampered draft at submit, and writes nothing", async () => {
    const [allowed, disallowed] = fixture.trackIds;
    await allowTracks([allowed]);
    await postSubmissionStep(body({ [TRACK_KEY]: allowed }));

    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    const event = (await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }))!;
    const form = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    const submitter = (await ctx.db.query.people.findMany()).find(
      (person) => person.id === speakerId,
    )!;

    const result = await submitDraft({
      request: new Request("https://x.test/submit"),
      event,
      form,
      def: toFormDefinition(form),
      // The draft blob edited between steps: the id is a real track on this
      // event, and the form does not accept it.
      draft: { ...draft!, trackId: disallowed },
      submitter,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ineligible_track");

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, draft!.id) });
    expect(row!.status).toBe("draft");
    expect(row!.trackId).toBeNull();
    expect(row!.friendlyId).toBeNull();
  });

  it("writes the submitter's choice to sessions.track_id — must still fire", async () => {
    const [allowed] = fixture.trackIds;
    await allowTracks([allowed]);
    await postSubmissionStep(body({ [TRACK_KEY]: allowed }));

    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    const event = (await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }))!;
    const form = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    const submitter = (await ctx.db.query.people.findMany()).find(
      (person) => person.id === speakerId,
    )!;

    const result = await submitDraft({
      request: new Request("https://x.test/submit"),
      event,
      form,
      def: toFormDefinition(form),
      draft: draft!,
      submitter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trackId).toBe(allowed);

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, draft!.id) });
    expect(row!.status).toBe("pending");
    expect(row!.trackId).toBe(allowed);
  });

  it("leaves routing in charge when the control is off — must still fire", async () => {
    // The seeded form routes everything to its default track. Turning eligible
    // tracks OFF must leave that untouched, or this feature silently changed
    // every form that never asked for it.
    await postSubmissionStep(body());
    const draft = await findDraft(EVENT_ID, CFP_FORM_ID, speakerId);
    const event = (await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }))!;
    const form = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    const submitter = (await ctx.db.query.people.findMany()).find(
      (person) => person.id === speakerId,
    )!;

    const result = await submitDraft({
      request: new Request("https://x.test/submit"),
      event,
      form,
      def: toFormDefinition(form),
      draft: draft!,
      submitter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `routing.defaultTrackId` in the fixture is trackIds[0].
    expect(result.trackId).toBe(fixture.trackIds[0]);
  });
});

/* -------------------------------------------------- the pure allowlist rule */

describe("checkEligibleTrack / resolveSubmittedTrack", () => {
  it("stands down entirely when no tracks are configured", () => {
    expect(checkEligibleTrack({ eligibleTrackIds: [], chosen: "anything" })).toEqual({
      ok: true,
      trackId: null,
    });
    expect(
      resolveSubmittedTrack({ eligibleTrackIds: [], chosen: "chosen", routed: "routed" }),
    ).toBe("routed");
  });

  it("lets the submitter's pick beat routing once the control is on", () => {
    expect(
      resolveSubmittedTrack({ eligibleTrackIds: ["a"], chosen: "a", routed: "routed" }),
    ).toBe("a");
  });

  it("refuses blanks and non-members — must not fire", () => {
    expect(checkEligibleTrack({ eligibleTrackIds: ["a"], chosen: "" }).ok).toBe(false);
    expect(checkEligibleTrack({ eligibleTrackIds: ["a"], chosen: null }).ok).toBe(false);
    expect(checkEligibleTrack({ eligibleTrackIds: ["a"], chosen: "b" }).ok).toBe(false);
    // …and the member it does accept, so the check is not simply always false.
    expect(checkEligibleTrack({ eligibleTrackIds: ["a"], chosen: " a " })).toEqual({
      ok: true,
      trackId: "a",
    });
  });

  it("parses a stored list tolerantly, stripping blanks and duplicates", () => {
    const schema = parseFormSchema({
      eligibleTrackIds: ["a", "a", "", "  ", 7, null, "b"],
    });
    expect(schema.eligibleTrackIds).toEqual(["a", "b"]);
    // A form written before the control existed reads as "off", not as broken.
    expect(parseFormSchema({}).eligibleTrackIds).toEqual([]);
  });
});

/* ------------------------------------------------- the organizer control */

describe("eligible tracks — the builder control", () => {
  async function saveEligible(ids: string[]) {
    const url = `https://x.test/admin/forms/${CFP_FORM_ID}/abstract`;
    const cookie = await signedInPost(url, fixture.adminId, {});
    const body = new URLSearchParams({ intent: "save-eligible-tracks", step: "abstract" });
    for (const id of ids) body.append("eligibleTrackIds", id);

    return builderAction({
      request: new Request(url, {
        method: "POST",
        headers: {
          cookie: cookie.headers.get("cookie") ?? "",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      params: { formId: CFP_FORM_ID, step: "abstract" },
      context: {},
    } as unknown as Parameters<typeof builderAction>[0]);
  }

  const storedIds = async () => {
    const row = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    return parseFormSchema(row.schema).eligibleTrackIds;
  };

  it("saves the ticked tracks and clears them again", async () => {
    await saveEligible([fixture.trackIds[0], fixture.trackIds[2]]);
    expect(await storedIds()).toEqual([fixture.trackIds[0], fixture.trackIds[2]]);

    await saveEligible([]);
    expect(await storedIds()).toEqual([]);
  });

  it("refuses a track from another event and stores nothing — must not fire", async () => {
    const other = await seedOtherEvent(ctx.db);
    await saveEligible([fixture.trackIds[0]]);

    const result = await saveEligible([fixture.trackIds[0], other.trackId]);
    expect((result as { data?: { ok?: boolean } }).data?.ok).toBe(false);
    // The previous, valid list survives: a rejected save is not a partial save.
    expect(await storedIds()).toEqual([fixture.trackIds[0]]);
  });
});
