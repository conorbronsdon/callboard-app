/**
 * Accelevents CSV generation — the LINKED PAIR.
 *
 * Why CSV is the primary path and not their REST API (research/accelevents-api.md
 * §5, §8): their API has no way to attach a speaker to a session. 47 fields on
 * the session body, zero speaker fields; 20 on the speaker body, zero session
 * fields; every plausible join endpoint 404s. An API-only push produces an
 * orphaned speaker list and an unlinked agenda. The session CSV links by EMAIL,
 * so the two-file import needs zero Accelevents-side identifiers on a first run
 * — and it works on every paying tier, where their API is Enterprise-only.
 *
 * PURE — no bindings, no DB, no `Date.now()`. Every byte of output is a function
 * of its arguments, which is what makes byte-exact fixtures possible.
 *
 * Two traps this file exists to not fall into:
 *
 * 1. **The format enum SPLIT.** CSV says `REGULAR_SESSION` / `MAIN_STAGE_SESSION`;
 *    the API says `BREAKOUT_SESSION` / `MAIN_STAGE` for the same two things
 *    (§7a ⚠️). One shared serializer would silently emit the wrong vocabulary
 *    into one of the two channels, so there are two mappers and a test that
 *    proves the CSV one never emits an API value.
 * 2. **Blank cells DELETE on the speaker import** ("If you leave a column blank
 *    … the existing information will be deleted after the upload", §7b) — the
 *    exact OPPOSITE of the session import, where blank PRESERVES. So speaker
 *    rows are emitted complete, and every blank cell we cannot fill is reported
 *    back to the UI as a warning rather than shipped silently.
 */

/* --------------------------------------------------------------- columns */

/** Session template order, verbatim from research/accelevents-api.md §7a. */
export const ACCELEVENTS_SESSION_COLUMNS = [
  "ID",
  "Title",
  "Format",
  "Session Type",
  "Start Date",
  "Start Time",
  "End Time",
  "Full Detail",
  "Capacity",
  "Short Description",
  "Tags",
  "Tracks",
  "Location ID",
  "Primary Speaker",
  "Secondary Speaker",
] as const;

/** Speaker template order, verbatim from §7b. */
export const ACCELEVENTS_SPEAKER_COLUMNS = [
  "Speaker ID",
  "First Name",
  "Last Name",
  "Email",
  "Pronouns",
  "Title",
  "Company",
  "Bio",
  "LinkedIn URL",
  "Instagram",
  "Twitter",
  "Primary Sessions",
  "Secondary Sessions",
] as const;

/** Columns whose blankness DELETES data on re-import. `Speaker ID` is exempt. */
export const SPEAKER_BLANK_DELETES_COLUMNS = [
  "Pronouns",
  "Title",
  "Company",
  "Bio",
  "LinkedIn URL",
  "Instagram",
  "Twitter",
] as const;

/* ----------------------------------------------------------- enum split */

export const ACCELEVENTS_CSV_FORMATS = [
  "REGULAR_SESSION",
  "MAIN_STAGE_SESSION",
  "WORKSHOP",
  "MEET_UP",
  "BREAK",
  "OTHER",
  "EXPO",
] as const;
export type AccelCsvFormat = (typeof ACCELEVENTS_CSV_FORMATS)[number];

export const ACCELEVENTS_API_FORMATS = [
  "MAIN_STAGE",
  "BREAKOUT_SESSION",
  "MEET_UP",
  "WORKSHOP",
  "EXPO",
  "BREAK",
  "OTHER",
] as const;
export type AccelApiFormat = (typeof ACCELEVENTS_API_FORMATS)[number];

export const ACCELEVENTS_SESSION_TYPES = ["VIRTUAL", "IN_PERSON", "HYBRID"] as const;
export type AccelSessionType = (typeof ACCELEVENTS_SESSION_TYPES)[number];

/**
 * Our per-event format names are free text ("Talk", "Lightning", "Keynote"), so
 * the mapping is by keyword with a default. The DEFAULT is the interesting
 * case: an ordinary talk is `REGULAR_SESSION` in CSV and `BREAKOUT_SESSION` over
 * the API. Same input, two vocabularies.
 */
type FormatBucket = "main_stage" | "workshop" | "meet_up" | "break" | "expo" | "regular";

function bucketFor(formatName: string | null | undefined): FormatBucket {
  const name = (formatName ?? "").toLowerCase();
  if (!name) return "regular";
  if (/keynote|main ?stage|plenary|opening|closing/.test(name)) return "main_stage";
  if (/workshop|tutorial|lab|hands-?on/.test(name)) return "workshop";
  if (/meet ?-?up|birds of a feather|bof|roundtable|networking/.test(name)) return "meet_up";
  if (/break|lunch|coffee|recess|intermission/.test(name)) return "break";
  if (/expo|booth|exhibit|demo hall/.test(name)) return "expo";
  return "regular";
}

