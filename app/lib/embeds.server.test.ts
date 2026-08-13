/**
 * `resolveEmbedExportResponse` — the JSON/XML export dispatcher called from
 * `workers/app.ts`, BEFORE React Router's document handler ever runs.
 *
 * It has to live outside the widgets' own route loaders: React Router v8
 * always renders a UI route's default component around whatever a
 * document-request loader returns, folding a returned `Response` into
 * `loaderData` instead of sending it back verbatim (see the doc comment on
 * `resolveEmbedExportResponse` in `embeds.server.ts`). These tests exercise
 * exactly the function the Worker calls, so — unlike calling a route's
 * `loader()` directly in earlier revisions of this suite — a green result
 * here really does mean the real request path works, not just that the
 * function returns the right shape when nothing else in the framework gets a
 * chance to mangle it. `tests/e2e/embed-area.spec.ts` proves the same thing
 * one layer up, against the real local workerd dev server.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessions } from "~/db/schema";
import { resolveEmbedExportResponse } from "~/lib/embeds.server";
import { upsertSavedEmbed, type SavedEmbed } from "~/lib/embeds";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

function url(path: string, slug = EVENT_SLUG): URL {
  return new URL(`https://x.test/embed/${slug}/${path}`);
}

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function saveEmbed(overrides: Partial<SavedEmbed>): Promise<SavedEmbed> {
  const embed: SavedEmbed = {
    id: "export-embed-1",
    name: "Export embed",
    widget: "schedule",
    theme: "auto",
    track: null,
    format: "json",
    density: "full",
    accent: null,
    customCss: null,
    hiddenFields: [],
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
  const event = await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) });
  await ctx.db
    .update(events)
    .set({ settings: upsertSavedEmbed(event?.settings, embed) })
    .where(eq(events.id, EVENT_ID));
  return embed;
}

describe("resolveEmbedExportResponse: not applicable", () => {
  it("MUST NOT FIRE: a non-embed path returns null", async () => {
    expect(await resolveEmbedExportResponse(new URL("https://x.test/admin/embeds"))).toBeNull();
  });

  it("MUST NOT FIRE: an unknown widget segment returns null", async () => {
    expect(await resolveEmbedExportResponse(url("nonsense"))).toBeNull();
  });

  it("MUST NOT FIRE: a bare embed URL with no params never touches the DB (default format is iframe)", async () => {
    expect(await resolveEmbedExportResponse(url("schedule"))).toBeNull();
  });

  it("MUST NOT FIRE: format=iframe/html/ical fall through to the normal HTML route", async () => {
    expect(await resolveEmbedExportResponse(url("schedule?format=iframe"))).toBeNull();
    expect(await resolveEmbedExportResponse(url("schedule?format=html"))).toBeNull();
    expect(await resolveEmbedExportResponse(url("schedule?format=ical"))).toBeNull();
  });

  it("MUST NOT FIRE: an unknown/disabled saved embed returns null so the route's own 404 fires", async () => {
    expect(await resolveEmbedExportResponse(url("schedule?embed=nope"))).toBeNull();
    const disabled = await saveEmbed({ id: "disabled-1", enabled: false });
    expect(await resolveEmbedExportResponse(url(`schedule?embed=${disabled.id}`))).toBeNull();
  });
});

describe("resolveEmbedExportResponse: schedule + agenda", () => {
  for (const widget of ["schedule", "agenda"] as const) {
    it(`MUST FIRE: ${widget} JSON and XML return real data, not the HTML page`, async () => {
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json`));
      expect(json).toBeInstanceOf(Response);
      expect(json?.headers.get("content-type")).toContain("application/json");
      const body = (await json?.json()) as {
        sessions: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBeGreaterThan(0);
      expect(body.sessions[0]).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        startsAt: expect.any(Number),
        endsAt: null,
      });
      expect(body.sessions[0]).toHaveProperty("room");
      expect(body.sessions[0]).toHaveProperty("track");

      const xml = await resolveEmbedExportResponse(url(`${widget}?format=xml`));
      expect(xml?.headers.get("content-type")).toContain("application/xml");
      expect(await xml?.text()).toMatch(new RegExp(`^<\\?xml[^>]+><${widget}><session><id>`));
    });

    it(`MUST NOT FIRE: ${widget} hidden room is absent from JSON, visible fields stay`, async () => {
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json&hide=room`));
      const body = (await json?.json()) as { sessions: Array<Record<string, unknown>> };
      expect(body.sessions[0]).not.toHaveProperty("room");
      expect(body.sessions[0]).toHaveProperty("track");
    });

    it(`renders the zero-row export when nothing is published (${widget})`, async () => {
      await ctx.db.update(sessions).set({ isPublic: false });
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json`));
      await expect(json?.json()).resolves.toMatchObject({ sessions: [], total: 0 });
    });

    it(`404s (not null) for an unknown event slug (${widget})`, async () => {
      const response = await resolveEmbedExportResponse(url(`${widget}?format=json`, "no-such-event"));
      expect(response?.status).toBe(404);
    });
  }

  it("MUST FIRE: a saved embed's stored JSON format and hidden fields apply at its stable ?embed= URL", async () => {
    const embed = await saveEmbed({
      widget: "schedule",
      format: "json",
      hiddenFields: ["room"],
      track: "Agents",
    });
    // The saved-embed URL never carries `format` in the query string — the
    // whole point of a saved embed is a stable URL that survives a later
    // config change. `resolveEmbedOptions` resolves format from the DB row.
    const response = await resolveEmbedExportResponse(url(`schedule?embed=${embed.id}`));
    expect(response).toBeInstanceOf(Response);
    expect(response?.headers.get("content-type")).toContain("application/json");
    const body = (await response?.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions[0]).not.toHaveProperty("room");
    expect(body.sessions[0]).toHaveProperty("track");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(fixture.programSessionIds[0]);
  });

  it("MUST NOT FIRE: a saved embed whose format is html returns null (route renders it)", async () => {
    const embed = await saveEmbed({ widget: "schedule", format: "html" });
    expect(await resolveEmbedExportResponse(url(`schedule?embed=${embed.id}`))).toBeNull();
  });
});

describe("resolveEmbedExportResponse: speakers + gallery", () => {
  for (const widget of ["speakers", "gallery"] as const) {
    it(`MUST FIRE: ${widget} JSON and XML export published speaker fields`, async () => {
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json`));
      expect(json).toBeInstanceOf(Response);
      expect(json?.headers.get("content-type")).toContain("application/json");
      const body = (await json?.json()) as { speakers: Array<Record<string, unknown>> };
      expect(body.speakers[0]).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        sessionCount: expect.any(Number),
      });
      expect(body.speakers[0]).toHaveProperty("title");
      expect(body.speakers[0]).toHaveProperty("company");

      const xml = await resolveEmbedExportResponse(url(`${widget}?format=xml`));
      expect(xml?.headers.get("content-type")).toContain("application/xml");
      expect(await xml?.text()).toContain(`<${widget}><speaker><id>`);
    });

    it(`MUST NOT FIRE: ${widget} hidden title is absent from JSON, company stays`, async () => {
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json&hide=title`));
      const body = (await json?.json()) as { speakers: Array<Record<string, unknown>> };
      expect(body.speakers[0]).not.toHaveProperty("title");
      expect(body.speakers[0]).toHaveProperty("company");
    });

    it(`404s (not null) for an unknown event slug (${widget})`, async () => {
      const response = await resolveEmbedExportResponse(url(`${widget}?format=json`, "no-such-event"));
      expect(response?.status).toBe(404);
    });

    it(`renders the zero-row export when nothing is published (${widget})`, async () => {
      await ctx.db.update(sessions).set({ isPublic: false });
      const json = await resolveEmbedExportResponse(url(`${widget}?format=json`));
      await expect(json?.json()).resolves.toMatchObject({ speakers: [], total: 0 });
    });
  }
});
