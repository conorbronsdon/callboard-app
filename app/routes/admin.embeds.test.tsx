import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, tracks } from "~/db/schema";
import { readSavedEmbeds, upsertSavedEmbed } from "~/lib/embeds";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminEmbeds, { action, loader } from "./admin.embeds";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

/**
 * Playwright's default matcher for `getByLabel`/`getByRole({ name })` is
 * case-insensitive SUBSTRING containment, not equality — a landmine EMB-15
 * actually stepped on: "Track for Schedule" (the filter select) and "Hide
 * Track for Schedule" (the new hide-field checkbox) are two DIFFERENT
 * strings — an exact-duplicate check sees no collision — but the second
 * CONTAINS the first, so `getByLabel("Track for Schedule")` resolved to both
 * and threw a strict-mode violation in `tests/e2e/embed-area.spec.ts`. This
 * is the detector the exact-duplicate check above was missing.
 */
function findAccessibleNameCollisions(labels: readonly string[]): string[] {
  const unique = [...new Set(labels)];
  const collisions: string[] = [];
  for (const a of unique) {
    for (const b of unique) {
      if (a !== b && b.toLowerCase().includes(a.toLowerCase())) {
        collisions.push(`"${a}" is contained in "${b}"`);
      }
    }
  }
  return collisions;
}

const loaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const actionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function get(path = "/admin/embeds"): Promise<LoaderData> {
  return loader(loaderArgs(await signedInGet(`https://x.test${path}`, fixture.adminId)));
}

async function post(fields: Record<string, string>) {
  return action(
    actionArgs(await signedInPost("https://x.test/admin/embeds", fixture.adminId, fields)),
  );
}

/**
 * The route component is typed against generated `Route.ComponentProps`, whose
 * `matches` is a fixed-length tuple no literal can satisfy. Same cast the rest
 * of the suite uses (see `public.schedule.test.tsx`).
 */
function markup(data: LoaderData, actionData?: Awaited<ReturnType<typeof action>>): string {
  return renderToStaticMarkup(
    AdminEmbeds({ loaderData: data, actionData, params: {} } as unknown as Parameters<
      typeof AdminEmbeds
    >[0]),
  );
}

async function settings() {
  return (await ctx.db.query.events.findFirst({ where: eq(events.id, EVENT_ID) }))?.settings;
}

async function save(name: string, overrides: Record<string, string> = {}) {
  return post({
    intent: "save",
    name,
    widget: "schedule",
    theme: "dark",
    track: "Agents",
    format: "iframe",
    density: "full",
    accent: "",
    ...overrides,
  });
}

