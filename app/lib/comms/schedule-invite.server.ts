/**
 * The agenda seam: one function the WS4 scheduling action calls after its write.
 *
 * Kept to a single entry point on purpose — WS4's action is not restructured,
 * it gains three call sites of two lines each. Everything that decides WHETHER
 * to send lives here and in the pure builder, so the agenda route keeps reading
 * as an agenda route.
 *
 * SEQUENCE has no column (schema is orchestrator-only), so it is derived from
 * the comm_log rows already written against this session's UID:
 *
 *     sequence = 1 + max(icsSequence over prior rows for this UID)
 *
 * which also decides invite-vs-update — a session nobody has been told about
 * gets an invite, one they already hold gets an update.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { commLog, people, rooms, sessionParticipants, sessions } from "~/db/schema";
import type { Event as EventRow } from "~/db/schema";
import { dayKeyOf, formatDayLabel, formatRangeLabel } from "~/lib/agenda/schedule";
import { appUrl } from "~/lib/env.server";
import { getMailer } from "~/lib/mail/mailer.server";
import type { Mailer } from "~/lib/mail/mailer";

import { withCommLog } from "./comm-log.server";
import { icsUid, nextSequence } from "./ics";
import {
  ACTION_TEMPLATE_KEY,
  buildScheduleInvite,
  type ScheduleAction,
} from "./schedule-invite";
import { currentSender } from "./sender.server";
import { loadTemplate } from "./templates.server";

/** What the agenda action did, in its own vocabulary. */
export type ScheduleChange = "scheduled" | "unscheduled" | "published" | "unpublished";

export interface ScheduleNotifyResult {
  action: ScheduleAction | null;
  sent: number;
  failed: number;
  /** Why nothing went out, when nothing did. Surfaced in job/route output. */
  skipped?: string;
  uid?: string;
  sequence?: number;
}

export interface ScheduleSnapshot {
  startsAt: Date | null;
  endsAt: Date | null;
  isPublic: boolean;
}

/**
 * Every `icsSequence` already logged for a UID.
 *
 * `json_extract` rather than fetching the event's whole comm log and filtering
 * in JS — SQLite's JSON1 is compiled in, and the alternative grows with the
 * number of emails the event has ever sent.
 */
export async function priorSequences(
  db: DB,
  eventId: string,
  uid: string,
): Promise<number[]> {
  const rows = await db
    .select({ sequence: sql<number | null>`json_extract(${commLog.meta}, '$.icsSequence')` })
    .from(commLog)
    .where(
      and(
        eq(commLog.eventId, eventId),
        sql`json_extract(${commLog.meta}, '$.icsUid') = ${uid}`,
      ),
    );
  return rows
    .map((row) => (typeof row.sequence === "number" ? row.sequence : null))
    .filter((value): value is number => value !== null);
}

/**
 * Notify a session's participants that its schedule changed.
 *
 * `before` is the session row as it was BEFORE the action's write — a cancel
 * needs the times the slot held, and by then the columns are null.
 */
export async function notifyScheduleChange(args: {
  request?: Request | null;
  event: EventRow;
  sessionId: string;
  change: ScheduleChange;
  before: ScheduleSnapshot;
  db?: DB;
  now?: Date;
  /** Injectable so tests can read the ICS bytes; defaults to `getMailer()`. */
  mailer?: Mailer;
}): Promise<ScheduleNotifyResult> {
  const db = args.db ?? getDb();
  const now = args.now ?? new Date();

  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, args.sessionId), eq(sessions.eventId, args.event.id)),
  });
  if (!session) return { action: null, sent: 0, failed: 0, skipped: "session not found" };

  const origin = appUrl(args.request ?? null);
  const uid = icsUid(session.id, origin);
  const prior = await priorSequences(db, args.event.id, uid);
  const alreadyInvited = prior.length > 0;

  const cancelling = args.change === "unscheduled" || args.change === "unpublished";

  // ── the guards ──────────────────────────────────────────────────────────
  if (cancelling) {
    // Only a session the speakers were actually told about can be cancelled,
    // and only if it was public when it held a time.
    if (!alreadyInvited) {
      return { action: null, sent: 0, failed: 0, skipped: "no invite was ever sent" };
    }
    if (!args.before.isPublic) {
      return { action: null, sent: 0, failed: 0, skipped: "session was not published" };
    }
  } else if (!session.isPublic) {
    return { action: null, sent: 0, failed: 0, skipped: "session is not published" };
  }

  const startsAt = cancelling ? args.before.startsAt : session.startsAt;
  const endsAt = cancelling ? args.before.endsAt : session.endsAt;

  const action: ScheduleAction = cancelling ? "cancel" : alreadyInvited ? "update" : "invite";
  const templateKey = ACTION_TEMPLATE_KEY[action];

  const [attendeeRows, room, template] = await Promise.all([
    db
      .select({
        personId: people.id,
        email: people.email,
        name: people.fullName,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(eq(sessionParticipants.sessionId, session.id)),
    session.roomId
      ? db.query.rooms.findFirst({ where: eq(rooms.id, session.roomId) })
      : Promise.resolve(undefined),
    loadTemplate(args.event.id, templateKey, db),
  ]);

  // De-duplicate: one person on a session twice (speaker + moderator) is one
  // human with one calendar.
  const seen = new Set<string>();
  const attendees = attendeeRows.filter((row) => {
    const key = row.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const timeLabel =
    startsAt && endsAt
      ? `${formatDayLabel(dayKeyOf(startsAt, args.event.timezone), args.event.timezone)} · ${formatRangeLabel(startsAt, endsAt, args.event.timezone)}`
      : "Time to be confirmed";

  const built = buildScheduleInvite({
    action,
    uid,
    sequence: nextSequence(prior),
    dtstamp: now,
    startsAt,
    endsAt,
    sessionTitle: session.title,
    sessionDescription: session.description,
    roomName: room?.name ?? null,
    eventName: args.event.name,
    eventLocation: args.event.location,
    timeLabel,
    portalUrl: `${origin}/portal`,
    scheduleUrl: `${origin}/e/${args.event.slug}/schedule`,
    sender: currentSender(),
    attendees,
    template,
    isPublished: cancelling ? args.before.isPublic : session.isPublic,
  });

  if (!built) {
    return {
      action: null,
      sent: 0,
      failed: 0,
      skipped: attendees.length === 0 ? "session has no participants" : "session has no times",
      uid,
    };
  }

  const base = args.mailer ?? getMailer();
  let sent = 0;
  let failed = 0;

  for (const message of built.messages) {
    const mailer = withCommLog(base, {
      eventId: args.event.id,
      personId: message.personId,
      templateId: template.id,
      templateKey,
      meta: {
        sessionId: session.id,
        icsUid: built.uid,
        icsSequence: built.sequence,
        icsMethod: built.method,
        hasIcs: true,
      },
      db,
      now,
    });
    const result = await mailer.send(message);
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { action, sent, failed, uid: built.uid, sequence: built.sequence };
}
