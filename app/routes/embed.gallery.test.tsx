import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import { upsertSavedEmbed, type SavedEmbed } from "~/lib/embeds";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import EmbedGallery, { loader } from "./embed.gallery";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

function args(path = "", slug = EVENT_SLUG): LoaderArgs {
  return {
    request: new Request(`https://x.test/embed/${slug}/gallery${path}`),
    params: { slug },
    context: {},
  } as unknown as LoaderArgs;
}

function markup(data: LoaderData): string {
  return renderToStaticMarkup(
    EmbedGallery({ loaderData: data, params: { slug: EVENT_SLUG } } as unknown as Parameters<
      typeof EmbedGallery
    >[0]),
  );
}

let ctx: TestDbContext;
let _fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  _fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function saveEmbed(overrides: Partial<SavedEmbed> = {}) {
  const embed: SavedEmbed = {
    id: "gallery-saved-1",
    name: "Gallery",
    widget: "gallery",
    theme: "dark",
    track: null,
    format: "html",
    density: "compact",
    accent: "#0f766e",
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

describe("gallery embed", () => {
  /*
   * JSON/XML export moved to `resolveEmbedExportResponse`
   * (app/lib/embeds.server.test.ts) — the function `workers/app.ts` actually
   * calls before this loader ever runs. See that function's doc comment:
   * this route's loader can no longer return a Response and have it reach
   * the client verbatim (EMB-15, issue #74).
   */
  it("MUST NOT FIRE: hidden company stays absent from HTML, visible by default otherwise", async () => {
    expect(markup(await loader(args()) as LoaderData)).toContain("data-speaker-company");
    expect(markup(await loader(args("?hide=company")) as LoaderData)).not.toContain(
      "data-speaker-company",
    );
  });

  it("MUST FIRE: anonymous SSR renders the published tile grid", async () => {
    const html = markup(await loader(args()));
    expect(html).toContain("data-embed-gallery-speaker");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("data-speaker-name");
    expect(html).not.toContain("Sign out");
  });

  it("returns 404 for an unknown slug", async () => {
    await expect(loader(args("", "unknown"))).rejects.toMatchObject({ status: 404 });
  });

  it("MUST FIRE: saved options beat all query parameters", async () => {
    const embed = await saveEmbed();
    const data = await loader(
      args(`?embed=${embed.id}&theme=light&accent=%23ffffff&density=full`),
    );
    expect(data).toMatchObject({ theme: "dark", accent: "#0f766e", density: "compact" });
    expect(markup(data)).toContain("cb-theme-dark");
  });

  it("MUST NOT FIRE: disabled, unknown, and different-widget saved embeds 404", async () => {
    const disabled = await saveEmbed({ id: "disabled-gallery", enabled: false });
    await expect(loader(args(`?embed=${disabled.id}`))).rejects.toMatchObject({ status: 404 });
    const speakers = await saveEmbed({ id: "speakers-id", widget: "speakers" });
    await expect(loader(args(`?embed=${speakers.id}`))).rejects.toMatchObject({ status: 404 });
    await expect(loader(args("?embed=unknown"))).rejects.toMatchObject({ status: 404 });
  });

  it("honours light, dark, and auto themes", async () => {
    expect(markup(await loader(args("?theme=dark")))).toContain("cb-theme-dark");
    expect(markup(await loader(args("?theme=light")))).toContain("cb-theme-light");
    expect(markup(await loader(args()))).not.toContain("cb-theme-dark");
  });

  it("MUST FIRE: valid accent and compact density alter markup", async () => {
    const html = markup(await loader(args("?accent=%23ff6600&density=compact")));
    expect(html).toContain("--cb-accent:#ff6600");
    expect(html).toContain('data-embed-accent="#ff6600"');
    expect(html).not.toContain("data-speaker-title");
    expect(html).not.toMatch(/\d+ sessions?<\/p>/);
  });

  it("MUST NOT FIRE: poisoned accent is absent and full density keeps metadata", async () => {
    const poison = "red;}body{display:none";
    const unsafe = markup(await loader(args(`?accent=${encodeURIComponent(poison)}`)));
    expect(unsafe).not.toContain("--cb-accent");
    expect(unsafe).not.toContain("data-embed-accent");
    expect(unsafe).not.toContain(poison);
    expect(markup(await loader(args()))).toContain("data-speaker-title");
  });

  it("renders the zero-row state", async () => {
    const { sessions } = await import("~/db/schema");
    await ctx.db.update(sessions).set({ isPublic: false });
    expect(markup(await loader(args()))).toContain("No speakers are published yet.");
  });
});
