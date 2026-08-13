/**
 * Tracks config: CRUD rules with must-fire and must-not-fire, plus the zero
 * state — mirrors admin.agenda.rooms.test.tsx (AIA-02).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, sessions, tracks } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { TracksScreen, action, describeTrackReferences, loader } from "./admin.agenda.tracks";
import type { TracksData } from "./admin.agenda.tracks";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const BASE = "https://x.test/admin/agenda/tracks";
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

async function load(url = BASE): Promise<TracksData> {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}
async function post(fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(BASE, fixture.adminId, fields)));
}

/** Merge into the seeded CFP form's JSON schema, the way the forms editor does. */
async function patchFormSchema(patch: Record<string, unknown>) {
  const row = await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) });
  await ctx.db
    .update(forms)
    .set({ schema: { ...(row?.schema ?? {}), ...patch } })
    .where(eq(forms.id, CFP_FORM_ID));
}

/** A track nothing references: created here, so every seeded reference is absent. */
async function addUnusedTrack(name = "Community"): Promise<string> {
  await post({ intent: "create", name, color: "#e64980" });
  const created = (await load()).tracks.find((track) => track.name === name);
  if (!created) throw new Error(`fixture setup failed: ${name} was not created`);
  return created.id;
}

describe("loader", () => {
  it("lists the seeded tracks with color and BOTH assigned counts", async () => {
    const data = await load();
    expect(data.tracks.map((track) => track.name)).toEqual([
      "Agents",
      "Evals & Reliability",
      "Infrastructure",
    ]);
    expect(data.tracks[0].color).toBe("#329af0");
    // Two seeded programme sessions, one in each of the first two tracks.
    expect(data.tracks.map((track) => track.sessionCount)).toEqual([1, 1, 0]);
    /*
     * The discriminating half. Eight seeded abstracts spread round-robin over
     * three tracks, so submissions and sessions disagree per track: a count
     * that silently merged the two, or kept excluding abstracts, cannot produce
     * both of these lists. "Infrastructure" is the case that mattered — zero
     * programme sessions, two live submissions, and a Delete button beside it.
     */
    expect(data.tracks.map((track) => track.submissionCount)).toEqual([3, 3, 2]);
    expect(data.tracks[2]).toMatchObject({ sessionCount: 0, submissionCount: 2 });
  });
});

describe("describeTrackReferences", () => {
  it("MUST FIRE: names every kind of reference, pluralised", () => {
    expect(
      describeTrackReferences({
        name: "Agents",
        sessionCount: 1,
        submissionCount: 3,
        formNames: ["Call for Proposals 2026"],
      }),
    ).toBe(
      "“Agents” is still in use — 1 session, 3 submissions and 1 form (“Call for Proposals 2026”). " +
        "A form's eligible-track list and default track are JSON, not foreign keys, so the id would " +
        "stay on a public form the submit path still accepts. Reassign or clear those first.",
    );
  });

  it("drops the empty categories and switches the reason when no form is involved", () => {
    const message = describeTrackReferences({
      name: "Infrastructure",
      sessionCount: 0,
      submissionCount: 2,
      formNames: [],
    });
    expect(message).toContain("— 2 submissions.");
    expect(message).not.toContain("session,");
    expect(message).toContain("silently unassign them");
    expect(message).not.toContain("foreign keys");
  });

  it("MUST NOT FIRE: an unreferenced track produces no refusal", () => {
    expect(
      describeTrackReferences({
        name: "Community",
        sessionCount: 0,
        submissionCount: 0,
        formNames: [],
      }),
    ).toBeNull();
  });
});

describe("action: create", () => {
  it("MUST FIRE: adds a track that the agenda and CFP eligible-tracks config can then use", async () => {
    const response = (await post({
      intent: "create",
      name: "Community",
      color: "#e64980",
    })) as Response;
    expect(response.status).toBe(302);

    const data = await load();
    const created = data.tracks.find((track) => track.name === "Community");
    expect(created?.color).toBe("#e64980");
    expect(created?.sessionCount).toBe(0);
  });

  it("accepts a track with no color and rejects a malformed one", async () => {
    await post({ intent: "create", name: "Hallway Track", color: "" });
    const data = await load();
    expect(data.tracks.find((track) => track.name === "Hallway Track")?.color).toBeNull();

    await post({ intent: "create", name: "Bad Color", color: "not-a-hex" });
    const data2 = await load();
    expect(data2.tracks.find((track) => track.name === "Bad Color")?.color).toBeNull();
  });

  it("MUST NOT FIRE: a blank name, or a duplicate", async () => {
    expect(await post({ intent: "create", name: "   " })).toMatchObject({ ok: false });
    expect(await post({ intent: "create", name: "Agents" })).toMatchObject({
      ok: false,
    });
    expect((await load()).tracks).toHaveLength(3);
  });

  it("MUST NOT FIRE: an unknown intent", async () => {
    expect(await post({ intent: "truncate" })).toMatchObject({ ok: false });
  });
});

describe("action: update", () => {
  it("MUST FIRE: renames and re-colors a track", async () => {
    const target = fixture.trackIds[1];
    await post({
      intent: "update",
      trackId: target,
      name: "Evals & Trust",
      color: "#ae3ec9",
    });

    const row = await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) });
    expect(row?.name).toBe("Evals & Trust");
    expect(row?.color).toBe("#ae3ec9");
  });

  it("MUST NOT FIRE: a blank name, a name clash, or a track id from another event", async () => {
    const target = fixture.trackIds[1];
    expect(await post({ intent: "update", trackId: target, name: "" })).toMatchObject({
      ok: false,
    });
    expect(
      await post({ intent: "update", trackId: target, name: "Agents" }),
    ).toMatchObject({ ok: false });
    expect(
      await post({ intent: "update", trackId: "not-a-track", name: "Anything" }),
    ).toMatchObject({ ok: false });

    const row = await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) });
    expect(row?.name).toBe("Evals & Reliability");
  });
});

