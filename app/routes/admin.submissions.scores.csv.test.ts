import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people, reviewRounds, reviews } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { loader } from "./admin.submissions.scores.csv";

type LoaderArgs = Parameters<typeof loader>[0];

const args = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  await ctx.db.insert(reviewRounds).values({
    id: "91919191-9191-4191-8191-919191919191",
    eventId: fixture.eventId,
    name: "Screening",
    ordinal: 1,
    rubric: {
      criteria: [
        { key: "originality", label: "Originality", min: 1, max: 5, weight: 2 },
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  await ctx.db.insert(reviews).values({
    id: "92929292-9292-4292-8292-929292929292",
    roundId: "91919191-9191-4191-8191-919191919191",
    sessionId: fixture.abstractIds[3],
    reviewerId: fixture.adminId,
    totalScore: 10,
    submittedAt: new Date("2026-08-12T12:00:00Z"),
  });
});

afterEach(() => ctx.close());

describe("admin review score CSV route", () => {
  it("returns an attachment with one row per abstract", async () => {
    const request = await signedInGet(
      "https://x.test/admin/submissions/scores.csv",
      fixture.adminId,
    );
    const response = await loader(args(request));

    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="frontier-ai-summit-2026-review-scores.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const lines = (await response.text()).trimEnd().split("\r\n");
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe(
      // Human columns first, in order, and the two ABS-14 advisory columns
      // LAST — the ordering the CSV's separation guarantee depends on.
      "ID,Title,Track,Status,Reviews,Aggregate score,Screening,Reviewer comments," +
        "AI triage score (advisory),AI triage recommendation (advisory)",
    );
    expect(lines.find((line) => line.startsWith("ABS-4,"))).toContain(",1,3.33,3.33");
  });

  /* ------------------------------------------- CFP-11: comments in export */

  const ROUND = "91919191-9191-4191-8191-919191919191";
  const NAMED_REVIEWER = "93939393-9393-4393-8393-939393939393";
  const RECUSED_REVIEWER = "94949494-9494-4494-8494-949494949494";

  async function addReviewer(id: string, email: string, fullName: string) {
    await ctx.db.insert(people).values({ id, email, fullName, role: "speaker" });
  }

  it("must fire: a named reviewer's comment reaches the export", async () => {
    // Route level, not unit level: `buildScoreCsv` cannot prove the LOADER
    // selects `reviews.comment` or joins `people` for the name. Before that
    // join existed this row came back as an empty cell.
    await addReviewer(NAMED_REVIEWER, "sam@example.com", "Sam Whitfield");
    await ctx.db.insert(reviews).values({
      id: "95959595-9595-4595-8595-959595959595",
      roundId: ROUND,
      sessionId: fixture.abstractIds[4],
      reviewerId: NAMED_REVIEWER,
      totalScore: 12,
      comment: "Strong fit; wants a rehearsal.",
      submittedAt: new Date("2026-08-12T12:00:00Z"),
    });

    const response = await loader(
      args(await signedInGet("https://x.test/admin/submissions/scores.csv", fixture.adminId)),
    );
    const body = await response.text();

    // Unquoted on purpose: a semicolon is not a CSV special character, so the
    // escaper leaves the field bare. `score-export.test.ts` owns the quoting
    // rules; this asserts the value arrived at all.
    const row = body.split("\r\n").find((line) => line.startsWith("ABS-5,"));
    expect(row).toContain("Sam Whitfield (Screening): Strong fit; wants a rehearsal.");
  });

  it("must NOT fire: a recused reviewer's note never reaches the export", async () => {
    await addReviewer(RECUSED_REVIEWER, "rita@example.com", "Recused Rita");
    await ctx.db.insert(reviews).values({
      id: "96969696-9696-4696-8696-969696969696",
      roundId: ROUND,
      sessionId: fixture.abstractIds[5],
      reviewerId: RECUSED_REVIEWER,
      comment: "I used to work with this speaker.",
      submittedAt: new Date("2026-08-12T12:00:00Z"),
      recusedAt: new Date("2026-08-12T12:00:00Z"),
    });

    const response = await loader(
      args(await signedInGet("https://x.test/admin/submissions/scores.csv", fixture.adminId)),
    );
    const body = await response.text();

    expect(body).not.toContain("Recused Rita");
    expect(body).not.toContain("used to work with this speaker");
    // Control: the row for that abstract IS in the document, so the absence
    // above is a filtered comment and not a missing submission.
    expect(body).toContain("ABS-6,");
  });

  it("does not return the file without an admin session", async () => {
    await expect(
      loader(args(new Request("https://x.test/admin/submissions/scores.csv"))),
    ).rejects.toMatchObject({ status: 302 });
  });
});
