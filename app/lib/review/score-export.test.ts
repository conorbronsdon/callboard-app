import { describe, expect, it } from "vitest";

import { CSV_EOL } from "~/lib/integrations/accelevents-csv";
import { aggregateFor } from "./aggregate";
import { buildScoreCsv, type ScoreExportRound, type ScoreExportSubmission } from "./score-export";
import type { Rubric } from "./scoring";

const RUBRIC: Rubric = {
  criteria: [
    { key: "originality", label: "Originality", min: 1, max: 5, weight: 2 },
    { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
  ],
};
const ROUNDS: ScoreExportRound[] = [
  { id: "round-one", name: "Screening", rubric: RUBRIC },
  { id: "round-two", name: "Final", rubric: RUBRIC },
];

function submission(
  title: string,
  reviews: ScoreExportSubmission["reviews"] = [],
): ScoreExportSubmission {
  return {
    friendlyId: "ABS-1",
    title,
    trackName: "Agents",
    status: "pending",
    reviews,
  };
}

function submitted(
  roundId: string,
  totalScore: number,
  scores?: Record<string, number | string>,
) {
  return {
    roundId,
    totalScore,
    scores,
    submittedAt: new Date("2026-08-12T12:00:00Z"),
    recusedAt: null,
  };
}

function parseCsv(document: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < document.length; index += 1) {
    const char = document[index];
    if (char === '"') {
      if (quoted && document[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      record.push(field);
      field = "";
    } else if (char === "\r" && document[index + 1] === "\n" && !quoted) {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      index += 1;
    } else {
      field += char;
    }
  }
  return records;
}

describe("review score CSV", () => {
  it("must fire: emits comma and quote titles as one exactly escaped field", () => {
    const title = 'Taming 40-Minute CI, the "fast" way';
    const csv = buildScoreCsv([submission(title, [submitted("round-one", 10)])], ROUNDS);

    expect(csv.split(CSV_EOL)[1]).toBe(
      // Trailing empties: Final, Reviewer comments (CFP-11), and the two
      // advisory AI columns (ABS-14). This submission has no triage row, and a
      // human column must never borrow one of the advisory fields.
      'ABS-1,"Taming 40-Minute CI, the ""fast"" way",Agents,Pending,1,3.33,3.33,,,,',
    );
    expect(parseCsv(csv)).toHaveLength(2);
    expect(parseCsv(csv)[1][1]).toBe(title);
  });

  it("must fire: keeps a newline inside one quoted title without adding a record", () => {
    const title = "A title on line one\nand line two";
    const csv = buildScoreCsv([submission(title)], ROUNDS);
    const records = parseCsv(csv);

    expect(records).toHaveLength(2);
    expect(records[1][1]).toBe(title);
  });

  it("must fire: round columns and overall aggregate share the aggregate arithmetic", () => {
    const reviews = [submitted("round-one", 12), submitted("round-two", 15)];
    const csv = buildScoreCsv([submission("Round trip", reviews)], ROUNDS);
    const records = parseCsv(csv);
    const expected = aggregateFor(reviews, new Map(ROUNDS.map((round) => [round.id, round.rubric])));

    expect(records[0]).toEqual([
      "ID",
      "Title",
      "Track",
      "Status",
      "Reviews",
      "Aggregate score",
      "Screening",
      "Final",
      "Reviewer comments",
      "AI triage score (advisory)",
      "AI triage recommendation (advisory)",
    ]);
    expect(records[1].slice(4)).toEqual([
      "2",
      expected.average?.toFixed(2),
      "4.00",
      "5.00",
      // Reviewer comments, then must-not-fire: no `aiTriage` on this
      // submission, so the advisory pair stays blank rather than inheriting a
      // human number.
      "",
      "",
      "",
    ]);
  });

  it("must NOT fire: an unscored submission uses blank score cells", () => {
    const record = parseCsv(buildScoreCsv([submission("Awaiting scores")], ROUNDS))[1];

    expect(record.slice(4)).toEqual(["0", "", "", "", "", "", ""]);
    expect(record.join(",")).not.toContain("NaN");
    expect(record.slice(5)).not.toContain("0");
  });

  it("must NOT fire: a plain title remains unquoted", () => {
    const csv = buildScoreCsv([submission("Plain title")], ROUNDS);
    expect(csv.split(CSV_EOL)[1]).toBe("ABS-1,Plain title,Agents,Pending,0,,,,,,");
    expect(csv).not.toContain('"Plain title"');
  });

  /* ------------------------------- dropdown distribution columns (main) ---
   * These ran against a CSV whose LAST column was the dropdown tally. The
   * reviewer-comments column (CFP-11, below) now sits after every round and
   * every dropdown column, so `.at(-1)` would assert on the wrong cell. The
   * indices are explicit and the comments column is asserted as last, which is
   * what proves the two features compose rather than displace each other.
   */
  it("must fire: appends one dropdown distribution column", () => {
    const rounds: ScoreExportRound[] = [
      {
        id: "round-one",
        name: "Screening",
        rubric: {
          criteria: [
            ...RUBRIC.criteria,
            {
              key: "recommendation",
              label: "Recommendation",
              min: 0,
              max: 0,
              weight: 0,
              type: "select",
              options: ["Accept", "Maybe", "Reject"],
            },
          ],
        },
      },
    ];
    const reviews = [
      submitted("round-one", 10, { recommendation: "Accept" }),
      submitted("round-one", 12, { recommendation: "Accept" }),
      submitted("round-one", 15, { recommendation: "Maybe" }),
    ];
    const records = parseCsv(buildScoreCsv([submission("With choices", reviews)], rounds));

    /*
     * `.at(-4)`, not `.at(-1)`: CFP-11 appends "Reviewer comments" and ABS-14
     * appends two ADVISORY AI columns after every human column, so the dropdown
     * distribution is now fourth from the end. The assertions below pin the
     * whole tail ordering — a future column sliding in between would move these
     * indices and fail loudly rather than silently compare the wrong cell.
     */
    expect(records[0].at(-4)).toBe("Screening — Recommendation");
    expect(records[1].at(-4)).toBe("Accept ×2; Maybe ×1");
    expect(records[0].at(-3)).toBe("Reviewer comments");
    expect(records[0].slice(-2)).toEqual([
      "AI triage score (advisory)",
      "AI triage recommendation (advisory)",
    ]);
    // must-not-fire: this submission has no AI opinion, so the advisory pair is
    // blank — the dropdown tally never leaks rightward into it.
    expect(records[1].slice(-2)).toEqual(["", ""]);
    expect(records[0]).toHaveLength(11);
  });

  it("must NOT fire: dropdown criteria do not change the aggregate score cell", () => {
    const reviews = [submitted("round-one", 10, { recommendation: "Accept" })];
    const withChoice: ScoreExportRound[] = [
      {
        ...ROUNDS[0],
        rubric: {
          criteria: [
            ...RUBRIC.criteria,
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
      },
    ];
    const without = parseCsv(buildScoreCsv([submission("Control", reviews)], [ROUNDS[0]]));
    const withDropdown = parseCsv(buildScoreCsv([submission("Control", reviews)], withChoice));

    expect(withDropdown[1][5]).toBe(without[1][5]);
  });

  it("must fire: an all-dropdown round exports the true review count with a blank score", () => {
    /*
     * The case every other dropdown test here misses by one criterion: both of
     * them spread `RUBRIC.criteria` first, so the weight total is never 0. With
     * a select-only rubric it is, and the Reviews column used to read 0 for a
     * submission three reviewers had finished — indistinguishable from
     * "Awaiting scores" above.
     */
    const selectOnly: ScoreExportRound[] = [
      {
        id: "round-one",
        name: "Screening",
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
      },
    ];
    const reviews = [
      submitted("round-one", 0, { recommendation: "Accept" }),
      submitted("round-one", 0, { recommendation: "Reject" }),
      submitted("round-one", 0, { recommendation: "Accept" }),
    ];
    const record = parseCsv(
      buildScoreCsv([submission("Fully reviewed", reviews)], selectOnly),
    )[1];

    // Reviews, Aggregate score, Screening, distribution, reviewer comments —
    // then the two ABS-14 advisory columns, empty because no `aiTriage` was
    // passed. Kept in the expectation rather than sliced away: this is the
    // assertion that would notice a human number sliding into an AI column.
    expect(record.slice(4)).toEqual(["3", "", "", "Accept ×2; Reject ×1", "", "", ""]);
    // MUST NOT FIRE the other way: an untouched submission under the SAME
    // rubric still reports zero, so the count is the reviews and not the rubric.
    expect(
      parseCsv(buildScoreCsv([submission("Untouched")], selectOnly))[1].slice(4),
    ).toEqual(["0", "", "", "", "", "", ""]);
  });

  /* ----------------------------------------------- CFP-11: comment column */

  const COMMENTS = 8; // index of the "Reviewer comments" column, after both rounds

  it("must fire: a submitted reviewer comment reaches the export named and round-labelled", () => {
    const csv = buildScoreCsv(
      [
        submission("Commented", [
          { ...submitted("round-one", 12), reviewerName: "Sam Whitfield", comment: "Strong fit, weak demo." },
        ]),
      ],
      ROUNDS,
    );
    const record = parseCsv(csv)[1];

    expect(record[COMMENTS]).toBe("Sam Whitfield (Screening): Strong fit, weak demo.");
    // The header names the column, and the cell is a single field despite the comma.
    expect(parseCsv(csv)[0][COMMENTS]).toBe("Reviewer comments");
    // 11, not 9: ABS-14's two advisory columns sit to the RIGHT of comments, so
    // COMMENTS stays at 8 while the record grows.
    expect(record).toHaveLength(11);
  });

  it("must fire: two reviewers on one abstract both appear, ordered by round then name", () => {
    const record = parseCsv(
      buildScoreCsv(
        [
          submission("Two reviewers", [
            { ...submitted("round-two", 15), reviewerName: "Zoe Last", comment: "Second round take." },
            { ...submitted("round-one", 12), reviewerName: "Ada Organiser", comment: "First round take." },
          ]),
        ],
        ROUNDS,
      ),
    )[1];

    expect(record[COMMENTS]).toBe(
      "Ada Organiser (Screening): First round take. | Zoe Last (Final): Second round take.",
    );
  });

  it("must NOT fire: recused, unsubmitted and blank comments never reach the export", () => {
    const record = parseCsv(
      buildScoreCsv(
        [
          submission("Nothing to show", [
            {
              roundId: "round-one",
              totalScore: 12,
              submittedAt: new Date("2026-08-12T12:00:00Z"),
              recusedAt: new Date("2026-08-12T12:00:00Z"),
              reviewerName: "Recused Rita",
              comment: "I know the speaker personally.",
            },
            {
              roundId: "round-one",
              totalScore: null,
              submittedAt: null,
              recusedAt: null,
              reviewerName: "Draft Dan",
              comment: "half-written note",
            },
            { ...submitted("round-two", 15), reviewerName: "Blank Bea", comment: "   " },
          ]),
        ],
        ROUNDS,
      ),
    )[1];

    expect(record[COMMENTS]).toBe("");
    for (const leaked of ["Recused Rita", "personally", "Draft Dan", "half-written", "Blank Bea"]) {
      expect(record.join("|")).not.toContain(leaked);
    }
  });
});