describe("action: delete", () => {
  it("MUST FIRE: removes a track nothing references", async () => {
    const target = await addUnusedTrack();
    const response = (await post({ intent: "delete", trackId: target })) as Response;
    expect(response.status).toBe(302);

    expect(
      await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) }),
    ).toBeUndefined();
    expect((await load()).tracks.map((track) => track.name)).not.toContain("Community");
  });

  it("MUST NOT FIRE: a track id that is not on this event", async () => {
    expect(await post({ intent: "delete", trackId: "nope" })).toMatchObject({ ok: false });
    expect((await load()).tracks).toHaveLength(3);
  });

  it("MUST NOT FIRE: a track a CFP form still routes to, naming the form and both counts", async () => {
    // Seeded state: routing.defaultTrackId is track 0, which also holds one
    // programme session and three abstracts.
    const target = fixture.trackIds[0];
    const result = await post({ intent: "delete", trackId: target });

    expect(result).toMatchObject({ ok: false });
    const error = (result as { error: string }).error;
    expect(error).toContain("1 session");
    expect(error).toContain("3 submissions");
    expect(error).toContain("“Call for Proposals 2026”");

    // Refusal, not a 500, and nothing was written.
    expect(result).not.toBeInstanceOf(Response);
    expect(
      await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) }),
    ).toBeDefined();
    const session = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, fixture.programSessionIds[0]),
    });
    expect(session?.trackId).toBe(target);
  });

  it("MUST NOT FIRE: a track held only by submissions still blocks", async () => {
    // Zero programme sessions and no form reference — the exact row that used to
    // render "0 sessions" beside a one-click Delete.
    const target = fixture.trackIds[2];
    const result = await post({ intent: "delete", trackId: target });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("2 submissions");
    expect(
      await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) }),
    ).toBeDefined();
  });

  it("MUST NOT FIRE: an otherwise-empty track that a form's eligible list still names", async () => {
    const target = await addUnusedTrack();
    await patchFormSchema({ eligibleTrackIds: [target] });

    const blocked = await post({ intent: "delete", trackId: target });
    expect(blocked).toMatchObject({ ok: false });
    expect((blocked as { error: string }).error).toContain("1 form (“Call for Proposals 2026”)");
    expect((blocked as { error: string }).error).not.toContain("session");

    // MUST STILL FIRE: clearing the only reference makes the same delete succeed,
    // so the refusal is the eligible list and not the track's newness.
    await patchFormSchema({ eligibleTrackIds: [] });
    expect(((await post({ intent: "delete", trackId: target })) as Response).status).toBe(302);
    expect(
      await ctx.db.query.tracks.findFirst({ where: eq(tracks.id, target) }),
    ).toBeUndefined();
  });

  it("MUST NOT FIRE: an otherwise-empty track a routing rule still points at", async () => {
    const target = await addUnusedTrack("Hallway");
    await patchFormSchema({
      routing: {
        rules: [
          {
            id: "route-hallway",
            match: "all",
            when: [{ fieldKey: "format", op: "equals", value: "Lightning" }],
            trackId: target,
            order: 0,
          },
        ],
        defaultTrackId: fixture.trackIds[0],
      },
    });

    const blocked = await post({ intent: "delete", trackId: target });
    expect(blocked).toMatchObject({ ok: false });
    expect((blocked as { error: string }).error).toContain("“Call for Proposals 2026”");

    await patchFormSchema({ routing: { rules: [], defaultTrackId: fixture.trackIds[0] } });
    expect(((await post({ intent: "delete", trackId: target })) as Response).status).toBe(302);
  });
});

describe("render", () => {
  it("renders the seeded tracks with an add form", async () => {
    const markup = renderToStaticMarkup(<TracksScreen {...(await load())} />);
    expect(markup).toContain("Agents");
    expect(markup).toContain("Add track");
    expect(markup).toContain(`data-track-row="${fixture.trackIds[0]}"`);
  });

  it("MUST FIRE: the count beside Delete shows submissions, not just sessions", async () => {
    const markup = renderToStaticMarkup(<TracksScreen {...(await load())} />);
    // Up to the Delete form: the usage span wraps the colour dot, so the first
    // closing tag is the dot's, not the span's.
    const usage = (id: string) =>
      markup.match(new RegExp(`data-track-usage="${id}"[\\s\\S]*?<form`))?.[0] ?? "";

    expect(usage(fixture.trackIds[0])).toContain("1 session");
    expect(usage(fixture.trackIds[0])).toContain("3 submissions");
    // The row that used to read "0 sessions" with nothing else said.
    expect(usage(fixture.trackIds[2])).toContain("0 sessions");
    expect(usage(fixture.trackIds[2])).toContain("2 submissions");
  });

  it("renders the zero state when the event has no tracks", async () => {
    await ctx.db.delete(tracks);
    const markup = renderToStaticMarkup(<TracksScreen {...(await load())} />);
    expect(markup).toContain("No tracks yet");
    expect(markup).toContain("Add track");
  });

  it("renders the no-event state", () => {
    const markup = renderToStaticMarkup(
      <TracksScreen event={null} tracks={[]} notice={null} />,
    );
    expect(markup).toContain("tracks belong to an event");
  });
});
