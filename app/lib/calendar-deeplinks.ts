import { DEFAULT_PUBLIC_SESSION_MINUTES } from "~/lib/agenda/schedule-ics";

export interface CalendarDeeplinkInput {
  title: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date | null;
}

function compactUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Pure provider URLs for a public session; no provider SDK or client JS. */
export function buildCalendarDeeplinks(input: CalendarDeeplinkInput): {
  google: string;
  outlook: string;
} {
  const end =
    input.end ??
    new Date(input.start.getTime() + DEFAULT_PUBLIC_SESSION_MINUTES * 60_000);

  const google = new URL("https://calendar.google.com/calendar/render");
  google.searchParams.set("action", "TEMPLATE");
  google.searchParams.set("text", input.title);
  google.searchParams.set("dates", `${compactUtc(input.start)}/${compactUtc(end)}`);
  google.searchParams.set("details", input.description ?? "");
  google.searchParams.set("location", input.location ?? "");

  const outlook = new URL("https://outlook.live.com/calendar/0/action/compose");
  outlook.searchParams.set("subject", input.title);
  outlook.searchParams.set("startdt", input.start.toISOString());
  outlook.searchParams.set("enddt", end.toISOString());
  outlook.searchParams.set("body", input.description ?? "");
  outlook.searchParams.set("location", input.location ?? "");

  return { google: google.toString(), outlook: outlook.toString() };
}
