import { describe, expect, it } from "vitest";

import {
  parseSpeakerCsv,
  SPEAKER_IMPORT_MAX_BYTES,
  SPEAKER_IMPORT_MAX_ROWS,
} from "./import-csv";

describe("speaker CSV parsing", () => {
  it("parses BOM headers, CRLF records, quoted comma/newline, and doubled quotes", () => {
    const csv =
      '\uFEFFFull Name,Email Address,Job Title,Organisation,Biography\r\n' +
      '"Ada, Lovelace",ADA@example.com,Engineer,Analytical Engines,"First line\nSecond ""quoted"" line"\r\n';

    const result = parseSpeakerCsv(csv);

    expect(result.fatalError).toBeNull();
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        classification: "create",
        reason: null,
        fullName: "Ada, Lovelace",
        email: "ada@example.com",
        title: "Engineer",
        company: "Analytical Engines",
        bio: 'First line\nSecond "quoted" line',
      },
    ]);
  });

  it("classifies creates and both kinds of duplicates with reasons", () => {
    const result = parseSpeakerCsv(
      [
        "Name,Email",
        "Existing Person,existing@example.com",
        "New Person,new@example.com",
        "Repeated Person,new@example.com",
        "Another Person,another@example.com",
        "",
      ].join("\n"),
      new Set(["existing@example.com"]),
    );

    expect(result.counts).toEqual({ create: 2, duplicate: 2, error: 0 });
    expect(result.rows.map((row) => [row.classification, row.reason])).toEqual([
      ["skip-duplicate", "Already on this event's roster."],
      ["create", null],
      ["skip-duplicate", "Repeated email earlier in this file."],
      ["create", null],
    ]);
  });

  it("reports malformed rows with their 1-based CSV row numbers", () => {
    const result = parseSpeakerCsv(
      "First Name,Last Name,Email\nBad,Address,bad@\n,,named@example.com\nGood,Person,good@example.com\n",
    );

    expect(result.rows.map((row) => [row.rowNumber, row.classification, row.reason])).toEqual([
      [2, "error", "Email is malformed."],
      [3, "error", "Name is required."],
      [4, "create", null],
    ]);
    expect(result.counts.error).toBe(2);
  });

  /*
   * A spreadsheet export's blank lines must not refuse the whole file.
   *
   * MUST-FIRE and MUST-NOT-FIRE are both here on purpose: the skip has to be
   * narrow enough that a row naming a person with no email is STILL an error.
   * Without the second assertion this test would pass on a parser that silently
   * dropped every incomplete row, which is the failure the all-or-nothing
   * policy exists to prevent.
   */
  it("ignores wholly blank records without renumbering the rows after them", () => {
    const result = parseSpeakerCsv(
      "Name,Email\nAda Lovelace,ada@example.com\n,\nGrace Hopper,grace@example.com\n\n",
    );

    expect(result.fatalError).toBeNull();
    expect(result.counts).toEqual({ create: 2, duplicate: 0, error: 0 });
    // Grace is on physical line 4 and must still say 4, not 3.
    expect(result.rows.map((row) => [row.rowNumber, row.fullName])).toEqual([
      [2, "Ada Lovelace"],
      [4, "Grace Hopper"],
    ]);
  });

  it("still errors on a partially filled row that only looks blank", () => {
    const result = parseSpeakerCsv("Name,Email\nNamed But Emailless,\n");

    expect(result.counts.error).toBe(1);
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        classification: "error",
        reason: "Email is required.",
        fullName: "Named But Emailless",
        email: "",
        title: "",
        company: "",
        bio: "",
      },
    ]);
  });

  it("produces zero errors for a well-formed file", () => {
    const result = parseSpeakerCsv(
      "fullname,email,company\nGrace Hopper,grace@example.com,Navy\n",
    );

    expect(result.fatalError).toBeNull();
    expect(result.counts.error).toBe(0);
    expect(result.rows[0].classification).toBe("create");
  });

  it("treats case and surrounding whitespace as the same existing email", () => {
    const result = parseSpeakerCsv(
      "Name,Email\nCase Match,  EXISTING@Example.COM  \n",
      ["existing@example.com"],
    );

    expect(result.rows[0]).toMatchObject({
      email: "existing@example.com",
      classification: "skip-duplicate",
      reason: "Already on this event's roster.",
    });
  });

  it("maps first/last names and accepted header aliases", () => {
    const result = parseSpeakerCsv(
      " first name , LAST NAME , EMAIL ADDRESS , ORGANIZATION , BIOGRAPHY\nKatherine,Johnson,katherine@example.com,NASA,Mathematician\n",
    );

    expect(result.rows[0]).toMatchObject({
      fullName: "Katherine Johnson",
      email: "katherine@example.com",
      company: "NASA",
      bio: "Mathematician",
      classification: "create",
    });
  });

  it("returns a fatal error above the row cap and accepts exactly the cap", () => {
    const row = (index: number) => `Person ${index},person-${index}@example.com`;
    const atCap = `Name,Email\n${Array.from({ length: SPEAKER_IMPORT_MAX_ROWS }, (_, index) => row(index)).join("\n")}`;
    const overCap = `${atCap}\n${row(SPEAKER_IMPORT_MAX_ROWS)}`;

    expect(parseSpeakerCsv(atCap).rows).toHaveLength(SPEAKER_IMPORT_MAX_ROWS);
    expect(parseSpeakerCsv(overCap).fatalError).toBe(
      `The CSV has more than ${SPEAKER_IMPORT_MAX_ROWS} data rows.`,
    );
  });

  it("returns a fatal error above 1 MB and accepts a small file", () => {
    expect(parseSpeakerCsv("Name,Email\nSmall,small@example.com\n").fatalError).toBeNull();
    expect(parseSpeakerCsv("x".repeat(SPEAKER_IMPORT_MAX_BYTES + 1)).fatalError).toBe(
      "The CSV is larger than 1 MB.",
    );
  });

  it("rejects a missing email header and an unterminated quote", () => {
    expect(parseSpeakerCsv("Name,Company\nNo Email,Acme\n").fatalError).toContain(
      "Email",
    );
    expect(parseSpeakerCsv('Name,Email\n"Never closes,person@example.com').fatalError).toBe(
      "The CSV contains an unterminated quoted field.",
    );
  });
});
