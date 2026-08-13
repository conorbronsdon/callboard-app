/**
 * Template persistence. A row in `email_templates` exists only once an admin
 * has edited that template — so:
 *
 *   load    = DB row if present, built-in default otherwise
 *   save    = upsert (the table's unique index is (event_id, key))
 *   reset   = DELETE the row, which is why "reset to default" needs no
 *             "original body" column the schema does not have
 *
 * A consequence worth stating: `scripts/seed.mjs` writes rows for the keys it
 * knows (`task_reminder`), so a seeded demo shows the seeded copy and "Reset to
 * default" swaps it for the built-in one. That is the intended behaviour, not a
 * conflict — the seed is demonstrating that editing works.
 */
import { and, eq } from "drizzle-orm";

import { getDb, type DB } from "~/db/client.server";
import { emailTemplates } from "~/db/schema";

import {
  DEFAULT_TEMPLATES,
  TEMPLATE_KEYS,
  defaultTemplate,
  type TemplateDefinition,
  type TemplateKey,
} from "./templates";

export interface StoredTemplate extends TemplateDefinition {
  /** Row id when an admin has customised it; null while it is the default. */
  id: string | null;
  isCustomized: boolean;
  updatedAt: number | null;
}

function toStored(
  key: TemplateKey,
  row?: typeof emailTemplates.$inferSelect | null,
): StoredTemplate {
  const base = defaultTemplate(key);
  if (!row) {
    return { ...base, id: null, isCustomized: false, updatedAt: null };
  }
  return {
    ...base,
    id: row.id,
    name: row.name || base.name,
    subject: row.subject || base.subject,
    body: row.body || base.body,
    isCustomized: true,
    updatedAt: new Date(row.updatedAt).getTime(),
  };
}

/** One template, default-backed. */
export async function loadTemplate(
  eventId: string,
  key: TemplateKey,
  db: DB = getDb(),
): Promise<StoredTemplate> {
  const row = await db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.eventId, eventId), eq(emailTemplates.key, key)),
  });
  return toStored(key, row ?? null);
}

/** Every known template, default-backed, in registry order. */
export async function loadTemplates(
  eventId: string,
  db: DB = getDb(),
): Promise<StoredTemplate[]> {
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.eventId, eventId));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return TEMPLATE_KEYS.map((key) => toStored(key, byKey.get(key) ?? null));
}

export async function saveTemplate(
  eventId: string,
  key: TemplateKey,
  values: { name?: string; subject: string; body: string },
  db: DB = getDb(),
): Promise<void> {
  const base = DEFAULT_TEMPLATES[key];
  const existing = await db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.eventId, eventId), eq(emailTemplates.key, key)),
  });

  const row = {
    name: values.name?.trim() || base.name,
    subject: values.subject.trim(),
    body: values.body.trim(),
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(emailTemplates).set(row).where(eq(emailTemplates.id, existing.id));
    return;
  }
  await db.insert(emailTemplates).values({ eventId, key, ...row });
}

/** Drop the override. Returns true when there was one to drop. */
export async function resetTemplate(
  eventId: string,
  key: TemplateKey,
  db: DB = getDb(),
): Promise<boolean> {
  const existing = await db.query.emailTemplates.findFirst({
    where: and(eq(emailTemplates.eventId, eventId), eq(emailTemplates.key, key)),
  });
  if (!existing) return false;
  await db.delete(emailTemplates).where(eq(emailTemplates.id, existing.id));
  return true;
}
