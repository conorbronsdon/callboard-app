import { and, inArray, isNull } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { people } from "~/db/schema";
import type { Mailer } from "~/lib/mail/mailer";

import {
  BULK_CUSTOM_TEMPLATE_KEY,
  MAX_BULK_RECIPIENTS,
  buildRecipientContext,
  type BulkEventContext,
  type BulkRecipient,
} from "./bulk";
import { nonThrowing, type BulkSendResult, type BulkSendRow } from "./bulk.server";
import { withCommLog } from "./comm-log.server";
import { renderEmail } from "./templates";

export async function sendOrgComm(options: {
  recipients: readonly string[];
  subject: string;
  body: string;
  event: BulkEventContext;
  eventId: string | null;
  origin: string;
  mailer: Mailer;
  db?: DB;
  now?: Date;
}): Promise<BulkSendResult> {
  const db = options.db ?? getDb();
  const recipientIds = [...new Set(options.recipients)];
  const rejected = (error: string): BulkSendResult => ({
    attempted: 0,
    sent: 0,
    failed: 0,
    rows: [],
    error,
  });

  if (recipientIds.length === 0) return rejected("Select at least one recipient before sending.");
  if (recipientIds.length > MAX_BULK_RECIPIENTS) {
    return rejected(`Select no more than ${MAX_BULK_RECIPIENTS} recipients at a time.`);
  }
  if (!options.subject.trim()) {
    return rejected("A subject is required \u2014 an empty one reads as spam.");
  }
  if (!options.body.trim()) return rejected("A body is required.");

  const recipientChunks = Array.from(
    { length: Math.ceil(recipientIds.length / 90) },
    (_, index) => recipientIds.slice(index * 90, index * 90 + 90),
  );
  const resolved = (
    await Promise.all(
      recipientChunks.map((chunk) =>
        db
          .select({
            personId: people.id,
            email: people.email,
            fullName: people.fullName,
            firstName: people.firstName,
          })
          .from(people)
          .where(and(inArray(people.id, chunk), isNull(people.mergedInto))),
      ),
    )
  ).flat();
  const byId = new Map<string, BulkRecipient>(
    resolved.map((row) => [
      row.personId,
      {
        ...row,
        eventRole: "contact",
        sessions: [],
        openTasks: [],
      },
    ]),
  );
  const invalidCount = recipientIds.filter((personId) => !byId.has(personId)).length;
  if (invalidCount > 0) {
    return rejected(`${invalidCount} selected contacts do not exist. Nothing was sent.`);
  }

  const bulkId = crypto.randomUUID();
  const now = options.now ?? new Date();
  const rows: BulkSendRow[] = [];
  for (const personId of recipientIds) {
    const recipient = byId.get(personId)!;
    const built = buildRecipientContext(recipient, options.event, {
      origin: options.origin,
      now,
    });
    const rendered = renderEmail(
      {
        key: BULK_CUSTOM_TEMPLATE_KEY as never,
        subject: options.subject,
        body: options.body,
      },
      built.context,
    );
    const mailer = withCommLog(nonThrowing(options.mailer), {
      eventId: options.eventId,
      personId,
      templateKey: BULK_CUSTOM_TEMPLATE_KEY,
      meta: { bulk: true, bulkId, audience: "org_contacts" },
      db,
      now,
    });
    const result = await mailer.send({
      to: recipient.email,
      subject: rendered.subject,
      text: rendered.text,
    });
    rows.push({
      email: recipient.email,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error ?? "unknown mailer failure" }),
    });
  }

  return {
    attempted: rows.length,
    sent: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    rows,
  };
}
