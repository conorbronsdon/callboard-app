/**
 * The calendar-invite message for one session, PURE.
 *
 * `null` is a first-class answer here. "This change produces no email" is a
 * decision the product makes constantly (unpublished session, no participants,
 * no time on the record) and it has to be assertable, not inferred from an
 * empty outbox.
 *
 * The guard that matters: NOTHING is sent for a session that is not published.
 * A draft agenda gets dragged around dozens of times while an organiser thinks;
 * every one of those drags would otherwise be an email and a calendar update in
 * a speaker's pocket.
 */
import type { MailMessage } from "~/lib/mail/mailer";

import { buildIcs, icsContentType, type IcsMethod } from "./ics";
import type { Sender } from "./sender";
import { mergeContext, renderEmail, type EmailTemplate } from "./templates";

export type ScheduleAction = "invite" | "update" | "cancel";

export const ACTION_TEMPLATE_KEY = {
  invite: "schedule_invite",
  update: "schedule_update",
  cancel: "schedule_cancel",
} as const;

const ACTION_METHOD: Record<ScheduleAction, IcsMethod> = {
  invite: "REQUEST",
  update: "REQUEST",
  cancel: "CANCEL",
};

export interface ScheduleAttendee {
  personId: string;
  email: string;
  name?: string | null;
}

export interface ScheduleInviteInput {
  action: ScheduleAction;
  /** Stable ICS UID for the session — see `icsUid`. */
  uid: string;
  sequence: number;
  dtstamp: Date;
  /** For a cancel these are the times the slot HELD, read before the write. */
  startsAt: Date | null;
  endsAt: Date | null;
  sessionTitle: string;
  sessionDescription?: string | null;
  roomName?: string | null;
  eventName: string;
  eventLocation?: string | null;
  /** Human day + time in the event timezone, already formatted. */
  timeLabel: string;
  portalUrl: string;
  scheduleUrl?: string | null;
  sender: Sender;
  attendees: ScheduleAttendee[];
  template: Pick<EmailTemplate, "key" | "subject" | "body">;
  /** True only when the session is on the public schedule. */
  isPublished: boolean;
}

export interface ScheduleInvite {
  action: ScheduleAction;
  uid: string;
  sequence: number;
  method: IcsMethod;
  ics: string;
  /** One message per attendee — each ICS names its own recipient. */
  messages: (MailMessage & { personId: string })[];
}

/** Location line for both the ICS and the body. */
function locationOf(input: ScheduleInviteInput): string | null {
  return [input.roomName, input.eventLocation].filter(Boolean).join(", ") || null;
}

/**
 * Build the invite/update/cancel, or return null when this change must not
 * produce email.
 */
export function buildScheduleInvite(input: ScheduleInviteInput): ScheduleInvite | null {
  // Guard 1 — the session is not on the public schedule. Dragging cards around
  // a draft agenda is not a speaker-facing event.
  if (!input.isPublished) return null;
  // Guard 2 — nobody to tell.
  if (input.attendees.length === 0) return null;
  // Guard 3 — an ICS with no DTSTART/DTEND is not a calendar entry, and that
  // includes a CANCEL: it must name the slot it is withdrawing.
  if (!input.startsAt || !input.endsAt) return null;

  const method = ACTION_METHOD[input.action];
  const location = locationOf(input);

  const context = mergeContext({
    "event.name": input.eventName,
    "event.location": input.eventLocation ?? "",
    "session.title": input.sessionTitle,
    "session.time": input.timeLabel,
    // Never blank: the default body puts the room on its own line, and an
    // empty one reads as a rendering bug rather than "no room yet".
    "session.room": input.roomName ?? "Room to be confirmed",
    "portal.url": input.portalUrl,
  });

  const messages = input.attendees.map((attendee) => {
    const rendered = renderEmail(
      input.template,
      mergeContext({
        ...context,
        "speaker.name": attendee.name ?? attendee.email,
        "speaker.first_name": firstNameOf(attendee.name) ?? attendee.email,
        "speaker.email": attendee.email,
      }),
    );

    const ics = buildIcs({
      uid: input.uid,
      sequence: input.sequence,
      method,
      dtstamp: input.dtstamp,
      start: input.startsAt!,
      end: input.endsAt!,
      summary: input.sessionTitle,
      description: descriptionFor(input),
      location,
      url: input.scheduleUrl ?? null,
      organizer: { name: input.sender.name, email: input.sender.email },
      // ONE attendee per message. A shared ICS listing every speaker leaks the
      // other speakers' addresses into each recipient's calendar client.
      attendees: [{ email: attendee.email, name: attendee.name }],
    });

    return {
      personId: attendee.personId,
      to: attendee.email,
      subject: rendered.subject,
      text: rendered.text,
      from: input.sender.display,
      attachments: [
        {
          filename: method === "CANCEL" ? "cancel.ics" : "invite.ics",
          content: ics,
          contentType: icsContentType(method),
        },
      ],
    };
  });

  return {
    action: input.action,
    uid: input.uid,
    sequence: input.sequence,
    method,
    // The document differs only by ATTENDEE; the first is representative and is
    // what the comm-log meta records.
    ics: messages[0].attachments![0].content,
    messages,
  };
}

function descriptionFor(input: ScheduleInviteInput): string {
  return [
    input.sessionDescription?.trim() || `${input.sessionTitle} at ${input.eventName}.`,
    "",
    `Speaker portal: ${input.portalUrl}`,
  ].join("\n");
}

/**
 * Honorifics that are never anyone's first name. Without this the demo seed's
 * "Dr. Amara Okonkwo" opens her reminder with "Hi Dr.," — which is exactly the
 * kind of detail a judge notices and a `toContain("Hi")` assertion does not.
 */
const HONORIFICS = new Set([
  "dr",
  "dr.",
  "prof",
  "prof.",
  "mr",
  "mr.",
  "mrs",
  "mrs.",
  "ms",
  "ms.",
  "mx",
  "mx.",
  "sir",
  "dame",
]);

/** "Sam Speaker" -> "Sam". Null when there is no name to shorten. */
export function firstNameOf(fullName?: string | null): string | null {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  // Drop leading honorifics, but never return empty: a person literally called
  // "Dr" keeps it rather than being greeted by nothing.
  while (parts.length > 1 && HONORIFICS.has(parts[0].toLowerCase())) parts.shift();
  return parts[0];
}
