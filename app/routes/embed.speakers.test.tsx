/**
 * The speakers widget: anonymous reach (EMB-14), the saved-embed gate, and the
 * theme override. The directory's own ordering and projection rules are the
 * speakers lane's tests — this proves the widget reuses them rather than
 * re-implementing them, and that it adds no chrome.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events } from "~/db/schema";
import { upsertSavedEmbed, type SavedEmbed } from "~/lib/embeds";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import EmbedSpeakers, { loader } from "./embed.speakers";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

function args(path = "", slug = EVENT_SLUG): LoaderArgs {
  return {
    // No Cookie header anywhere in this file: an embed that needs a session is
    // not an embed.
    request: new Request(`https://x.test/embed/${slug}/speakers${path}`),
    params: { slug },
    context: {},
  } as unknown as LoaderArgs;
}

/**
 * The route component is typed against generated `Route.ComponentProps`, whose
 * `matches` is a fixed-length tuple no literal can satisfy. Same cast the rest
 * of the suite uses (see `public.schedule.test.tsx`).
 */
function markup(data: LoaderData): string {
  return renderToStaticMarkup(
    EmbedSpeakers({ loaderData: data, params: { slug: EVENT_SLUG } } as unknown as Parameters<
      typeof EmbedSpeakers
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

async function saveEmbed(overrides: Partial<SavedEmbed> = {}): Promise<SavedEmbed> {
  const embed: SavedEmbed = {
    id: "emb-speakers-0001",
    name: "Sponsor page speakers",
    widget: "speakers",
    theme: "dark",
    track: null,
    format: "iframe",
    density: "full",
    accent: null,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
  const event = await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) });
  await ctx.db
    .update(events)
    .set({ settings: upsertSavedEmbed(event?.settings ?? null, embed) })
    .where(eq(events.id, EVENT_ID));
  return embed;
}

describe("embed speakers loader", () => {
  it("MUST FIRE: an anonymous request returns the published directory", async () => {
    const data = await loader(args());

    expect(data.total).toBeGreaterThan(0);
    expect(data.speakers.length).toBeGreaterThan(0);
    expect(data.speakers[0].displayName).toBeTruthy();
  });

  it("404s for an unknown event slug", async () => {
    await expect(loader(args("", "no-such-event"))).rejects.toBeInstanceOf(Response);
  });

  it("MUST FIRE: a saved embed's stored theme beats the query string", async () => {
    const embed = await saveEmbed({ theme: "dark" });
    const data = await loader(args(`?embed=${embed.id}&theme=light`));

    expect(data.theme).toBe("dark");
    expect(markup(data)).toContain("cb-theme-dark");
  });

  it("MUST NOT FIRE: a disabled saved embed 404s", async () => {
    const embed = await saveEmbed({ enabled: false });
    await expect(loader(args(`?embed=${embed.id}`))).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: a SCHEDULE embed id does not open the speakers widget", async () => {
    const embed = await saveEmbed({ widget: "schedule", id: "emb-sched-0001" });
    await expect(loader(args(`?embed=${embed.id}`))).rejects.toMatchObject({ status: 404 });
  });

  it("MUST NOT FIRE: an unknown embed id 404s", async () => {
    await expect(loader(args("?embed=nope"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("embed speakers render", () => {
  it("renders speaker cards with name and role, and no site chrome", async () => {
    const html = markup(await loader(args()));

    expect(html).toContain("data-embed-speaker");
    expect(html).toContain("data-speaker-name");
    expect(html).toContain("Powered by callboard");
    // The chrome the public page has and an embed must not.
    expect(html).not.toContain("Run a call for proposals end to end.");
    expect(html).not.toContain("Sign out");
  });

  it("honours all three theme values, so a hardcoded class cannot pass", async () => {
    expect(markup(await loader(args("?theme=dark")))).toContain("cb-theme-dark");
    expect(markup(await loader(args("?theme=light")))).toContain("cb-theme-light");

    const auto = markup(await loader(args()));
    expect(auto).not.toContain("cb-theme-dark");
    expect(auto).not.toContain("cb-theme-light");
  });

  it("MUST FIRE: accent and compact density are honoured", async () => {
    const html = markup(await loader(args("?accent=%23ff6600&density=compact")));
    expect(html).toContain("--cb-accent:#ff6600");
    expect(html).toContain('data-embed-density="compact"');
    expect(html).not.toContain("data-speaker-title");
    expect(html).not.toMatch(/\d+ sessions?<\/p>/);
  });

  it("MUST NOT FIRE: poisoned accents do not render and full density retains roles", async () => {
    const poison = "red;}body{display:none";
    const unsafe = markup(await loader(args(`?accent=${encodeURIComponent(poison)}`)));
    expect(unsafe).not.toContain("--cb-accent");
    expect(unsafe).not.toContain("data-embed-accent");
    expect(unsafe).not.toContain(poison);
    expect(markup(await loader(args()))).toContain("data-speaker-title");
  });

  it("renders an honest empty state when nothing is published", async () => {
    const { sessions } = await import("~/db/schema");
    await ctx.db.update(sessions).set({ isPublic: false });

    const html = markup(await loader(args()));
    expect(html).toContain("No speakers are published yet.");
    expect(html).not.toContain("data-embed-speaker");
  });
});
