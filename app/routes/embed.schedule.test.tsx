import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sessions, tracks } from "~/db/schema";
import { upsertSavedEmbed, type SavedEmbed } from "~/lib/embeds";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import EmbedSchedule, { loader } from "./embed.schedule";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

function args(path = "", slug = EVENT_SLUG): LoaderArgs {
  return {
    request: new Request(`https://x.test/embed/${slug}/schedule${path}`),
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
    EmbedSchedule({ loaderData: data, params: { slug: EVENT_SLUG } } as unknown as Parameters<
      typeof EmbedSchedule
    >[0]),
  );
}

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  // Make the complement named in this lane explicit: the second published row
  // is Infrastructure, while the first remains Agents.
  await ctx.db
    .update(sessions)
    .set({ trackId: fixture.trackIds[2] })
    .where(eq(sessions.id, fixture.programSessionIds[1]));
});
afterEach(() => ctx.close());

async function saveEmbed(overrides: Partial<SavedEmbed> = {}): Promise<SavedEmbed> {
  const embed: SavedEmbed = {
    id: "saved-embed-1",
    name: "Homepage schedule",
    widget: "schedule",
    theme: "dark",
    track: "Agents",
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
    .set({ settings: upsertSavedEmbed(event?.settings, embed) })
    .where(eq(events.id, EVENT_ID));
  return embed;
}

describe("embed schedule loader and SSR", () => {
  it("MUST FIRE: an anonymous request renders sessions without site chrome", async () => {
    const requestArgs = args();
    expect(requestArgs.request.headers.has("cookie")).toBe(false);

    const data = await loader(requestArgs);
    const html = markup(data);
    expect(html).toContain("Shipping agents that survive contact with users");
    expect(html).toContain(`data-public-session="${fixture.programSessionIds[0]}"`);
    expect(html).not.toContain("Run a call for proposals end to end.");
    expect(html).not.toContain("Sign out");
  });

  /*
   * The reason the widget reuses `loadPublicSchedule` and the public page's own
   * chips instead of keeping its own copy. Every one of these fields arrived
   * with the schedule-upgrades lane; if the embed ever forks its query or its
   * renderer, this is the test that notices.
   */
  it("MUST FIRE: the widget carries the public page's speaker and format detail", async () => {
    const html = markup(await loader(args()));

    // Speaker job title and company, via the shared `PublicSpeakerList`.
    expect(html).toContain("data-session-speaker");
    expect(html).toContain("data-speaker-name");
    expect(html).toContain("data-speaker-role");
    expect(html).toContain("Demo Speaker, Company 0");
    // Track AND format chips, via the shared `PublicSlotChips`.
    expect(html).toContain("data-session-track=\"Agents\"");
    expect(html).toContain("data-session-format=");
    expect(html).toContain("data-session-room=");
  });

  it("MUST FIRE: track matching is case-insensitive and filters to Agents", async () => {
    const data = await loader(args("?track=agents"));
    expect(data.total).toBe(1);
    expect(data.days.flatMap((day) => day.sessions).map((row) => row.id)).toEqual([
      fixture.programSessionIds[0],
    ]);
  });

  it("MUST NOT FIRE: Agents excludes the fixture's Infrastructure session", async () => {
    const data = await loader(args("?track=Agents"));
    const html = markup(data);
    expect(html).not.toContain(`data-public-session="${fixture.programSessionIds[1]}"`);
  });

  it("MUST NOT FIRE: an unknown track returns an honest empty state", async () => {
    const data = await loader(args("?track=NoSuchTrack"));
    const html = markup(data);
    expect(data.total).toBe(0);
    expect(html).toContain("No published sessions match");
    expect(html).toContain("NoSuchTrack");
    expect(html).not.toContain("data-public-session");
  });

  it("applies dark and light overrides while auto carries neither class", async () => {
    expect(markup(await loader(args("?theme=dark")))).toContain("cb-theme-dark");
    expect(markup(await loader(args("?theme=dark")))).not.toContain("cb-theme-light");
    expect(markup(await loader(args("?theme=light")))).toContain("cb-theme-light");
    expect(markup(await loader(args("?theme=light")))).not.toContain("cb-theme-dark");
    const automatic = markup(await loader(args()));
    expect(automatic).not.toContain("cb-theme-dark");
    expect(automatic).not.toContain("cb-theme-light");
  });

  it("MUST FIRE: sanitized accents and compact density change the markup", async () => {
    const html = markup(await loader(args("?accent=%23ff6600&density=compact")));
    expect(html).toContain("--cb-accent:#ff6600");
    expect(html).toContain('data-embed-accent="#ff6600"');
    expect(html).toContain('data-embed-density="compact"');
    expect(html).not.toContain("data-session-speaker");
  });

  it("MUST NOT FIRE: poisoned accents are absent and full density keeps detail", async () => {
    const poison = "red;}body{display:none";
    const unsafe = markup(await loader(args(`?accent=${encodeURIComponent(poison)}`)));
    expect(unsafe).not.toContain("--cb-accent");
    expect(unsafe).not.toContain("data-embed-accent");
    expect(unsafe).not.toContain(poison);
    expect(markup(await loader(args()))).toContain("data-session-speaker");
  });

  it("MUST FIRE: a saved embed overrides ad-hoc theme and track parameters", async () => {
    const embed = await saveEmbed({ accent: "#0f766e", density: "compact" });
    const data = await loader(
      args(`?embed=${embed.id}&theme=light&track=Infrastructure`),
    );
    const html = markup(data);
    expect(data.theme).toBe("dark");
    expect(data.track).toBe("Agents");
    expect(data.accent).toBe("#0f766e");
    expect(data.density).toBe("compact");
    expect(html).toContain("cb-theme-dark");
    expect(html).toContain(`data-public-session="${fixture.programSessionIds[0]}"`);
    expect(html).not.toContain(`data-public-session="${fixture.programSessionIds[1]}"`);
  });

  it("MUST FIRE: a saved embed keyed by track ID survives a rename", async () => {
    // What a new save now stores: the id, not the name.
    const embed = await saveEmbed({ track: fixture.trackIds[0] });
    expect((await loader(args(`?embed=${embed.id}`))).track).toBe("Agents");

    await ctx.db
      .update(tracks)
      .set({ name: "Agentic systems" })
      .where(eq(tracks.id, fixture.trackIds[0]));

    const data = await loader(args(`?embed=${embed.id}`));
    expect(data.track).toBe("Agentic systems");
    expect(data.total).toBe(1);
    expect(markup(data)).toContain(`data-public-session="${fixture.programSessionIds[0]}"`);
    expect(markup(data)).not.toContain("No published sessions match");
  });

  it("MUST STILL FIRE: a legacy saved embed keyed by NAME behaves exactly as before", async () => {
    // Rows written before ids were stored. Unchanged in both directions: the
    // name still matches, and a rename still empties the widget — fixing that
    // for existing rows would mean guessing which track they meant.
    const legacy = await saveEmbed({ track: "Agents" });
    expect((await loader(args(`?embed=${legacy.id}`))).total).toBe(1);

    await ctx.db
      .update(tracks)
      .set({ name: "Agentic systems" })
      .where(eq(tracks.id, fixture.trackIds[0]));

    const data = await loader(args(`?embed=${legacy.id}`));
    expect(data.track).toBe("Agents");
    expect(data.total).toBe(0);
  });

  it("MUST NOT FIRE: disabled and unknown saved embeds return 404", async () => {
    const disabled = await saveEmbed({ id: "disabled-embed", enabled: false });
    await expect(loader(args(`?embed=${disabled.id}`))).rejects.toMatchObject({ status: 404 });
    await expect(loader(args("?embed=unknown-id"))).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for an unknown event slug", async () => {
    await expect(loader(args("", "unknown-event"))).rejects.toMatchObject({ status: 404 });
  });

  it("renders the zero-row state when nothing is published", async () => {
    await ctx.db.update(sessions).set({ isPublic: false });
    const html = markup(await loader(args()));
    expect(html).toContain("The schedule is not published yet.");
    expect(html).not.toContain("data-public-session");
  });
});
