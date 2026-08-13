import { describe, expect, it } from "vitest";

import {
  buildEmbedXml,
  buildEmbedUrl,
  buildFeedUrl,
  buildIframeSnippet,
  buildSnippet,
  isEmbedFormat,
  parseAccent,
  parseCustomCss,
  parseDensity,
  parseFormat,
  parseHiddenFields,
  parseTheme,
  readSavedEmbeds,
  removeSavedEmbed,
  resolveTrackRef,
  toTrackRef,
  toggleSavedEmbed,
  upsertSavedEmbed,
  type EmbedTrackRef,
  type SavedEmbed,
} from "./embeds";

const TRACKS: EmbedTrackRef[] = [
  { id: "tr-1", name: "Agents" },
  { id: "tr-2", name: "Evals & Reliability" },
];

const saved: SavedEmbed = {
  id: "embed-1",
  name: "Homepage schedule",
  widget: "schedule",
  theme: "dark",
  track: "Agents",
  format: "iframe",
  density: "full",
  accent: null,
  customCss: null,
  hiddenFields: [],
  enabled: true,
  createdAt: 1_786_400_000_000,
};

describe("saved-embed track references", () => {
  it("MUST FIRE: a picked name is stored as an id and renders as the CURRENT name", () => {
    const stored = toTrackRef("Agents", TRACKS);
    expect(stored).toBe("tr-1");

    // The rename that used to empty the widget on somebody else's page.
    const renamed: EmbedTrackRef[] = [{ id: "tr-1", name: "Agentic systems" }, TRACKS[1]];
    expect(resolveTrackRef(stored, renamed)).toBe("Agentic systems");
  });

  it("MUST STILL FIRE: a legacy row holding a name resolves to that name, as before", () => {
    expect(resolveTrackRef("Agents", TRACKS)).toBe("Agents");
    // Including after a rename: the old behaviour, unchanged — the widget's
    // case-insensitive name match is still what decides.
    expect(resolveTrackRef("Agents", [{ id: "tr-1", name: "Agentic systems" }])).toBe("Agents");
  });

  it("MUST NOT FIRE: no filter, and a name no live track carries", () => {
    expect(toTrackRef(null, TRACKS)).toBeNull();
    expect(toTrackRef("   ", TRACKS)).toBeNull();
    expect(resolveTrackRef(null, TRACKS)).toBeNull();
    expect(resolveTrackRef("", TRACKS)).toBeNull();
    // Unknown names are not invented into ids, and survive the round trip.
    expect(toTrackRef("Hallway", TRACKS)).toBe("Hallway");
    expect(resolveTrackRef("Hallway", TRACKS)).toBe("Hallway");
  });

  it("matches the picker case-insensitively but never across tracks", () => {
    expect(toTrackRef(" agents ", TRACKS)).toBe("tr-1");
    expect(toTrackRef("Evals & Reliability", TRACKS)).toBe("tr-2");
    expect(toTrackRef("Evals", TRACKS)).toBe("Evals");
  });
});

