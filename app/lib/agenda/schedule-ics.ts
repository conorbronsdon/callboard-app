/**
 * Multi-session public calendar builder.
 *
 * Programme rows without an explicit end use a 60-minute end so calendar
 * clients receive a useful duration instead of an open-ended event. Pure: all
 * clock values are supplied by the caller.
 */
import {
  ICS_PRODID,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
} from "~/lib/comms/ics";

export interface ScheduleIcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
}

export const DEFAULT_PUBLIC_SESSION_MINUTES = 60;

export function scheduleEndDate(start: Date, end: Date | null): Date {
  return end ?? new Date(start.getTime() + DEFAULT_PUBLIC_SESSION_MINUTES * 60_000);
}

export function buildScheduleIcs(input: {
  prodId?: string;
  calendarName: string;
  dtstamp: Date;
  events: readonly ScheduleIcsEvent[];
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${input.prodId ?? ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
  ];

  for (const event of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${formatIcsDate(input.dtstamp)}`,
      `DTSTART:${formatIcsDate(event.start)}`,
      `DTEND:${formatIcsDate(event.end)}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.flatMap((line) => foldIcsLine(line)).join("\r\n") + "\r\n";
}
