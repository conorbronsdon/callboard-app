/** Decision email fan-out after an accept/decline queue commit is durable. */
import { and, eq, inArray } from "drizzle-orm";

import { chunkForBind, getDb, type DB } from "~/db/client.server";
import { events, people, sessionParticipants, sessions } from "~/db/schema";
import { withCommLog } from "~/lib/comms/comm-log.server";
import { firstNameOf } from "~/lib/comms/schedule-invite";
import { mergeContext, renderEmail, type TemplateKey } from "~/lib/comms/templates";
import { loadTemplate } from "~/lib/comms/templates.server";
import { appUrl } from "~/lib/env.server";
import type { MailResult, Mailer } from "~/lib/mail/mailer";
import { getMailer } from "~/lib/mail/mailer.server";

type Decision = "accepted" | "declined";

interface DecisionRecipient {
  abstractId: string;
  composedIntoSessionId: string | null;
  friendlyId: string | null;
  title: string;
  personId: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  decision: Decision;
}

export interface NotifyDecisionsOptions {
  eventId: string;
  /** Abstract ids made durable by the commit that just completed. */
  accepted: readonly string[];
  /** Abstract ids made durable by the commit that just completed. */
  declined: readonly string[];
  origin?: string;
  mailer?: Mailer;
  db?: DB;
  now?: Date;
}

export interface NotifyDecisionsResult {
  notified: number;
  failed: number;
  informed: number;
}

