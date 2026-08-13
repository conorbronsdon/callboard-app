/**
 * Byte-exact fixtures for the Accelevents CSV pair.
 *
 * The expected strings below were written from research/accelevents-api.md
 * §7a/§7b — the column list, the enum values, the `DD/MM/YYYY` + `HH:MM` split
 * — NOT from running the generator and pasting its output. A fixture recorded
 * from the code it checks proves only that the code is deterministic.
 *
 * Both traps get a must-fire AND a must-not-fire case:
 * - the REGULAR_SESSION / BREAKOUT_SESSION enum split between the two channels;
 * - the blank-cell-DELETES rule on the speaker import.
 */
import { describe, expect, it } from "vitest";

import {
  ACCELEVENTS_SESSION_COLUMNS,
  ACCELEVENTS_SPEAKER_COLUMNS,
  apiFormatFor,
  accelApiDateTime,
  accelDate,
  accelTime,
  buildSessionsCsv,
  buildSpeakersCsv,
  csvCell,
  csvFormatFor,
  locationIds,
  shortDescription,
  splitName,
  stripHtml,
  UNASSIGNED_LOCATION_ID,
  type AccelSessionInput,
  type AccelSpeakerInput,
} from "./accelevents-csv";

const TZ = "America/Los_Angeles";
/** 2026-09-15 17:00 UTC = 10:00 PDT. */
const SEP15_1000_PDT = Date.UTC(2026, 8, 15, 17, 0);
const SEP15_1030_PDT = Date.UTC(2026, 8, 15, 17, 30);
const SEP15_0900_PDT = Date.UTC(2026, 8, 15, 16, 0);
const SEP15_0945_PDT = Date.UTC(2026, 8, 15, 16, 45);

const RINA: AccelSpeakerInput = {
  email: "rina@example.com",
  fullName: "Rina Okafor",
  firstName: null,
  lastName: null,
  pronouns: "she/her",
  title: "Staff Engineer",
  // A comma inside a cell — the case that has to be quoted.
  company: "Acme, Inc.",
  bio: "<p>Rina builds evals.</p>",
  links: { linkedin: "https://linkedin.com/in/rina" },
};

const TOMAS: AccelSpeakerInput = {
  email: "tomas@example.com",
  fullName: "Tomas",
  firstName: null,
  lastName: null,
  pronouns: null,
  title: null,
  company: null,
  bio: null,
  links: null,
};

const ROOMS = [{ id: "room-1" }, { id: "room-2" }];

const TALK: AccelSessionInput = {
  title: "Shipping agents",
  description: "<p>A talk about agents.</p>",
  formatName: "Talk",
  trackName: "Agents",
  roomId: "room-1",
  startsAt: SEP15_1000_PDT,
  endsAt: SEP15_1030_PDT,
  capacity: 800,
  tags: ["ai", "agents"],
  primaryEmails: [],
  secondaryEmails: ["rina@example.com", "tomas@example.com"],
};

const KEYNOTE: AccelSessionInput = {
  title: "Opening keynote",
  description: null,
  formatName: "Keynote",
  trackName: null,
  roomId: null,
  startsAt: SEP15_0900_PDT,
  endsAt: SEP15_0945_PDT,
  capacity: null,
  tags: [],
  primaryEmails: ["mc@example.com"],
  secondaryEmails: [],
};

const UNSCHEDULED: AccelSessionInput = {
  ...TALK,
  title: "Unscheduled workshop",
  formatName: "Workshop",
  startsAt: null,
  endsAt: null,
};

const CRLF = "\r\n";

