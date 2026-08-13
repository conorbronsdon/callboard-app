/**
 * ICS (RFC 5545) calendar lifecycle — REQUEST / CANCEL.
 *
 * DECISIONS.md #1 + #28: calendar invites ship as `METHOD:REQUEST` email
 * attachments, verified end-to-end against Gmail on 2026-08-08 (native RSVP
 * card, event auto-staged, conflict detection ran). This module builds the
 * bytes; `schedule-invite.ts` decides when.
 *
 * The three properties that make the lifecycle work, and what each is for:
 *
 *   UID       Stable for the life of a session. Regenerating an invite for the
 *             same session MUST produce the same UID or the client files a
 *             second event instead of updating the first.
 *   SEQUENCE  Monotonic per UID. A client ignores an update whose SEQUENCE is
 *             not greater than the one it already holds. We have no sequence
 *             column (schema is orchestrator-only), so it is DERIVED from the
 *             comm_log rows already written for that UID — see `nextSequence`.
 *   METHOD    REQUEST to create/update, CANCEL to withdraw. A CANCEL also
 *             carries STATUS:CANCELLED; some clients honour one, some the other.
 *
 * Pure — no bindings, no I/O, no Date.now(). Every timestamp is passed in, so
 * the tests can assert exact bytes.
 */

export type IcsMethod = "REQUEST" | "CANCEL";

export interface IcsAttendee {
  email: string;
  name?: string | null;
}

export interface IcsEventInput {
  uid: string;
  /** Monotonic per UID. See `nextSequence`. */
  sequence: number;
  method: IcsMethod;
  /** When this ICS was generated. */
  dtstamp: Date;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  organizer: { name: string; email: string };
  attendees: IcsAttendee[];
  prodId?: string;
}

export const ICS_PRODID = "-//Callboard//Callboard Speaker Ops 1.0//EN";

/**
 * The MIME type that flips Gmail from "here is a file" to "here is an invite".
 * The spike proved Resend passes these parameters through to the wire intact;
 * dropping `method=` is what degrades the render to an attachment chip.
 */
export function icsContentType(method: IcsMethod): string {
  return `text/calendar; charset="utf-8"; method=${method}`;
}

/**
 * Stable per session. Derived from the session id and the host so two callboard
 * deployments (preview and production) never collide in one calendar, while
 * repeated sends from the same deployment always address the same event.
 */
export function icsUid(sessionId: string, host: string): string {
  const domain = normalizeHost(host);
  return `callboard-${sessionId}@${domain}`;
}

function normalizeHost(host: string): string {
  const raw = (host ?? "").trim();
  if (!raw) return "callboard.invalid";
  // Accept a full origin as well as a bare host.
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostOnly = withoutScheme.split("/")[0].split(":")[0];
  return hostOnly || "callboard.invalid";
}

/**
 * The next SEQUENCE for a UID, given every sequence already emitted for it.
 * First send is 0; each later send is one past the highest seen — never a
 * count, because a gap in the log (a failed send that still wrote a row) must
 * not hand two different updates the same number.
 */
export function nextSequence(priorSequences: readonly (number | null | undefined)[]): number {
  let highest = -1;
  for (const value of priorSequences) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const floored = Math.floor(value);
    if (floored > highest) highest = floored;
  }
  return highest + 1;
}

/** RFC 5545 §3.3.5 UTC form: `20260809T170000Z`. */
export function formatIcsDate(value: Date): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** RFC 5545 §3.3.11 TEXT escaping. Order matters: backslash first. */
export function escapeIcsText(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * RFC 5545 §3.1 content-line folding: no line over 75 OCTETS, continuations
 * begin with a single space. Octets, not characters — a line of 75 emoji is
 * 300 bytes and some parsers truncate it.
 */
export function foldIcsLine(line: string, maxOctets = 75): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= maxOctets) return [line];

  const out: string[] = [];
  let current = "";
  let currentOctets = 0;
  let limit = maxOctets;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentOctets + size > limit) {
      out.push(current);
      current = "";
      currentOctets = 0;
      // Continuation lines spend one octet on the leading space.
      limit = maxOctets - 1;
    }
    current += char;
    currentOctets += size;
  }
  if (current) out.push(current);

  return out.map((part, index) => (index === 0 ? part : ` ${part}`));
}

function property(name: string, value: string): string {
  return `${name}:${value}`;
}

/**
 * The full VCALENDAR document, CRLF-terminated as the spec requires (LF-only
 * ICS is the classic "works in Gmail, invisible in Outlook" bug).
 */
export function buildIcs(input: IcsEventInput): string {
  const cancelling = input.method === "CANCEL";

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    property("PRODID", input.prodId ?? ICS_PRODID),
    "CALSCALE:GREGORIAN",
    property("METHOD", input.method),
    "BEGIN:VEVENT",
    property("UID", input.uid),
    property("DTSTAMP", formatIcsDate(input.dtstamp)),
    property("DTSTART", formatIcsDate(input.start)),
    property("DTEND", formatIcsDate(input.end)),
    property("SEQUENCE", String(Math.max(0, Math.floor(input.sequence)))),
    property("STATUS", cancelling ? "CANCELLED" : "CONFIRMED"),
    "TRANSP:OPAQUE",
    property("SUMMARY", escapeIcsText(input.summary)),
  ];

  if (input.description) {
    lines.push(property("DESCRIPTION", escapeIcsText(input.description)));
  }
  if (input.location) {
    lines.push(property("LOCATION", escapeIcsText(input.location)));
  }
  if (input.url) {
    lines.push(property("URL", input.url));
  }

  lines.push(
    property(
      `ORGANIZER;CN=${escapeIcsText(input.organizer.name)}`,
      `mailto:${input.organizer.email}`,
    ),
  );

  for (const attendee of input.attendees) {
    const cn = escapeIcsText(attendee.name?.trim() || attendee.email);
    lines.push(
      property(
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${cn}`,
        `mailto:${attendee.email}`,
      ),
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.flatMap((line) => foldIcsLine(line)).join("\r\n") + "\r\n";
}

/* --------------------------------------------------------------- parsing */

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * A minimal reader, exported so the tests assert against PARSED properties
 * rather than substrings of the blob. `expect(ics).toContain("SEQUENCE:1")`
 * passes on a document where the folding is broken and no client can read it;
 * unfolding first is what makes the assertion mean something.
 */
export function parseIcs(source: string): IcsProperty[] {
  const unfolded: string[] = [];
  for (const rawLine of source.split(/\r\n|\n|\r/)) {
    if (rawLine === "") continue;
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += rawLine.slice(1);
      continue;
    }
    unfolded.push(rawLine);
  }

  return unfolded.map((line) => {
    const colon = line.indexOf(":");
    const head = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);
    const [name, ...paramParts] = splitUnescaped(head, ";");
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return { name: name.toUpperCase(), params, value };
  });
}

/** Split on a delimiter that is not preceded by a backslash escape. */
function splitUnescaped(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      current += value[i] + value[i + 1];
      i += 1;
      continue;
    }
    if (value[i] === delimiter) {
      parts.push(current);
      current = "";
      continue;
    }
    current += value[i];
  }
  parts.push(current);
  return parts;
}

/** First value for a property name, or null. */
export function icsValue(properties: IcsProperty[], name: string): string | null {
  const hit = properties.find((property) => property.name === name.toUpperCase());
  return hit ? hit.value : null;
}

/** Every value for a property name (ATTENDEE repeats). */
export function icsValues(properties: IcsProperty[], name: string): string[] {
  return properties
    .filter((property) => property.name === name.toUpperCase())
    .map((property) => property.value);
}
