import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, reviewRounds, reviews, sessions } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { AbstractsView, listUrl, loader } from "./admin.submissions";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const ROUND = "81818181-8181-4181-8181-818181818181";
const RECUSED_REVIEWER = "82828282-8282-4282-8282-828282828282";
const UNSUBMITTED_REVIEWER = "83838383-8383-4383-8383-838383838383";
const UNSCORED = "84848484-8484-4484-8484-848484848484";
const HIGH_TITLE = "Your AI Pair Programmer";
const LOW_TITLE = "Taming 40-Minute CI";
const UNSCORED_TITLE = "A submission awaiting review";

let ctx: TestDbContext;
let fixture: DemoFixture;

const args = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);

  await ctx.db.insert(people).values([
    {
      id: RECUSED_REVIEWER,
      email: "recused-score-reviewer@example.com",
      fullName: "Recused Reviewer",
      role: "admin",
    },
    {
      id: UNSUBMITTED_REVIEWER,
      email: "draft-score-reviewer@example.com",
      fullName: "Draft Reviewer",
      role: "admin",
    },
  ]);
  await ctx.db.insert(reviewRounds).values({
    id: ROUND,
    eventId: fixture.eventId,
    name: "Programme review",
    ordinal: 1,
    rubric: {
      criteria: [
        { key: "originality", label: "Originality", min: 1, max: 5, weight: 2 },
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
      ],
    },
  });

  const highId = fixture.abstractIds[3];
  const lowId = fixture.abstractIds[4];
  await ctx.db
    .update(sessions)
    .set({ title: HIGH_TITLE, trackId: fixture.trackIds[0], createdAt: new Date("2026-01-01") })
    .where(eq(sessions.id, highId));
  await ctx.db
    .update(sessions)
    .set({ title: LOW_TITLE, trackId: fixture.trackIds[1], createdAt: new Date("2026-03-01") })
    .where(eq(sessions.id, lowId));
  await ctx.db.insert(sessions).values({
    id: UNSCORED,
    eventId: fixture.eventId,
    friendlyId: "ABS-99",
    title: UNSCORED_TITLE,
    status: "pending",
    isAbstract: true,
    trackId: fixture.trackIds[0],
    createdAt: new Date("2026-02-01"),
  });

  const submittedAt = new Date("2026-08-12T12:00:00Z");
  await ctx.db.insert(reviews).values([
    {
      id: "85858585-8585-4585-8585-858585858585",
      roundId: ROUND,
      sessionId: highId,
      reviewerId: fixture.adminId,
      totalScore: 15,
      submittedAt,
    },
    {
      id: "86868686-8686-4686-8686-868686868686",
      roundId: ROUND,
      sessionId: lowId,
      reviewerId: fixture.adminId,
      totalScore: 10,
      submittedAt,
    },
    {
      id: "87878787-8787-4787-8787-878787878787",
      roundId: ROUND,
      sessionId: lowId,
      reviewerId: RECUSED_REVIEWER,
      totalScore: 15,
      submittedAt,
      recusedAt: new Date("2026-08-12T12:01:00Z"),
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      roundId: ROUND,
      sessionId: lowId,
      reviewerId: UNSUBMITTED_REVIEWER,
      totalScore: 3,
      submittedAt: null,
    },
  ]);
});

afterEach(() => ctx.close());

async function load(url: string): Promise<LoaderData> {
  return loader(args(await signedInGet(url, fixture.adminId)));
}

