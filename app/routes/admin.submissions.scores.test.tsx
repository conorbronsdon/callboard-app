import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, reviewRounds, reviews, sessions } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  SubmissionDetailView,
  loader as detailLoader,
  submissionLoaderPayload,
} from "./admin.submission";
import { AbstractsView, listUrl, loader } from "./admin.submissions";

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const detailArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as Parameters<typeof detailLoader>[0];

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

  it("MUST FIRE: the list prints the same weighted number the detail page prints (ABS-10)", async () => {
    /*
     * One review, total 10, under a rubric weighing 3 and maxing at 15
     * (originality ×2 and relevance ×1, both out of 5). The detail page has
     * always said "10.0 / 15". The list said "3.33" — the same review divided
     * by the weight total instead of measured against the maximum — with
     * nothing on either screen naming which scale it was on. Two unlabelled
     * numbers for one review read as a scoring bug, and in the eval it was
     * reported as one.
     */
    const lowId = fixture.abstractIds[4];
    const data = await load("https://x.test/admin/submissions?tab=pending&sort=score-desc");
    const cell = scoreCell(renderToStaticMarkup(<AbstractsView {...data} />), lowId);

    expect(cell).toContain("10.0 / 15");
    expect(cell).toContain("1 review");
    // The two old readings of the same review are gone from the cell.
    expect(cell).not.toContain("3.33");
    expect(cell).not.toContain("3.00");

    // ...and the detail page, unchanged, states it the same way.
    const detail = submissionLoaderPayload(
      await detailLoader(
        detailArgs(
          await signedInGet(`https://x.test/admin/submissions/${lowId}?tab=pending`, fixture.adminId),
          lowId,
        ),
      ),
    );
    const detailHtml = renderToStaticMarkup(<SubmissionDetailView {...detail} />);
    expect(detailHtml).toContain("10.0 / 15");
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

/*
 * ─────────────────────────────────────────────── contested disagreement ──
 *
 * The score list is where a programme chair builds the agenda for the
 * committee call, and the rows worth arguing about are not the top of the
 * sort — they are the ones the panel split on. The rubric in this file weighs
 * 3 and maxes at 15 (originality ×2, relevance ×1, both out of 5), so every
 * number below is hand-computed against those two constants.
 */
const SECOND_REVIEWER = "89898989-8989-4989-8989-898989898989";
const WIDE_ROUND = "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b";

describe("contested submissions", () => {
  /** A second genuine review of HIGH_TITLE, `totalScore` points apart from 15. */
  async function addSecondReview(totalScore: number): Promise<void> {
    await ctx.db.insert(people).values({
      id: SECOND_REVIEWER,
      email: "second-score-reviewer@example.com",
      fullName: "Second Reviewer",
      role: "admin",
    });
    await ctx.db.insert(reviews).values({
      id: "8a8a8a8a-8a8a-48a8-8a8a-8a8a8a8a8a8a",
      roundId: ROUND,
      sessionId: fixture.abstractIds[3],
      reviewerId: SECOND_REVIEWER,
      totalScore,
      submittedAt: new Date("2026-08-12T12:00:00Z"),
    });
  }

  it("MUST FIRE: a split panel is badged, and the badge names the spread", async () => {
    // 15/15 is 5.00 and 6/15 is 2.00 — three points apart on a five-point
    // scale, or nine of fifteen weighted.
    await addSecondReview(6);

    const data = await load("https://x.test/admin/submissions?tab=pending");
    const high = data.rows.find((row) => row.title === HIGH_TITLE);

    expect(high?.contested).toBe(true);
    expect(high?.disagreement).toMatchObject({
      gap: 3,
      gapWeighted: 9,
      // 12, not 15: the widest gap the rubric ALLOWS (4 points × 3 weight),
      // where 15 is the highest score it allows.
      weightedSpan: 12,
      severity: 0.75,
      reviewCount: 2,
    });
    expect(high?.weighted).toEqual({ average: 10.5, max: 15 });

    const html = renderToStaticMarkup(<AbstractsView {...data} />);
    const cell = scoreCell(html, fixture.abstractIds[3]);
    expect(cell).toContain("Contested");
    expect(cell).toContain("Widest gap 9.0 of 12 possible across 2 reviews");
    // Advisory: the badge sits beside the score, and the status cell is
    // untouched — nothing here moves a submission anywhere.
    expect(cell).toContain("10.5 / 15");
    expect(html).toContain("Advisory only — nothing about the decision changes.");
  });

  it("MUST NOT FIRE: reviewers who broadly agree get no badge", async () => {
    // 5.00 against 4.00 is one point apart, under the 1.50 threshold.
    await addSecondReview(12);

    const data = await load("https://x.test/admin/submissions?tab=pending");
    expect(data.rows.find((row) => row.title === HIGH_TITLE)?.contested).toBe(false);
    expect(renderToStaticMarkup(<AbstractsView {...data} />)).not.toContain("Contested");
  });

  it("MUST NOT FIRE: one review, a recusal and a draft raise no dispute", async () => {
    /*
     * LOW_TITLE carries exactly the rows that would fake a disagreement if the
     * metric counted anything a reviewer typed: one genuine 10, a RECUSED 15
     * (which would read as a 1.67 gap and badge the row) and an unsubmitted 3
     * (which would read as 2.33).
     */
    const data = await load("https://x.test/admin/submissions?tab=pending");
    const low = data.rows.find((row) => row.title === LOW_TITLE);
    const unscored = data.rows.find((row) => row.title === UNSCORED_TITLE);

    expect(low).toMatchObject({ contested: false, reviewCount: 1 });
    expect(low?.disagreement.gap).toBeNull();
    expect(unscored?.contested).toBe(false);

    const html = renderToStaticMarkup(<AbstractsView {...data} />);
    expect(scoreCell(html, fixture.abstractIds[4])).not.toContain("Contested");
    expect(scoreCell(html, UNSCORED)).not.toContain("Contested");
  });

  it("MUST FIRE: the contested sort puts the split panel first and offers the control", async () => {
    await addSecondReview(6);

    const contested = await load(
      "https://x.test/admin/submissions?tab=pending&sort=contested-desc",
    );
    expect(contested.sort).toBe("contested-desc");
    // HIGH_TITLE is the only contested row; the rest fall back to newest-first.
    expect(contested.rows.map((row) => row.title)).toEqual([
      HIGH_TITLE,
      LOW_TITLE,
      UNSCORED_TITLE,
    ]);

    // ...and it is genuinely a different order from the score sort, which puts
    // the same row first for a different reason. Ordering by score descending
    // ranks HIGH (10.5) above LOW (10.0); ordering by disagreement ranks it
    // first because its panel split, so the two agree here only by coincidence
    // of the fixture — the control that matters is the ascending sort, where
    // the contested row goes last.
    const ascending = await load("https://x.test/admin/submissions?tab=pending&sort=score-asc");
    expect(ascending.rows.map((row) => row.title)).toEqual([
      LOW_TITLE,
      HIGH_TITLE,
      UNSCORED_TITLE,
    ]);

    const html = renderToStaticMarkup(<AbstractsView {...contested} />);
    expect(html).toContain('data-testid="sort-contested"');
    // The href React rendered, ampersand-escaped as it appears in the markup.
    expect(html).toContain(
      listUrl("pending", null, "", "contested-desc").replace(/&/g, "&amp;"),
    );
  });

  it("MUST FIRE: contested sort ranks severity above a larger raw gap from a wider rubric", async () => {
    await addSecondReview(6);
    await ctx.db.insert(reviewRounds).values({
      id: WIDE_ROUND,
      eventId: fixture.eventId,
      name: "Wide-scale review",
      ordinal: 2,
      rubric: {
        criteria: [{ key: "confidence", label: "Confidence", min: 0, max: 100, weight: 1 }],
      },
    });
    await ctx.db.insert(reviews).values([
      {
        id: "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c",
        roundId: WIDE_ROUND,
        sessionId: fixture.abstractIds[4],
        reviewerId: fixture.adminId,
        totalScore: 80,
        submittedAt: new Date("2026-08-12T12:00:00Z"),
      },
      {
        id: "8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d",
        roundId: WIDE_ROUND,
        sessionId: fixture.abstractIds[4],
        reviewerId: RECUSED_REVIEWER,
        totalScore: 60,
        submittedAt: new Date("2026-08-12T12:00:00Z"),
      },
    ]);

    const data = await load(
      "https://x.test/admin/submissions?tab=pending&sort=contested-desc",
    );
    const high = data.rows.find((row) => row.title === HIGH_TITLE);
    const low = data.rows.find((row) => row.title === LOW_TITLE);

    expect(high?.disagreement).toMatchObject({ gap: 3, severity: 0.75 });
    expect(low?.disagreement).toMatchObject({ gap: 20, severity: 0.2 });
    expect(high?.contested).toBe(true);
    expect(low?.contested).toBe(false);
    expect(data.rows[0].title).toBe(HIGH_TITLE);
    expect(data.rows.indexOf(high!)).toBeLessThan(data.rows.indexOf(low!));
  });

  it("MUST NOT FIRE: the contested sort changes no status and gates nothing", async () => {
    await addSecondReview(6);

    const before = await ctx.db.select({ id: sessions.id, status: sessions.status }).from(sessions);
    const data = await load("https://x.test/admin/submissions?tab=pending&sort=contested-desc");
    const after = await ctx.db.select({ id: sessions.id, status: sessions.status }).from(sessions);

    expect(after).toEqual(before);
    // Every row still reports the status it had; the badge is presentation.
    expect(data.rows.every((row) => row.status === "pending")).toBe(true);
  });
});
