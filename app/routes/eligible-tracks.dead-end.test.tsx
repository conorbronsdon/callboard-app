/**
 * The eligible-tracks dead end: a form that is open and impossible to submit.
 *
 * `checkEligibleTrack` demands a choice whenever the CONFIGURED id list is
 * non-empty (form-schema.ts:274). The picker renders from the RESOLVED list
 * (public.submit.step.tsx:754). Delete every track a form lists as eligible and
 * the two disagree: the select disappears, the server keeps requiring a track,
 * the `__track` error renders inside the block that is no longer there, and the
 * error summary filters `__`-prefixed keys out (`:702`, rendered at `:864`).
 * The submitter got a 400 and a page that said nothing at all.
 *
 * The must-fire below therefore asserts on the RENDERED page, not on the
 * loader: "no rendered error" is the defect, so a payload-only assertion could
 * not fail on it. Beside it sit the two forms this must not touch — one with
 * live eligible tracks, one with the control off — because "close the form"
 * satisfies the must-fire on its own and would take the whole public CFP down.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, tracks } from "~/db/schema";
import { parseFormSchema } from "~/lib/form-schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  CFP_FORM_ID,
  EVENT_SLUG,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import { loader } from "./public.submit.step";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
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

const path = `/submit/${EVENT_SLUG}/${CFP_FORM_ID}/step/submission`;

async function load() {
  const request = await signedInGet(`https://x.test${path}`, fixture.speakerIds[0]);
  return loader({
    request,
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID, step: "submission" },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

/** The page a submitter following the link actually gets. */
async function markup(): Promise<string> {
  const data = await load();
  const { default: PublicSubmitStep } = await import("./public.submit.step");
  const Stub = createRoutesStub([
    {
      path: "/submit/:eventSlug/:formId/step/:step",
      Component: () =>
        PublicSubmitStep({ loaderData: data, actionData: undefined } as unknown as Parameters<
          typeof PublicSubmitStep
        >[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={[path]} />);
}

/* ─────────────────────────────────────────────────────────── must fire ───── */

describe("a form whose eligible tracks have all been deleted", () => {
  it("renders an honest closed state instead of an unsubmittable form", async () => {
    const [allowed] = fixture.trackIds;
    await allowTracks([allowed]);
    // The organizer deletes the track. The id survives in the form's JSON,
    // which is the whole shape of the defect.
    await ctx.db.delete(tracks).where(eq(tracks.id, allowed));

    const view = (await load()).view;
    expect(view.eligibleTracks).toEqual([]);
    expect(view.closed).toBe("no_eligible_tracks");

    const html = await markup();
    expect(html).toContain('data-testid="closed-notice"');
    expect(html).toContain("no longer exist");
    // Red on the unfixed tree: the wizard rendered, with no track picker and
    // no way to satisfy the server gate hiding behind it.
    expect(html).not.toContain('data-testid="submission-form"');
    expect(html).not.toContain('data-testid="track-select"');
  });

  it("fires the same way when every eligible id points at another event", async () => {
    // Same disagreement, different cause: the ids resolve to nothing because
    // `eligibleTracksFor` filters to THIS event. A fix that only looked at
    // "were the rows deleted" would miss it.
    await allowTracks(["11111111-1111-4111-8111-111111111111"]);

    expect((await load()).view.closed).toBe("no_eligible_tracks");
    expect(await markup()).toContain('data-testid="closed-notice"');
  });
});

/* ──────────────────────────────────────────────────── must NOT fire ───── */

describe("forms that must be left alone", () => {
  it("a form with live eligible tracks still renders its picker", async () => {
    const [allowed, other] = fixture.trackIds;
    await allowTracks([allowed, other]);

    const view = (await load()).view;
    expect(view.closed).toBeNull();
    expect(view.eligibleTracks).toHaveLength(2);

    const html = await markup();
    expect(html).toContain('data-testid="submission-form"');
    expect(html).toContain('data-testid="track-select"');
    expect(html).not.toContain('data-testid="closed-notice"');
  });

  it("a form with ONE of two eligible tracks deleted still accepts submissions", async () => {
    // The boundary. "Some resolved" is not "none resolved", and treating a
    // partially stale list as a dead end would close a form that works.
    const [allowed, other] = fixture.trackIds;
    await allowTracks([allowed, other]);
    await ctx.db.delete(tracks).where(eq(tracks.id, other));

    const view = (await load()).view;
    expect(view.closed).toBeNull();
    expect(view.eligibleTracks.map((track) => track.id)).toEqual([allowed]);
    expect(await markup()).toContain('data-testid="track-select"');
  });

  it("a form with the control OFF is untouched, even with no tracks on the event", async () => {
    // The case the new state must never be confused with. An empty
    // `eligibleTrackIds` means the organizer never asked the question, and
    // `checkEligibleTrack` returns ok for it — the form is open and stays open.
    await ctx.db.delete(tracks).where(inArray(tracks.id, fixture.trackIds));

    const view = (await load()).view;
    expect(view.closed).toBeNull();
    expect(view.eligibleTracks).toEqual([]);

    const html = await markup();
    expect(html).toContain('data-testid="submission-form"');
    expect(html).not.toContain('data-testid="track-select"');
    expect(html).not.toContain('data-testid="closed-notice"');
  });

  it("a genuinely closed form still says it closed on its date", async () => {
    // The presentation is shared, so the existing reasons have to keep their
    // own copy rather than inheriting the new sentence.
    await ctx.db
      .update(forms)
      .set({ closesAt: new Date(Date.now() - 60_000) })
      .where(eq(forms.id, CFP_FORM_ID));

    expect((await load()).view.closed).toBe("past_close_date");
    const html = await markup();
    expect(html).toContain("stopped accepting submissions on its close date");
    expect(html).not.toContain("no longer exist");
  });
});
