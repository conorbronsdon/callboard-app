/** Pure RFC 4180 speaker import planning. The route executes the returned plan. */

export const SPEAKER_IMPORT_MAX_BYTES = 1024 * 1024;
export const SPEAKER_IMPORT_MAX_ROWS = 500;

export type SpeakerImportClassification = "create" | "skip-duplicate" | "error";

export interface SpeakerImportRow {
  rowNumber: number;
  classification: SpeakerImportClassification;
  reason: string | null;
  fullName: string;
  email: string;
  title: string;
  company: string;
  bio: string;
}

export interface SpeakerImportPlan {
  rows: SpeakerImportRow[];
  counts: { create: number; duplicate: number; error: number };
  fatalError: string | null;
}

interface CsvRecords {
  records: string[][];
  error: string | null;
}

function emptyPlan(fatalError: string): SpeakerImportPlan {
  return {
    rows: [],
    counts: { create: 0, duplicate: 0, error: 0 },
    fatalError,
  };
}

/** Parse records while preserving commas, CR/LF, and doubled quotes inside quoted cells. */
function csvRecords(input: string): CsvRecords {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (character === "\r" && input[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (quoted) return { records: [], error: "The CSV contains an unterminated quoted field." };

  const endedWithNewline = /(?:\r\n|\r|\n)$/.test(input);
  if (!endedWithNewline || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return { records, error: null };
}

function normalizedHeader(value: string, first: boolean): string {
  const withoutBom = first ? value.replace(/^\uFEFF/, "") : value;
  return withoutBom.trim().toLowerCase();
}

function columnOf(headers: readonly string[], names: readonly string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function cell(record: readonly string[], index: number): string {
  return index < 0 ? "" : (record[index] ?? "").trim();
}

/**
 * A record with nothing in it is whitespace, not data.
 *
 * Excel and Google Sheets both emit a trailing blank line on export, and a
 * hand-edited file picks up interior ones. Without this, `,,,` classifies as
 * "Email is required." — and because a single error row refuses the WHOLE
 * import (DECISIONS #55), one stray newline would reject an otherwise perfect
 * file with an error the organizer cannot see in their spreadsheet.
 *
 * Deliberately narrow: it skips only records where EVERY cell is blank. A row
 * that names a person but omits their email is still an error, because that one
 * is a real mistake the organizer has to fix.
 */
function isBlankRecord(record: readonly string[]): boolean {
  return record.every((value) => value.trim() === "");
}

export function isValidSpeakerEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function parseSpeakerCsv(
  input: string,
  alreadyOnRoster: ReadonlySet<string> | readonly string[] = [],
): SpeakerImportPlan {
  if (new TextEncoder().encode(input).byteLength > SPEAKER_IMPORT_MAX_BYTES) {
    return emptyPlan("The CSV is larger than 1 MB.");
  }

  const parsed = csvRecords(input);
  if (parsed.error) return emptyPlan(parsed.error);
  if (parsed.records.length === 0) return emptyPlan("The CSV is empty.");

  const headers = parsed.records[0].map((value, index) => normalizedHeader(value, index === 0));
  const fullNameColumn = columnOf(headers, ["name", "full name", "fullname"]);
  const firstNameColumn = columnOf(headers, ["first name"]);
  const lastNameColumn = columnOf(headers, ["last name"]);
  const emailColumn = columnOf(headers, ["email", "email address"]);
  const titleColumn = columnOf(headers, ["title", "job title"]);
  const companyColumn = columnOf(headers, ["company", "organization", "organisation"]);
  const bioColumn = columnOf(headers, ["bio", "biography"]);

  if (emailColumn < 0) return emptyPlan('The CSV needs an "Email" or "Email Address" column.');
  if (fullNameColumn < 0 && (firstNameColumn < 0 || lastNameColumn < 0)) {
    return emptyPlan(
      'The CSV needs a name column, or both "First Name" and "Last Name" columns.',
    );
  }

  const dataRecords = parsed.records.slice(1);
  if (dataRecords.length > SPEAKER_IMPORT_MAX_ROWS) {
    return emptyPlan(`The CSV has more than ${SPEAKER_IMPORT_MAX_ROWS} data rows.`);
  }

  const existing = new Set(
    [...alreadyOnRoster].map((email) => email.trim().toLowerCase()),
  );
  const seen = new Set<string>();
  const rows: SpeakerImportRow[] = [];

  dataRecords.forEach((record, index) => {
    // Row numbering stays index-based so a skipped blank does not renumber the
    // rows after it — the number in the preview must match the organizer's file.
    if (isBlankRecord(record)) return;

    const fullName =
      fullNameColumn >= 0
        ? cell(record, fullNameColumn)
        : [cell(record, firstNameColumn), cell(record, lastNameColumn)]
            .filter(Boolean)
            .join(" ");
    const email = cell(record, emailColumn).toLowerCase();
    let classification: SpeakerImportClassification = "create";
    let reason: string | null = null;

    if (!email) {
      classification = "error";
      reason = "Email is required.";
    } else if (!isValidSpeakerEmail(email)) {
      classification = "error";
      reason = "Email is malformed.";
    } else if (!fullName) {
      classification = "error";
      reason = "Name is required.";
    } else if (existing.has(email)) {
      classification = "skip-duplicate";
      reason = "Already on this event's roster.";
    } else if (seen.has(email)) {
      classification = "skip-duplicate";
      reason = "Repeated email earlier in this file.";
    }

    if (classification === "create") seen.add(email);

    rows.push({
      rowNumber: index + 2,
      classification,
      reason,
      fullName,
      email,
      title: cell(record, titleColumn),
      company: cell(record, companyColumn),
      bio: cell(record, bioColumn),
    });
  });

  return {
    rows,
    counts: {
      create: rows.filter((row) => row.classification === "create").length,
      duplicate: rows.filter((row) => row.classification === "skip-duplicate").length,
      error: rows.filter((row) => row.classification === "error").length,
    },
    fatalError: null,
  };
}