describe("embed code builders", () => {
  it("MUST FIRE: JSON and XML are accepted embed formats", () => {
    expect(isEmbedFormat("json")).toBe(true);
    expect(isEmbedFormat("xml")).toBe(true);
    expect(parseFormat("xml")).toBe("xml");
  });

  it("MUST NOT FIRE: unknown structured formats fall back to iframe", () => {
    expect(isEmbedFormat("yaml")).toBe(false);
    expect(parseFormat("yaml")).toBe("iframe");
  });

  it("MUST FIRE: XML keeps field order, escapes text, and stringifies scalars", () => {
    expect(
      buildEmbedXml("speakers", "speaker", [
        { id: "sp&1", name: "Ada <Lovelace>", sessionCount: 2, featured: true },
      ]),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><speakers><speaker><id>sp&amp;1</id><name>Ada &lt;Lovelace&gt;</name><sessionCount>2</sessionCount><featured>true</featured></speaker></speakers>',
    );
  });

  it("MUST NOT FIRE: XML omits null fields instead of emitting empty tags", () => {
    const xml = buildEmbedXml("sessions", "session", [
      { id: "s1", room: null, title: "Safe > sound" },
    ]);
    expect(xml).not.toContain("<room>");
    expect(xml).toContain("<id>s1</id><title>Safe &gt; sound</title>");
  });

  it("MUST FIRE: custom CSS trims, round-trips, and clamps to 4000 characters", () => {
    expect(parseCustomCss("  .card { color: red; }  ")).toBe(".card { color: red; }");
    expect(parseCustomCss("x".repeat(4_001))).toHaveLength(4_000);
  });

  it("MUST NOT FIRE: custom CSS cannot break out into style or script markup", () => {
    const parsed = parseCustomCss("</StYlE><ScRiPt>alert(1)</script>");
    expect(parsed?.toLowerCase()).not.toContain("</style");
    expect(parsed?.toLowerCase()).not.toContain("<script");
    expect(parseCustomCss("   ")).toBeNull();
  });

  it("MUST FIRE: hidden fields retain valid ids in first-seen order", () => {
    expect(parseHiddenFields("schedule", ["track", "room", "track"])).toEqual([
      "track",
      "room",
    ]);
  });

  it("MUST NOT FIRE: hidden fields drop unknown and cross-widget ids", () => {
    expect(parseHiddenFields("speakers", ["room", "company", "unknown"])).toEqual([
      "company",
    ]);
  });

  it("MUST FIRE: accepts and normalises hex accents", () => {
    expect(parseAccent(" #0F766E ")).toBe("#0f766e");
    expect(parseAccent("#FFF")).toBe("#fff");
  });

  it.each([
    "red",
    "#12345",
    "javascript:alert(1)",
    "expression(alert(1))",
    "#fff;}body{display:none",
    "url(x)",
    "x".repeat(500),
    "",
    null,
  ])("MUST NOT FIRE: rejects unsafe or malformed accent %s", (value) => {
    expect(parseAccent(value)).toBeNull();
  });

  it("defaults unknown formats and densities", () => {
    expect(parseFormat("html")).toBe("html");
    expect(parseFormat("yaml")).toBe("iframe");
    expect(parseFormat(null)).toBe("iframe");
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("airy")).toBe("full");
    expect(parseDensity(undefined)).toBe("full");
  });

  it("omits defaults and includes percent-encoded non-defaults", () => {
    expect(
      buildEmbedUrl({
        origin: "https://callboard.test/",
        slug: "frontier-ai-summit-2026",
        widget: "schedule",
        theme: "auto",
        track: null,
      }),
    ).toBe("https://callboard.test/embed/frontier-ai-summit-2026/schedule");

    expect(
      buildEmbedUrl({
        origin: "https://callboard.test",
        slug: "frontier-ai-summit-2026",
        widget: "schedule",
        theme: "dark",
        track: "Evals & Reliability",
      }),
    ).toBe(
      "https://callboard.test/embed/frontier-ai-summit-2026/schedule?theme=dark&track=Evals+%26+Reliability",
    );
  });

  it("MUST FIRE: adds sanitized accent and compact density only to ad-hoc URLs", () => {
    expect(
      buildEmbedUrl({
        origin: "https://callboard.test",
        slug: "conf",
        widget: "agenda",
        accent: " #FF6600 ",
        density: "compact",
      }),
    ).toBe("https://callboard.test/embed/conf/agenda?accent=%23ff6600&density=compact");
    expect(
      buildEmbedUrl({
        origin: "https://callboard.test",
        slug: "conf",
        widget: "agenda",
        accent: "red;}body{display:none",
        density: "full",
      }),
    ).toBe("https://callboard.test/embed/conf/agenda");
  });

  it("MUST FIRE: data formats and valid hidden fields are added to ad-hoc URLs", () => {
    expect(
      buildEmbedUrl({
        origin: "https://callboard.test",
        slug: "conf",
        widget: "schedule",
        format: "json",
        hiddenFields: ["room", "unknown", "track"],
      }),
    ).toBe("https://callboard.test/embed/conf/schedule?format=json&hide=room&hide=track");
  });

  it("MUST NOT FIRE: a saved embed URL contains no ad-hoc options", () => {
    expect(
      buildEmbedUrl({
        origin: "https://callboard.test",
        slug: "conf",
        widget: "schedule",
        embedId: "saved-1",
        theme: "dark",
        accent: "#fff",
        density: "compact",
        format: "xml",
        hiddenFields: ["room"],
      }),
    ).toBe("https://callboard.test/embed/conf/schedule?embed=saved-1");
  });

  it("builds feeds only for schedule-backed widgets", () => {
    expect(buildFeedUrl({ origin: "https://x.test", slug: "conf", widget: "schedule" })).toBe(
      "https://x.test/e/conf/schedule.ics",
    );
    expect(buildFeedUrl({ origin: "https://x.test/", slug: "conf", widget: "agenda" })).toBe(
      "https://x.test/e/conf/schedule.ics",
    );
    expect(buildFeedUrl({ origin: "https://x.test", slug: "conf", widget: "speakers" })).toBeNull();
    expect(buildFeedUrl({ origin: "https://x.test", slug: "conf", widget: "gallery" })).toBeNull();
  });

  it("builds iframe, escaped HTML, and iCal snippets", () => {
    const base = {
      url: "https://x.test/embed/conf/schedule?a=1&b=2",
      feedUrl: "https://x.test/e/conf/schedule.ics?a=1&b=2",
      eventName: "A & <B>",
      widgetLabel: "Schedule",
    };
    expect(buildSnippet({ ...base, format: "iframe" })).toBe(
      buildIframeSnippet(base),
    );
    expect(buildSnippet({ ...base, format: "html" })).toBe(
      '<div class="callboard-embed"><a href="https://x.test/embed/conf/schedule?a=1&amp;b=2" target="_blank" rel="noopener">A &amp; &lt;B&gt; — Schedule</a></div>',
    );
    expect(buildSnippet({ ...base, format: "ical" })).toContain(
      'href="https://x.test/e/conf/schedule.ics?a=1&amp;b=2"',
    );
    expect(buildSnippet({ ...base, format: "json" })).toContain(
      "Fetch A &amp; &lt;B&gt;",
    );
    expect(buildSnippet({ ...base, format: "xml" })).not.toContain("&lt;iframe");
  });

  it("MUST NOT FIRE: iCal without a feed falls back to a live iframe", () => {
    const options = {
      format: "ical" as const,
      url: "https://x.test/embed/conf/gallery",
      feedUrl: null,
      eventName: "Conf",
      widgetLabel: "Speaker gallery",
    };
    expect(buildSnippet(options)).toBe(buildIframeSnippet(options));
    expect(buildSnippet(options)).not.toContain("Subscribe to");
  });

  it("escapes all interpolated attribute content", () => {
    const url = buildEmbedUrl({
      origin: "https://callboard.test",
      slug: "conf",
      widget: "schedule",
      theme: "dark",
      track: "Evals & Reliability",
    });
    const snippet = buildIframeSnippet({
      url,
      eventName: `Ben & Jerry's <Conf> "2027"`,
      widgetLabel: "Schedule",
    });

    expect(snippet).toContain(
      'src="https://callboard.test/embed/conf/schedule?theme=dark&amp;track=Evals+%26+Reliability"',
    );
    expect(snippet).toContain(
      `title="Ben &amp; Jerry's &lt;Conf&gt; &quot;2027&quot; — Schedule"`,
    );
    expect(snippet).not.toContain("<Conf>");
  });

  it("round-trips known themes and falls unknown values back to auto", () => {
    expect(["light", "dark", "auto"].map((theme) => parseTheme(theme))).toEqual([
      "light",
      "dark",
      "auto",
    ]);
    expect(parseTheme("purple")).toBe("auto");
    expect(parseTheme(null)).toBe("auto");
  });
});