/** Convert a thrown provider failure into MailResult so withCommLog can record it. */
function nonThrowing(mailer: Mailer): Mailer {
  return {
    name: mailer.name,
    // Forwarded, never asserted — see the same wrapper in comms/bulk.server.ts.
    observesDelivery: mailer.observesDelivery,
    async send(message): Promise<MailResult> {
      try {
        return await mailer.send(message);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * `{{speaker.first_name}}` means the same thing on every surface. The stored
 * column wins, then the name is SPLIT the way `reminders.server.ts` and the bulk
 * compose path split it — greeting a decision email "Hi Dev Patel," while the
 * reminder that follows it says "Hi Dev," is one merge field with two meanings.
 */
function speakerGreeting(row: DecisionRecipient): string {
  const firstName = row.firstName?.trim();
  if (firstName) return firstName;
  const derived = firstNameOf(row.fullName);
  if (derived) return derived;
  return row.email.split("@", 1)[0] || row.email;
}

function resolveOrigin(origin?: string): string | null {
  try {
    return new URL(origin?.trim() || appUrl(null)).origin;
  } catch {
    return null;
  }
}

async function loadRecipients(
  db: DB,
  eventId: string,
  accepted: readonly string[],
  declined: readonly string[],
): Promise<DecisionRecipient[]> {
  const decisionByAbstract = new Map<string, Decision>();
  for (const abstractId of declined) decisionByAbstract.set(abstractId, "declined");
  for (const abstractId of accepted) decisionByAbstract.set(abstractId, "accepted");
  const ids = [...decisionByAbstract.keys()];
  if (ids.length === 0) return [];

  const rows = (
    await Promise.all(
      chunkForBind(ids, 1).map((chunk) =>
        db
          .select({
            abstractId: sessions.id,
            composedIntoSessionId: sessions.composedIntoSessionId,
            friendlyId: sessions.friendlyId,
            title: sessions.title,
            personId: people.id,
            email: people.email,
            fullName: people.fullName,
            firstName: people.firstName,
          })
          .from(sessionParticipants)
          .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
          .innerJoin(people, eq(people.id, sessionParticipants.personId))
          .where(
            and(
              eq(sessions.eventId, eventId),
              eq(sessions.isAbstract, true),
              inArray(sessions.id, chunk),
            ),
          ),
      ),
    )
  ).flat();

  const seen = new Set<string>();
  const recipients: DecisionRecipient[] = [];
  for (const row of rows) {
    const key = `${row.abstractId}|${row.personId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({
      ...row,
      decision: decisionByAbstract.get(row.abstractId)!,
    });
  }
  return recipients;
}

/**
 * Notify every participant once per decided abstract. All errors are contained:
 * provider failures become failed comm-log rows, while setup/read failures are
 * reported through the returned count and never unwind the already-durable commit.
 */
export async function notifyDecisions(
  options: NotifyDecisionsOptions,
): Promise<NotifyDecisionsResult> {
  const result: NotifyDecisionsResult = { notified: 0, failed: 0, informed: 0 };
  try {
    const db = options.db ?? getDb();
    const now = options.now ?? new Date();
    const recipients = await loadRecipients(
      db,
      options.eventId,
      options.accepted,
      options.declined,
    );
    if (recipients.length === 0) return result;

    const event = await db.query.events.findFirst({ where: eq(events.id, options.eventId) });
    if (!event) {
      result.failed = recipients.length;
      return result;
    }

    const origin = resolveOrigin(options.origin);
    // Match the reminder job's configuration rule: notification runs that can
    // produce portal links require a real origin. Suppress the whole run rather
    // than sending only the decline half of one reviewed commit.
    if (!origin) {
      result.failed = recipients.length;
      return result;
    }
    const base = nonThrowing(options.mailer ?? getMailer());
    const acceptedOutcomes = new Map<
      string,
      { composedSessionId: string | null; allSucceeded: boolean }
    >();
    for (const recipient of recipients) {
      if (recipient.decision !== "accepted") continue;
      acceptedOutcomes.set(recipient.abstractId, {
        composedSessionId: recipient.composedIntoSessionId,
        allSucceeded: true,
      });
    }

    for (const decision of ["accepted", "declined"] as const) {
      const decisionRecipients = recipients.filter((row) => row.decision === decision);
      if (decisionRecipients.length === 0) continue;

      const templateKey: TemplateKey =
        decision === "accepted" ? "decision_accept" : "decision_decline";
      let template: Awaited<ReturnType<typeof loadTemplate>>;
      try {
        template = await loadTemplate(options.eventId, templateKey, db);
      } catch (error) {
        console.error(`[callboard] could not load ${templateKey}:`, error);
        result.failed += decisionRecipients.length;
        if (decision === "accepted") {
          for (const recipient of decisionRecipients) {
            const outcome = acceptedOutcomes.get(recipient.abstractId);
            if (outcome) outcome.allSucceeded = false;
          }
        }
        continue;
      }

      for (const recipient of decisionRecipients) {
        const rendered = renderEmail(
          template,
          mergeContext({
            "speaker.first_name": speakerGreeting(recipient),
            // The default decline copy carries no portal link and no full name,
            // but an admin's CUSTOMISED copy may reference either. Every field
            // that can resolve is supplied for both decisions, because a known
            // token with no value renders as empty text mid-sentence — the exact
            // silent hole the compose lane's fallbacks exist to close.
            "speaker.name": recipient.fullName?.trim() || recipient.email,
            "speaker.email": recipient.email,
            "event.name": event.name,
            "event.location": event.location?.trim() || event.name,
            "session.title": recipient.title,
            "session.id": recipient.friendlyId ?? recipient.abstractId,
            "portal.url": `${origin}/portal`,
          }),
        );
        const logged = withCommLog(base, {
          eventId: options.eventId,
          personId: recipient.personId,
          templateId: template.id,
          templateKey,
          // Facts only. The rendered body is deliberately NOT stored: no surface
          // reads it, every other send path in the product logs subject + status
          // alone, and a log that quietly accumulates message bodies is a new
          // data footprint nobody asked for.
          meta: { decision, sessionId: recipient.abstractId },
          db,
          now,
        });
        const sent = await logged.send({
          to: recipient.email,
          subject: rendered.subject,
          text: rendered.text,
        });
        if (sent.ok) result.notified += 1;
        else {
          result.failed += 1;
          if (recipient.decision === "accepted") {
            const outcome = acceptedOutcomes.get(recipient.abstractId);
            if (outcome) outcome.allSucceeded = false;
          }
        }
      }
    }

    const informedSessionIds = [
      ...new Set(
        [...acceptedOutcomes.values()].flatMap((outcome) =>
          outcome.allSucceeded && outcome.composedSessionId
            ? [outcome.composedSessionId]
            : [],
        ),
      ),
    ];
    for (const chunk of chunkForBind(informedSessionIds, 1)) {
      await db
        .update(sessions)
        .set({ speakerInformedAt: now })
        .where(inArray(sessions.id, chunk));
      result.informed += chunk.length;
    }
  } catch (error) {
    console.error("[callboard] decision notifications failed after queue commit:", error);
  }
  return result;
}