describe("column headers match the documented templates exactly", () => {
  it("session template order (§7a)", () => {
    expect(ACCELEVENTS_SESSION_COLUMNS.join(",")).toBe(
      "ID,Title,Format,Session Type,Start Date,Start Time,End Time,Full Detail,Capacity,Short Description,Tags,Tracks,Location ID,Primary Speaker,Secondary Speaker",
    );
  });

  it("speaker template order (§7b)", () => {
    expect(ACCELEVENTS_SPEAKER_COLUMNS.join(",")).toBe(
      "Speaker ID,First Name,Last Name,Email,Pronouns,Title,Company,Bio,LinkedIn URL,Instagram,Twitter,Primary Sessions,Secondary Sessions",
    );
  });

  it("every emitted row has exactly one cell per header", () => {
    const speakers = buildSpeakersCsv([RINA, TOMAS]);
    for (const line of speakers.csv.split(CRLF).filter(Boolean)) {
      // No quoted commas in a header count, so split on the top level only.
      expect(countCells(line)).toBe(ACCELEVENTS_SPEAKER_COLUMNS.length);
    }
    const sessions = buildSessionsCsv([TALK, KEYNOTE], {
      timeZone: TZ,
      locationIds: locationIds(ROOMS),
    });
    for (const line of sessions.csv.split(CRLF).filter(Boolean)) {
      expect(countCells(line)).toBe(ACCELEVENTS_SESSION_COLUMNS.length);
    }
  });
});

/** Count top-level cells, respecting RFC 4180 quoting. */
function countCells(line: string): number {
  let cells = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells += 1;
    }
  }
  return cells;
}