describe("admin embeds loader and render", () => {
  it("requires an admin session", async () => {
    await expect(
      loader(
        loaderArgs(new Request("https://x.test/admin/embeds")),
      ),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("MUST FIRE: renders all four widget cards and their distinct URLs", async () => {
    const html = markup(await get());
    expect(html).toContain(">Schedule<");
    expect(html).toContain(">Agenda by day<");
    expect(html).toContain(">Speakers<");
    expect(html).toContain(">Speaker gallery<");
    expect(html).toContain("https://x.test/embed/frontier-ai-summit-2026/schedule");
    expect(html).toContain("https://x.test/embed/frontier-ai-summit-2026/agenda");
    expect(html).toContain("https://x.test/embed/frontier-ai-summit-2026/gallery");
    expect(html).toContain("https://x.test/e/frontier-ai-summit-2026/schedule.ics");
    expect([...html.matchAll(/<option value="ical">/g)]).toHaveLength(2);
    expect([...html.matchAll(/<option value="json">/g)]).toHaveLength(4);
    expect([...html.matchAll(/<option value="xml">/g)]).toHaveLength(4);
    expect(html.match(/aria-label="Format for Speakers"[\s\S]*?<\/select>/)?.[0]).not.toContain(
      'value="ical"',
    );
    expect(html.match(/aria-label="Format for Speaker gallery"[\s\S]*?<\/select>/)?.[0]).not.toContain(
      'value="ical"',
    );
    expect(html).toContain("No saved embeds yet");
  });

  it("MUST FIRE: renders a captured iframe snippet and the same live preview URL", async () => {
    const html = markup(await get("/admin/embeds?w=schedule&theme=dark"));
    const embedUrl = `https://x.test/embed/${EVENT_SLUG}/schedule?theme=dark`;
    const snippet = html.match(/data-testid="embed-snippet-schedule"[\s\S]*?<\/textarea>/)?.[0];

    expect(html).toContain('data-testid="embed-snippet-schedule"');
    expect(html).toContain("&lt;iframe src=");
    expect(html).toContain(`href="${embedUrl}"`);
    expect(snippet).toContain(embedUrl);
    expect(html).toContain(
      `data-testid="embed-preview-schedule" src="${embedUrl}"`,
    );
  });

  it("MUST NOT FIRE: renders no live preview until a widget is explicitly active", async () => {
    expect(markup(await get())).not.toContain('data-testid="embed-preview-');
  });

  it("MUST FIRE for speakers and MUST NOT FIRE for the schedule preview", async () => {
    const html = markup(await get("/admin/embeds?w=speakers"));
    const frame = html.match(/<iframe[^>]*data-testid="embed-preview-speakers"[^>]*>/)?.[0];

    expect(frame).toContain(`/embed/${EVENT_SLUG}/speakers`);
    expect(frame).not.toContain(`/embed/${EVENT_SLUG}/schedule`);
    expect(html).not.toContain('data-testid="embed-preview-schedule"');
  });

  it("MUST FIRE: Get Code reflects custom CSS, hidden fields, and a JSON link", async () => {
    const path =
      "/admin/embeds?w=schedule&format=json&customCss=.card%7Bcolor%3Ared%7D&hide=room";
    const data = await get(path);
    expect(data.selectedCustomCss).toBe(".card{color:red}");
    expect(data.selectedHiddenFields).toEqual(["room"]);
    const html = markup(data);
    expect(html).toContain(".card{color:red}");
    expect(html).toMatch(/aria-label="Hide Room field for Schedule"[^>]*checked/);
    expect(html).toContain("format=json&amp;hide=room");
    expect(html).toContain("Fetch Frontier AI Summit 2026");
  });
});

describe("admin embeds actions", () => {
  it("MUST FIRE: save appends a rendered row and preserves unrelated settings", async () => {
    await ctx.db
      .update(events)
      .set({ settings: { branding: { accent: "violet" }, someFlag: true } })
      .where(eq(events.id, EVENT_ID));

    const result = await save("Homepage agenda");
    expect(result).toMatchObject({ ok: true });
    expect(await settings()).toMatchObject({
      branding: { accent: "violet" },
      someFlag: true,
    });
    expect(readSavedEmbeds(await settings())).toHaveLength(1);
    expect(readSavedEmbeds(await settings())[0].accent).toBeNull();

    const html = markup(await get(), result);
    expect(html).toContain("Homepage agenda");
    expect(html).toContain('data-testid="saved-embeds"');
    expect(html).toContain('data-testid="saved-embed-snippet"');
    expect(html).toContain("?embed=");
  });

  it("MUST NOT FIRE: a blank name is rejected without persistence", async () => {
    const result = await save("   ");
    expect(result).toMatchObject({ ok: false, error: "Name is required." });
    expect(readSavedEmbeds(await settings())).toEqual([]);
    expect(markup(await get(), result)).toContain("Name is required.");
  });

  it("rejects overlong names, unknown widgets, and unknown themes", async () => {
    expect(await save("x".repeat(81))).toMatchObject({ ok: false });
    // The unknown id has to keep moving: `speakers` became real when the public
    // directory landed and `gallery` when the gallery widget did, so this case
    // now names something the catalogue genuinely does not carry.
    expect(await save("Unknown widget", { widget: "itinerary" })).toMatchObject({
      ok: false,
      error: "Unknown embed widget.",
    });
    expect(await save("Unknown theme", { theme: "purple" })).toMatchObject({
      ok: false,
      error: "Unknown embed theme.",
    });
    expect(readSavedEmbeds(await settings())).toEqual([]);
  });

  it("MUST FIRE: format, density, and accent persist and HTML changes the snippet", async () => {
    const result = await save("Linked agenda", {
      widget: "agenda",
      format: "html",
      density: "compact",
      accent: "#0F766E",
    });
    expect(result).toMatchObject({ ok: true });
    expect(readSavedEmbeds(await settings())[0]).toMatchObject({
      format: "html",
      density: "compact",
      accent: "#0f766e",
    });
    const html = markup(await get(), result);
    expect(html).toContain("&lt;div class=&quot;callboard-embed&quot;&gt;");
    expect(html).not.toContain(
      "&lt;iframe src=&quot;https://x.test/embed/frontier-ai-summit-2026/agenda?embed=",
    );
  });

  it("MUST FIRE: saving custom CSS and hide=room persists both", async () => {
    const result = await save("Styled schedule", {
      customCss: ".shadow-card { box-shadow: none; }",
      hide: "room",
    });
    expect(result).toMatchObject({ ok: true });
    expect(readSavedEmbeds(await settings())[0]).toMatchObject({
      customCss: ".shadow-card { box-shadow: none; }",
      hiddenFields: ["room"],
    });
  });

  it("MUST NOT FIRE: style/script breakouts are neutralized before storage", async () => {
    const poison = "</style><script>alert(1)</script>";
    expect(await save("Sanitized CSS", { customCss: poison })).toMatchObject({ ok: true });
    const stored = readSavedEmbeds(await settings())[0].customCss ?? "";
    expect(stored.toLowerCase()).not.toContain("</style");
    expect(stored.toLowerCase()).not.toContain("<script");
    expect(stored).not.toBe(poison);
  });

  it.each([
    [{ accent: "red;}body{display:none" }, "Accent must be a hex colour like #0f766e."],
    [{ format: "yaml" }, "Unknown embed format."],
    [{ density: "airy" }, "Unknown embed density."],
  ] as Array<[Record<string, string>, string]>)(
    "MUST NOT FIRE: rejects hand-built invalid embed options without writes",
    async (override, error) => {
      await save("Baseline");
      const before = JSON.stringify(readSavedEmbeds(await settings()));
      expect(await save("Invalid", override)).toMatchObject({ ok: false, error });
      expect(JSON.stringify(readSavedEmbeds(await settings()))).toBe(before);
    },
  );

  it("toggles enabled and deletes the saved embed", async () => {
    await save("Homepage agenda");
    const [embed] = readSavedEmbeds(await settings());

    expect(await post({ intent: "toggle", id: embed.id })).toMatchObject({ ok: true });
    expect(readSavedEmbeds(await settings())[0].enabled).toBe(false);

    expect(await post({ intent: "delete", id: embed.id })).toMatchObject({ ok: true });
    expect(readSavedEmbeds(await settings())).toEqual([]);
  });

  it("MUST NOT FIRE: unknown toggle/delete ids return errors without mutation", async () => {
    await save("Homepage agenda");
    const before = JSON.stringify(await settings());

    expect(await post({ intent: "toggle", id: "unknown" })).toMatchObject({
      ok: false,
      error: "Saved embed not found.",
    });
    expect(JSON.stringify(await settings())).toBe(before);
    expect(await post({ intent: "delete", id: "unknown" })).toMatchObject({
      ok: false,
      error: "Saved embed not found.",
    });
    expect(JSON.stringify(await settings())).toBe(before);
  });

  it("MUST FIRE: a speakers embed saves and gets its own /speakers URL", async () => {
    const result = await save("Sponsor page speakers", { widget: "speakers", track: "" });
    expect(result).toMatchObject({ ok: true });

    const [embed] = readSavedEmbeds(await settings());
    expect(embed.widget).toBe("speakers");

    const html = markup(await get(), result);
    expect(html).toContain(`/embed/${EVENT_SLUG}/speakers?embed=${embed.id}`);
    // MUST NOT FIRE: a speakers embed never points at the schedule widget.
    expect(html).not.toContain(`/embed/${EVENT_SLUG}/schedule?embed=${embed.id}`);
  });

  /** The saved row's own summary line, not the picker options above it. */
  function savedSummary(html: string): string {
    return html.match(/data-saved-embed[\s\S]*?<p[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
  }

  it("MUST FIRE: a saved embed stores the track ID and renders the current name", async () => {
    const result = await save("Homepage schedule", { track: "Agents" });
    expect(result).toMatchObject({ ok: true });

    const [embed] = readSavedEmbeds(await settings());
    // The stored value is the id, not the label the organizer picked.
    expect(embed.track).toBe(fixture.trackIds[0]);
    expect(embed.track).not.toBe("Agents");
    expect(savedSummary(markup(await get(), result))).toBe(
      "Schedule · dark · Agents · iframe · full · No accent",
    );

    await ctx.db
      .update(tracks)
      .set({ name: "Agentic systems" })
      .where(eq(tracks.id, fixture.trackIds[0]));

    // MUST NOT FIRE the stale name: the saved row follows the rename instead of
    // advertising a track that no longer exists.
    expect(savedSummary(markup(await get()))).toBe(
      "Schedule · dark · Agentic systems · iframe · full · No accent",
    );
  });

  it("MUST STILL FIRE: a legacy name-keyed row still prints its stored name", async () => {
    await ctx.db
      .update(events)
      .set({
        settings: upsertSavedEmbed(await settings(), {
          id: "legacy-embed",
          name: "Partner page",
          widget: "schedule",
          theme: "dark",
          track: "Evals & Reliability",
          format: "iframe",
          density: "full",
          accent: null,
          customCss: null,
          hiddenFields: [],
          enabled: true,
          createdAt: Date.now(),
        }),
      })
      .where(eq(events.id, EVENT_ID));

    expect(savedSummary(markup(await get()))).toBe(
      "Schedule · dark · Evals &amp; Reliability · iframe · full · No accent",
    );
  });

  it("MUST NOT FIRE: an unpicked or unknown track is not invented into an id", async () => {
    await save("All tracks", { track: "" });
    expect(readSavedEmbeds(await settings())[0].track).toBeNull();

    await save("Hand-posted", { track: "Hallway" });
    const stored = readSavedEmbeds(await settings()).find((e) => e.name === "Hand-posted");
    expect(stored?.track).toBe("Hallway");
    expect(markup(await get())).toContain("· Hallway ·");
  });

  it("MUST NOT FIRE: the four widget cards do not share an accessible name", async () => {
    const html = markup(await get());
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    const repeated = labels.filter((label, index) => labels.indexOf(label) !== index);

    // §6C: two controls sharing an accessible name is a Playwright
    // strict-mode failure waiting to happen. With two cards on the page every
    // repeated control must be widget-qualified.
    expect(repeated).toEqual([]);
    expect(labels).toContain("Theme for Schedule");
    expect(labels).toContain("Theme for Speakers");
    expect(labels).toContain("Theme for Agenda by day");
    expect(labels).toContain("Theme for Speaker gallery");
    for (const widget of ["Schedule", "Agenda by day", "Speakers", "Speaker gallery"]) {
      expect(labels).toContain(`Format for ${widget}`);
      expect(labels).toContain(`Density for ${widget}`);
      expect(labels).toContain(`Accent colour for ${widget}`);
      expect(labels).toContain(`Custom CSS for ${widget}`);
    }
    expect(labels).toContain("Get Code for Schedule");
    expect(labels).toContain("Get Code for Speakers");
    expect(labels).toContain("Get Code for Agenda by day");
    expect(labels).toContain("Get Code for Speaker gallery");

    // The exact-duplicate check above is not enough — see
    // `findAccessibleNameCollisions`'s own doc comment for the regression
    // this closes (EMB-15's "Hide Track for Schedule" checkbox silently
    // containing the pre-existing "Track for Schedule" filter select).
    expect(findAccessibleNameCollisions(labels)).toEqual([]);
    expect(labels).toContain("Hide Room field for Schedule");
    expect(labels).toContain("Hide Track field for Schedule");
  });

  it("MUST FIRE: the substring-collision detector itself catches EMB-15's actual regression", () => {
    // Fixture is the two REAL labels from before the fix (see git blame on
    // admin.embeds.tsx's hide-field checkbox) — proves the detector used
    // above can fail, not just that today's page happens to pass it.
    expect(
      findAccessibleNameCollisions(["Track for Schedule", "Hide Track for Schedule"]),
    ).toEqual(['"Track for Schedule" is contained in "Hide Track for Schedule"']);
  });

  it("MUST NOT FIRE: the detector does not flag genuinely distinct labels", () => {
    expect(
      findAccessibleNameCollisions(["Theme for Schedule", "Theme for Speakers", "Get Code for Schedule"]),
    ).toEqual([]);
  });

  it("gives two saved-row controls two distinct accessible names", async () => {
    await save("Homepage agenda");
    await save("Partner portal agenda");
    const html = markup(await get());
    const disableNames = [...html.matchAll(/aria-label="(Disable [^"]+)"/g)].map(
      (match) => match[1],
    );
    const removeNames = [...html.matchAll(/aria-label="(Remove [^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(disableNames).toHaveLength(2);
    expect(new Set(disableNames).size).toBe(2);
    expect(removeNames).toHaveLength(2);
    expect(new Set(removeNames).size).toBe(2);
    expect(html).toContain(">Disable</button>");
    expect(html).toContain(">Remove</button>");
  });
});