function scoreCell(html: string, sessionId: string): string {
  const marker = `data-testid="aggregate-score-${sessionId}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</td>", start));
}

describe("submission aggregate scores", () => {
  it("must fire: sorts distinct aggregates in both directions by row value", async () => {
    const descending = await load(
      "https://x.test/admin/submissions?tab=pending&sort=score-desc",
    );
    const ascending = await load(
      "https://x.test/admin/submissions?tab=pending&sort=score-asc",
    );

    expect(descending.rows.map((row) => row.title)).toEqual([
      HIGH_TITLE,
      LOW_TITLE,
      UNSCORED_TITLE,
    ]);
    expect(ascending.rows.map((row) => row.title)).toEqual([
      LOW_TITLE,
      HIGH_TITLE,
      UNSCORED_TITLE,
    ]);
    expect(descending.rows.map((row) => row.aggregateScore)).toEqual([5, 10 / 3, null]);
  });

  it("must fire: renders the weighted criterion-scale average as 3.33", async () => {
    const data = await load("https://x.test/admin/submissions?tab=pending&sort=score-desc");
    const html = renderToStaticMarkup(<AbstractsView {...data} />);
    const cell = scoreCell(html, fixture.abstractIds[4]);

    expect(cell).toContain("3.33");
    expect(cell).not.toContain("3.00");
    expect(cell).toContain("1 review");
  });

  it("must fire: an unreviewed abstract renders an em dash and remains last", async () => {
    for (const direction of ["score-desc", "score-asc"] as const) {
      const data = await load(
        `https://x.test/admin/submissions?tab=pending&sort=${direction}`,
      );
      expect(data.rows.at(-1)?.title).toBe(UNSCORED_TITLE);
      const html = renderToStaticMarkup(<AbstractsView {...data} />);
      expect(scoreCell(html, UNSCORED)).toContain("—");
    }
  });

  it("must NOT fire: recused and unsubmitted rows do not move the genuine review", async () => {
    const data = await load("https://x.test/admin/submissions?tab=pending");
    const low = data.rows.find((row) => row.title === LOW_TITLE);
    const unscored = data.rows.find((row) => row.title === UNSCORED_TITLE);

    expect(low).toMatchObject({ aggregateScore: 10 / 3, reviewCount: 1 });
    expect(unscored).toMatchObject({ aggregateScore: null, reviewCount: 0 });
  });

  it("must fire: an all-dropdown round shows the review count instead of an empty cell", async () => {
    /*
     * The round's rubric becomes select-only, so its weight total is 0 and no
     * review can produce a number. The cell used to fall back to a bare em dash
     * — byte-identical to the untouched abstract two rows down — while the CSV
     * reported 0 reviews for the same submission.
     */
    await ctx.db
      .update(reviewRounds)
      .set({
        rubric: {
          criteria: [
            {
              key: "recommendation",
              label: "Recommendation",
              min: 0,
              max: 0,
              weight: 0,
              type: "select",
              options: ["Accept", "Reject"],
            },
          ],
        },
      })
      .where(eq(reviewRounds.id, ROUND));

    const data = await load("https://x.test/admin/submissions?tab=pending");
    const reviewed = data.rows.find((row) => row.title === LOW_TITLE);
    expect(reviewed).toMatchObject({ aggregateScore: null, reviewCount: 1 });

    const html = renderToStaticMarkup(<AbstractsView {...data} />);
    const cell = scoreCell(html, fixture.abstractIds[4]);
    expect(cell).toContain("—");
    expect(cell).toContain("1 review");

    // MUST NOT FIRE: the genuinely untouched abstract stays a bare em dash under
    // the same rubric, so the two are no longer the same cell.
    const untouched = scoreCell(html, UNSCORED);
    expect(untouched).toContain("—");
    expect(untouched).not.toContain("review");
  });

  it("must NOT fire: junk sort falls back and tab plus track filters still apply", async () => {
    const fallback = await load(
      "https://x.test/admin/submissions?tab=pending&sort=nonsense",
    );
    expect(fallback.sort).toBeNull();
    expect(fallback.rows.map((row) => row.title)).toEqual([
      LOW_TITLE,
      UNSCORED_TITLE,
      HIGH_TITLE,
    ]);

    const filtered = await load(
      `https://x.test/admin/submissions?tab=accepted&track=${fixture.trackIds[0]}&sort=score-desc`,
    );
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.every((row) => row.status === "accepted")).toBe(true);
    expect(filtered.rows.every((row) => row.trackName === "Agents")).toBe(true);
    expect(filtered.rows.map((row) => row.title)).not.toContain(HIGH_TITLE);
  });

  it("must NOT fire: default links omit sort while active sort survives navigation", async () => {
    expect(listUrl("pending", null)).toBe("/admin/submissions?tab=pending");
    expect(listUrl("pending", null)).not.toContain("sort=");

    const data = await load(
      `https://x.test/admin/submissions?tab=pending&track=${fixture.trackIds[0]}&sort=score-desc`,
    );
    const html = renderToStaticMarkup(<AbstractsView {...data} />);
    expect(html).toContain(
      `href="/admin/submissions?tab=accepted&amp;track=${fixture.trackIds[0]}&amp;sort=score-desc"`,
    );
    expect(html).toContain('<input type="hidden" name="sort" value="score-desc"/>');
    expect(html).toContain('aria-sort="descending"');
  });
});