describe("speakers.csv is byte-exact", () => {
  const EXPECTED = [
    "Speaker ID,First Name,Last Name,Email,Pronouns,Title,Company,Bio,LinkedIn URL,Instagram,Twitter,Primary Sessions,Secondary Sessions",
    ',Rina,Okafor,rina@example.com,she/her,Staff Engineer,"Acme, Inc.",Rina builds evals.,https://linkedin.com/in/rina,,,,',
    ",Tomas,-,tomas@example.com,,,,,,,,,",
  ].join(CRLF) + CRLF;

  it("matches the expected bytes", () => {
    expect(buildSpeakersCsv([RINA, TOMAS]).csv).toBe(EXPECTED);
  });

  it("terminates lines with CRLF, not LF", () => {
    const csv = buildSpeakersCsv([RINA]).csv;
    expect(csv.includes(CRLF)).toBe(true);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("MUTATION CONTROL: changing one input byte changes the output", () => {
    // Proves the assertion above can go red — a byte-exact check that passes for
    // every input is not a check.
    const mutated = buildSpeakersCsv([{ ...RINA, company: "Acme Inc." }, TOMAS]).csv;
    expect(mutated).not.toBe(EXPECTED);
    expect(mutated).toContain(",Acme Inc.,");
  });
});

describe("sessions.csv is byte-exact", () => {
  const EXPECTED = [
    "ID,Title,Format,Session Type,Start Date,Start Time,End Time,Full Detail,Capacity,Short Description,Tags,Tracks,Location ID,Primary Speaker,Secondary Speaker",
    ',Shipping agents,REGULAR_SESSION,IN_PERSON,15/09/2026,10:00,10:30,A talk about agents.,800,A talk about agents.,"ai,agents",Agents,2,,"rina@example.com,tomas@example.com"',
    ",Opening keynote,MAIN_STAGE_SESSION,IN_PERSON,15/09/2026,09:00,09:45,,,,,,1,mc@example.com,",
  ].join(CRLF) + CRLF;

  it("matches the expected bytes", () => {
    const build = buildSessionsCsv([TALK, KEYNOTE], {
      timeZone: TZ,
      locationIds: locationIds(ROOMS),
    });
    expect(build.csv).toBe(EXPECTED);
    expect(build.rowCount).toBe(2);
  });

  it("MUTATION CONTROL: a different timezone moves the clock columns", () => {
    const build = buildSessionsCsv([TALK], {
      timeZone: "UTC",
      locationIds: locationIds(ROOMS),
    });
    expect(build.csv).not.toBe(EXPECTED);
    expect(build.csv).toContain(",15/09/2026,17:00,17:30,");
  });

  it("skips sessions with no time rather than emitting a row their importer rejects", () => {
    const build = buildSessionsCsv([TALK, UNSCHEDULED], {
      timeZone: TZ,
      locationIds: locationIds(ROOMS),
    });
    expect(build.rowCount).toBe(1);
    expect(build.skipped).toEqual([
      {
        title: "Unscheduled workshop",
        reason:
          "no scheduled time — Accelevents requires Start Date, Start Time and End Time",
      },
    ]);
    expect(build.csv).not.toContain("Unscheduled workshop");
  });

  it("reserves Location ID 1 for unassigned so it cannot collide with a real room", () => {
    const ids = locationIds(ROOMS);
    expect(ids.get("room-1")).toBe(2);
    expect(ids.get("room-2")).toBe(3);
    expect([...ids.values()]).not.toContain(UNASSIGNED_LOCATION_ID);
  });
});

describe("the format enum SPLIT between CSV and API", () => {
  it("MUST FIRE: an ordinary talk is REGULAR_SESSION in CSV and BREAKOUT_SESSION over the API", () => {
    expect(csvFormatFor("Talk")).toBe("REGULAR_SESSION");
    expect(apiFormatFor("Talk")).toBe("BREAKOUT_SESSION");
  });

  it("MUST FIRE: a keynote is MAIN_STAGE_SESSION in CSV and MAIN_STAGE over the API", () => {
    expect(csvFormatFor("Keynote")).toBe("MAIN_STAGE_SESSION");
    expect(apiFormatFor("Keynote")).toBe("MAIN_STAGE");
  });

  it("MUST NOT FIRE: the CSV mapper never emits an API-only value", () => {
    const apiOnly = ["BREAKOUT_SESSION", "MAIN_STAGE"];
    for (const name of [
      "Talk",
      "Lightning",
      "Panel",
      "Keynote",
      "Main Stage",
      "Workshop",
      "Meetup",
      "Break",
      "Expo",
      null,
      "",
      "Something nobody mapped",
    ]) {
      expect(apiOnly).not.toContain(csvFormatFor(name));
    }
  });

  it("MUST NOT FIRE: the API mapper never emits a CSV-only value", () => {
    const csvOnly = ["REGULAR_SESSION", "MAIN_STAGE_SESSION"];
    for (const name of ["Talk", "Lightning", "Keynote", "Plenary", null, "Workshop"]) {
      expect(csvOnly).not.toContain(apiFormatFor(name));
    }
  });

  it("MUST NOT FIRE: a generated sessions.csv contains no API enum value", () => {
    const csv = buildSessionsCsv([TALK, KEYNOTE], {
      timeZone: TZ,
      locationIds: locationIds(ROOMS),
    }).csv;
    expect(csv).not.toContain("BREAKOUT_SESSION");
    // `MAIN_STAGE` is a prefix of `MAIN_STAGE_SESSION`, so substring matching
    // would pass here for the wrong reason. Check the CELL, not the file.
    const formatCells = csv
      .split(CRLF)
      .filter(Boolean)
      .slice(1)
      .map((line) => line.split(",")[2]);
    expect(formatCells).toEqual(["REGULAR_SESSION", "MAIN_STAGE_SESSION"]);
    expect(formatCells).not.toContain("MAIN_STAGE");
  });

  it("shares no vocabulary between the two enums for the same input", () => {
    for (const name of ["Talk", "Keynote"]) {
      expect(csvFormatFor(name)).not.toBe(apiFormatFor(name));
    }
    // …and DOES agree where the two enums genuinely share a value.
    expect(csvFormatFor("Workshop")).toBe("WORKSHOP");
    expect(apiFormatFor("Workshop")).toBe("WORKSHOP");
  });
});

describe("the blank-cell-DELETES trap on speaker rows", () => {
  const BLANK_COLUMNS = [
    "Pronouns",
    "Title",
    "Company",
    "Bio",
    "LinkedIn URL",
    "Instagram",
    "Twitter",
  ];

  it("MUST FIRE: a sparse speaker is reported, column by column", () => {
    const build = buildSpeakersCsv([TOMAS]);
    expect(build.blankCells).toEqual([
      { email: "tomas@example.com", columns: BLANK_COLUMNS },
    ]);
  });

  it("MUST NOT FIRE: a speaker whose data we hold produces no blank warning for it", () => {
    const complete: AccelSpeakerInput = {
      ...RINA,
      links: {
        linkedin: "https://linkedin.com/in/rina",
        instagram: "https://instagram.com/rina",
        twitter: "https://x.com/rina",
      },
    };
    const build = buildSpeakersCsv([complete]);
    expect(build.blankCells).toEqual([]);

    // And prove it at the byte level: no cell we hold data for is emitted empty.
    const [, row] = build.csv.split(CRLF);
    const cells = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (const column of BLANK_COLUMNS) {
      const index = ACCELEVENTS_SPEAKER_COLUMNS.indexOf(
        column as (typeof ACCELEVENTS_SPEAKER_COLUMNS)[number],
      );
      expect(cells[index]).not.toBe("");
    }
  });

  it("MUST NOT FIRE: dropping a held value is caught — the warning appears when it does", () => {
    // The failure this guards against is the serializer silently losing a field.
    const withoutCompany = buildSpeakersCsv([{ ...RINA, company: null }]);
    expect(withoutCompany.blankCells[0].columns).toContain("Company");
    const withCompany = buildSpeakersCsv([RINA]);
    expect(withCompany.blankCells[0]?.columns ?? []).not.toContain("Company");
  });

  it("never warns on the session file — blank PRESERVES there, the opposite rule", () => {
    const build = buildSessionsCsv([KEYNOTE], {
      timeZone: TZ,
      locationIds: locationIds(ROOMS),
    });
    expect(build.blankCells).toEqual([]);
  });
});

describe("cell escaping and helpers", () => {
  it("quotes only what needs quoting, and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("formats the three DIFFERENT date shapes their two channels want", () => {
    expect(accelDate(SEP15_1000_PDT, TZ)).toBe("15/09/2026");
    expect(accelTime(SEP15_1000_PDT, TZ)).toBe("10:00");
    expect(accelApiDateTime(SEP15_1000_PDT, TZ)).toBe("2026/09/15 10:00");
  });

  it("renders midnight as 00:00, not 24:00", () => {
    const midnight = Date.UTC(2026, 8, 15, 7, 0); // 00:00 PDT
    expect(accelTime(midnight, TZ)).toBe("00:00");
    expect(accelDate(midnight, TZ)).toBe("15/09/2026");
  });

  it("splits names, and falls back rather than emitting a required field blank", () => {
    expect(splitName({ ...TOMAS, fullName: "Rina Okafor" })).toEqual({
      first: "Rina",
      last: "Okafor",
    });
    expect(splitName({ ...TOMAS, fullName: "Ada Lovelace King" })).toEqual({
      first: "Ada Lovelace",
      last: "King",
    });
    expect(splitName({ ...TOMAS, fullName: null })).toEqual({ first: "tomas", last: "-" });
    expect(splitName({ ...TOMAS, firstName: "Tom", lastName: "Berg" })).toEqual({
      first: "Tom",
      last: "Berg",
    });
  });

  it("strips markup and truncates the short description on a word boundary", () => {
    expect(stripHtml("<p>Hello &amp; <b>welcome</b></p>")).toBe("Hello & welcome");
    const long = `<p>${"word ".repeat(80)}</p>`;
    const short = shortDescription(long);
    expect(short.length).toBeLessThanOrEqual(200);
    expect(short.endsWith("…")).toBe(true);
    expect(shortDescription("<p>short</p>")).toBe("short");
    expect(shortDescription(null)).toBe("");
  });
});