const CSV_BY_BUCKET: Record<FormatBucket, AccelCsvFormat> = {
  main_stage: "MAIN_STAGE_SESSION",
  workshop: "WORKSHOP",
  meet_up: "MEET_UP",
  break: "BREAK",
  expo: "EXPO",
  regular: "REGULAR_SESSION",
};

const API_BY_BUCKET: Record<FormatBucket, AccelApiFormat> = {
  main_stage: "MAIN_STAGE",
  workshop: "WORKSHOP",
  meet_up: "MEET_UP",
  break: "BREAK",
  expo: "EXPO",
  regular: "BREAKOUT_SESSION",
};

/** CSV vocabulary. NEVER returns an API-only value like `BREAKOUT_SESSION`. */
export function csvFormatFor(formatName: string | null | undefined): AccelCsvFormat {
  return CSV_BY_BUCKET[bucketFor(formatName)];
}

/** API vocabulary. NEVER returns a CSV-only value like `REGULAR_SESSION`. */
export function apiFormatFor(formatName: string | null | undefined): AccelApiFormat {
  return API_BY_BUCKET[bucketFor(formatName)];
}

/* ------------------------------------------------------------ csv bytes */

/** RFC 4180: CRLF terminators, so Excel and their importer both behave. */
export const CSV_EOL = "\r\n";

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function csvDocument(header: readonly string[], rows: readonly unknown[][]): string {
  // Trailing EOL on the last row: some importers drop a final unterminated line.
  return [csvRow(header), ...rows.map(csvRow)].join(CSV_EOL) + CSV_EOL;
}

/* --------------------------------------------------------- date + text */

interface ZonedParts {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
}

function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(epochMs))) {
    parts[part.type] = part.value;
  }
  return {
    day: parts.day,
    month: parts.month,
    year: parts.year,
    // Some ICU builds render midnight as "24" under the h23 cycle.
    hour: String(Number(parts.hour) % 24).padStart(2, "0"),
    minute: parts.minute,
  };
}

/** `DD/MM/YYYY` — day first, which is NOT the US order their API uses. */
export function accelDate(epochMs: number, timeZone: string): string {
  const { day, month, year } = zonedParts(epochMs, timeZone);
  return `${day}/${month}/${year}`;
}

/** 24-hour `HH:MM`. */
export function accelTime(epochMs: number, timeZone: string): string {
  const { hour, minute } = zonedParts(epochMs, timeZone);
  return `${hour}:${minute}`;
}