describe("saved embed settings", () => {
  it("MUST FIRE: normalises legacy rows and poisoned stored accents", () => {
    const { format: _format, density: _density, accent: _accent, ...legacy } = saved;
    expect(readSavedEmbeds({ embeds: [legacy] })[0]).toMatchObject({
      format: "iframe",
      density: "full",
      accent: null,
      customCss: null,
      hiddenFields: [],
    });
    expect(
      readSavedEmbeds({
        embeds: [
          {
            ...saved,
            format: "yaml",
            density: "airy",
            accent: "red;}body{display:none",
            customCss: "</style><script>alert(1)</script>",
            hiddenFields: ["room", "unknown", "room"],
          },
        ],
      })[0],
    ).toMatchObject({
      format: "iframe",
      density: "full",
      accent: null,
      hiddenFields: ["room"],
    });
    const sanitised = readSavedEmbeds({
      embeds: [{ ...saved, customCss: "</style><script>alert(1)</script>" }],
    })[0].customCss;
    expect(sanitised?.toLowerCase()).not.toContain("</style");
    expect(sanitised?.toLowerCase()).not.toContain("<script");
  });
  it("tolerates absent and malformed settings while retaining a valid subset", () => {
    expect(readSavedEmbeds(null)).toEqual([]);
    expect(readSavedEmbeds({})).toEqual([]);
    expect(readSavedEmbeds({ embeds: "nope" })).toEqual([]);
    expect(readSavedEmbeds({ embeds: [{ nope: true }] })).toEqual([]);
    expect(readSavedEmbeds({ settings: { embeds: [{ nope: true }, saved] } })).toEqual([
      saved,
    ]);
  });

  it("MUST NOT FIRE: upsert, toggle, and remove preserve unrelated settings keys", () => {
    const original = { branding: { accent: "blue" }, someFlag: true };
    const inserted = upsertSavedEmbed(original, saved);
    expect(inserted).toMatchObject(original);
    expect(readSavedEmbeds(inserted)).toEqual([saved]);

    const toggled = toggleSavedEmbed(inserted, saved.id);
    expect(toggled.found).toBe(true);
    expect(toggled.settings).toMatchObject(original);
    expect(readSavedEmbeds(toggled.settings)[0].enabled).toBe(false);

    const removed = removeSavedEmbed(toggled.settings, saved.id);
    expect(removed.found).toBe(true);
    expect(removed.settings).toMatchObject(original);
    expect(readSavedEmbeds(removed.settings)).toEqual([]);
  });

  it("MUST NOT FIRE: unknown toggle/remove ids do not alter saved embeds", () => {
    const settings = upsertSavedEmbed({ someFlag: true }, saved);
    const toggled = toggleSavedEmbed(settings, "unknown");
    const removed = removeSavedEmbed(settings, "unknown");
    expect(toggled.found).toBe(false);
    expect(removed.found).toBe(false);
    expect(readSavedEmbeds(toggled.settings)).toEqual([saved]);
    expect(readSavedEmbeds(removed.settings)).toEqual([saved]);
  });
});