/** `yyyy/MM/dd HH:mm` — the API's single-field format (§4). Different again. */
export function accelApiDateTime(epochMs: number, timeZone: string): string {
  const { year, month, day, hour, minute } = zonedParts(epochMs, timeZone);
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const SHORT_DESCRIPTION_MAX = 200;

/** Plain-text summary, truncated on a word boundary with an ellipsis. */
export function shortDescription(html: string | null | undefined): string {
  const text = stripHtml(html);
  if (text.length <= SHORT_DESCRIPTION_MAX) return text;
  const cut = text.slice(0, SHORT_DESCRIPTION_MAX - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 40 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/* --------------------------------------------------------- location ids */

/**
 * `Location ID` is REQUIRED and numeric — "if not assigning locations you must
 * still put a numeric value in the cell" (§7a). We do not know Accelevents'
 * location ids, so we emit stable local ones: **1 is reserved for Unassigned**
 * and rooms start at 2, ordered exactly as the agenda orders them. Reserving 1
 * keeps a roomless session from colliding with a real room, which a naive
 * "default to 1" would do.
 */
export const UNASSIGNED_LOCATION_ID = 1;

export function locationIds(rooms: readonly { id: string }[]): Map<string, number> {
  const map = new Map<string, number>();
  rooms.forEach((room, index) => map.set(room.id, index + 2));
  return map;
}

/* ------------------------------------------------------------- speakers */

export interface AccelSpeakerInput {
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  pronouns: string | null;
  title: string | null;
  company: string | null;
  bio: string | null;
  links: Record<string, string> | null;
}

export interface BlankCellWarning {
  email: string;
  columns: string[];
}

export interface CsvBuild {
  filename: string;
  csv: string;
  rowCount: number;
  /** Rows we could not emit, with the reason — surfaced in the UI, never hidden. */
  skipped: { title: string; reason: string }[];
  /** Speaker rows with blank cells; blanks DELETE on re-import. */
  blankCells: BlankCellWarning[];
}

/** Split a `full_name` when first/last were never captured separately. */
export function splitName(input: AccelSpeakerInput): { first: string; last: string } {
  if (input.firstName || input.lastName) {
    return { first: input.firstName ?? "", last: input.lastName ?? "" };
  }
  const full = (input.fullName ?? "").trim();
  if (!full) {
    // Their import requires First Name and Last Name. The local part of the
    // email is a worse name than a real one and a much better one than blank.
    const local = input.email.split("@")[0] ?? "";
    return { first: local, last: "-" };
  }
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "-" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function linkOf(links: Record<string, string> | null, ...keys: string[]): string {
  if (!links) return "";
  for (const key of keys) {
    const found = Object.entries(links).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    );
    if (found?.[1]) return found[1];
  }
  return "";
}

export function buildSpeakersCsv(speakers: readonly AccelSpeakerInput[]): CsvBuild {
  const rows: unknown[][] = [];
  const blankCells: BlankCellWarning[] = [];

  for (const speaker of speakers) {
    const { first, last } = splitName(speaker);
    const cells = {
      "Speaker ID": "",
      "First Name": first,
      "Last Name": last,
      Email: speaker.email,
      Pronouns: speaker.pronouns ?? "",
      Title: speaker.title ?? "",
      Company: speaker.company ?? "",
      Bio: stripHtml(speaker.bio),
      "LinkedIn URL": linkOf(speaker.links, "linkedin", "linkedIn", "linkedin_url"),
      Instagram: linkOf(speaker.links, "instagram"),
      Twitter: linkOf(speaker.links, "twitter", "x"),
      // Left blank BY DESIGN: the session CSV links by email, so the pair needs
      // no Accelevents session ids on a first run (§8). Import speakers.csv
      // FIRST, then sessions.csv — re-importing speakers.csv afterwards would
      // blank these and drop the links this pair just made.
      "Primary Sessions": "",
      "Secondary Sessions": "",
    } satisfies Record<(typeof ACCELEVENTS_SPEAKER_COLUMNS)[number], string>;

    const blanks = SPEAKER_BLANK_DELETES_COLUMNS.filter((column) => cells[column] === "");
    if (blanks.length) blankCells.push({ email: speaker.email, columns: [...blanks] });

    rows.push(ACCELEVENTS_SPEAKER_COLUMNS.map((column) => cells[column]));
  }

  return {
    filename: "speakers.csv",
    csv: csvDocument(ACCELEVENTS_SPEAKER_COLUMNS, rows),
    rowCount: rows.length,
    skipped: [],
    blankCells,
  };
}

/* ------------------------------------------------------------- sessions */

export interface AccelSessionInput {
  title: string;
  description: string | null;
  formatName: string | null;
  trackName: string | null;
  roomId: string | null;
  startsAt: number | null;
  endsAt: number | null;
  capacity: number | null;
  tags: string[];
  /** Emails added as speaker-MODERATORS by their importer. */
  primaryEmails: string[];
  /** Emails added as ordinary (non-moderator) speakers. */
  secondaryEmails: string[];
}

export interface SessionsCsvOptions {
  timeZone: string;
  locationIds: Map<string, number>;
  sessionType?: AccelSessionType;
}

export function buildSessionsCsv(
  sessions: readonly AccelSessionInput[],
  options: SessionsCsvOptions,
): CsvBuild {
  const rows: unknown[][] = [];
  const skipped: { title: string; reason: string }[] = [];
  const sessionType = options.sessionType ?? "IN_PERSON";

  for (const session of sessions) {
    // "Values are required for Title, Format, Session Type, Start Date, Start
    // Time, End Time, and Location ID" (§7a). An unscheduled session cannot be
    // expressed, so it is reported rather than emitted as a row their importer
    // would reject halfway through the file.
    if (session.startsAt === null || session.endsAt === null) {
      skipped.push({
        title: session.title,
        reason: "no scheduled time — Accelevents requires Start Date, Start Time and End Time",
      });
      continue;
    }

    const cells = {
      // Blank ID = create. Populated = update. We never know their ids on a
      // first push, and blank PRESERVES on this importer (unlike speakers).
      ID: "",
      Title: session.title,
      Format: csvFormatFor(session.formatName),
      "Session Type": sessionType,
      "Start Date": accelDate(session.startsAt, options.timeZone),
      "Start Time": accelTime(session.startsAt, options.timeZone),
      "End Time": accelTime(session.endsAt, options.timeZone),
      "Full Detail": stripHtml(session.description),
      Capacity: session.capacity === null ? "" : String(session.capacity),
      "Short Description": shortDescription(session.description),
      Tags: session.tags.join(","),
      Tracks: session.trackName ?? "",
      "Location ID": String(
        (session.roomId ? options.locationIds.get(session.roomId) : undefined) ??
          UNASSIGNED_LOCATION_ID,
      ),
      "Primary Speaker": session.primaryEmails.join(","),
      "Secondary Speaker": session.secondaryEmails.join(","),
    } satisfies Record<(typeof ACCELEVENTS_SESSION_COLUMNS)[number], string>;

    rows.push(ACCELEVENTS_SESSION_COLUMNS.map((column) => cells[column]));
  }

  return {
    filename: "sessions.csv",
    csv: csvDocument(ACCELEVENTS_SESSION_COLUMNS, rows),
    rowCount: rows.length,
    skipped,
    blankCells: [],
  };
}
