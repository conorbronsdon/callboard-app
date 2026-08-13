/**
 * The form builder wizard (WS1a) — `/admin/forms/:formId/:step`.
 *
 * Sessionboard's builder is seven steps; this is six. Step 5, "Payments &
 * Fees", is the one screenshot the buyer annotated **NOT NEEDED** (DECISIONS.md #6),
 * so it is not built — and the stepper says so out loud, because a silent gap
 * reads as a bug (PLAN.md §1).
 *
 * Every step posts back to this module's `action`. There is no client-side form
 * state: each edit is a round-trip, which is slower to type against but cannot
 * lose a half-built rule, works with JS off, and keeps the builder honest about
 * what is actually persisted.
 */
import { and, eq } from "drizzle-orm";
import { Form, Link, data, redirect } from "react-router";

import {
  BUTTON_CLASS,
  Chip,
  CombinedLimitEditor,
  ConditionalRuleEditor,
  EmptyState,
  Field,
  FieldCard,
  FieldPalette,
  INPUT_CLASS,
  EligibleTracksEditor,
  RoutingEditor,
  Section,
  Stepper,
  type PaletteField,
  type WizardStep,
} from "~/components/form-builder";
import { getDb } from "~/db/client.server";
import {
  FIELD_TYPES,
  PARTICIPANT_ROLES,
  fields as fieldsTable,
  forms,
  tracks as tracksTable,
} from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import {
  type CombinedLimitRule,
  type ConditionalRule,
  type ConditionOperator,
  type EditDeadlineMode,
  type FieldScope,
  type FieldType,
  type FieldValidation,
  type FormFieldRef,
  type FormSchema,
  type FormSettings,
  type RoutingRule,
  type RuleAction,
  CONDITION_OPERATORS,
  RULE_ACTIONS,
  effectiveFormStatus,
  formSchemaOf,
  hydrateFieldRefs,
  parseEditDeadline,
  parseFormSchema,
  parseFormSettings,
  toFormDefinition,
  validationFromConstraints,
} from "~/lib/form-schema";
import { epochToZonedInput, formatInZone, zonedInputToEpoch } from "~/lib/zoned-time";
import type { Route } from "./+types/admin.forms.edit";

/* ------------------------------------------------------------------ steps */

const STEP_DEFS = [
  { slug: "setup", n: 1, title: "Submission setup", subtitle: "Submission type and participants" },
  { slug: "welcome", n: 2, title: "Welcome screen", subtitle: "Welcome message and terms" },
  { slug: "abstract", n: 3, title: "Abstract information", subtitle: "Questions, logic, routing" },
  {
    slug: "participants",
    n: 4,
    title: "Participant information",
    subtitle: "Roles, limits and fields",
  },
  { slug: "settings", n: 5, title: "Form settings", subtitle: "Deadlines, limits, success page" },
  { slug: "notifications", n: 6, title: "Notifications", subtitle: "Admin alerts and emails" },
] as const;

export const STEP_SLUGS = STEP_DEFS.map((step) => step.slug);
type StepSlug = (typeof STEP_DEFS)[number]["slug"];

const isStep = (value: string): value is StepSlug =>
  (STEP_SLUGS as readonly string[]).includes(value);

/* -------------------------------------------------------------- helpers */

/** The registry module a form scope draws its fields from. */
const moduleFor = (scope: FieldScope) => (scope === "participant" ? "contact" : "session");

const str = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();

const num = (formData: FormData, name: string): number | undefined => {
  const raw = str(formData, name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const lines = (formData: FormData, name: string): string[] =>
  str(formData, name)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Split a comma/whitespace-separated recipient list into addresses. */
const emails = (formData: FormData, name: string): string[] =>
  str(formData, name)
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("@"));

const asJson = (value: unknown) => value as unknown as Record<string, unknown>;

/* -------------------------------------------------------------- loader */

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);

  // Redirect rather than silently falling back to step 1: a URL bar that
  // disagrees with the page is how someone reports "the wizard is stuck".
  if (!isStep(params.step ?? "")) {
    throw redirect(`/admin/forms/${params.formId}/${STEP_SLUGS[0]}`);
  }
  const step = params.step as StepSlug;

  const db = getDb();
  const row = await db.query.forms.findFirst({
    where: and(
      eq(forms.id, params.formId),
      eq(forms.eventId, event.id),
      eq(forms.surface, "cfp"),
    ),
  });
  if (!row) throw new Response("Form not found.", { status: 404 });

  const [registry, trackRows] = await Promise.all([
    db.query.fields.findMany({ where: eq(fieldsTable.eventId, event.id) }),
    db.query.tracks.findMany({ where: eq(tracksTable.eventId, event.id) }),
  ]);

  // Field refs are REFERENCES, not copies: pull label/type/constraints back from
  // the registry so a library rename shows up on every form at once. Without
  // this a ref persisted as bare `{ fieldId, key }` renders a blank card.
  const stored = toFormDefinition(row);
  const def = { ...stored, fields: hydrateFieldRefs(stored.fields, registry) };

  const onForm = new Set(def.fields.map((field) => field.fieldId));
  const palette: Record<FieldScope, PaletteField[]> = {
    submission: [],
    participant: [],
  };
  for (const entry of registry) {
    if (entry.archivedAt) continue;
    const scope: FieldScope = entry.module === "session" ? "submission" : "participant";
    if (entry.module === "group") continue;
    palette[scope].push({
      id: entry.id,
      key: entry.key,
      label: entry.label,
      type: entry.type,
      onForm: onForm.has(entry.id),
    });
  }

  const submissionFields = def.fields.filter((f) => f.scope === "submission");
  const participantFields = def.fields.filter((f) => f.scope === "participant");

  const done: Record<StepSlug, boolean> = {
    setup: true,
    welcome: def.settings.welcome.title.trim().length > 0,
    abstract: submissionFields.length > 0,
    participants: !def.participants.collect || def.participants.roles.some((r) => r.enabled),
    settings: def.closesAt !== null,
    notifications:
      def.settings.notifications.confirmationEmail.enabled ||
      def.settings.notifications.notifyOnNew.length > 0,
  };

  return {
    step,
    steps: STEP_DEFS.map((s) => ({
      ...s,
      title: s.slug === "abstract" && def.target === "session" ? "Session information" : s.title,
      done: done[s.slug],
    })) satisfies WizardStep[],
    form: {
      id: def.id,
      name: def.name,
      target: def.target,
      status: def.status,
      allowMultipleDrafts: def.allowMultipleDrafts,
      submissionLimit: def.submissionLimit,
      closesAt: def.closesAt,
      closesAtInput: epochToZonedInput(def.closesAt, event.timezone),
      closesAtProse: formatInZone(def.closesAt, event.timezone),
    },
    schema: formSchemaOf(def),
    tracks: trackRows
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((track) => ({ id: track.id, name: track.name, color: track.color })),
    settings: def.settings,
    submissionFields,
    participantFields,
    palette,
    fieldTypes: FIELD_TYPES,
    participantRoleKeys: PARTICIPANT_ROLES,
    event: {
      slug: event.slug,
      timezone: event.timezone,
      submissionLimit: event.submissionLimit,
    },
    publicUrl: `${new URL(request.url).origin}/submit/${event.slug}/${def.id}`,
  };
}

/* -------------------------------------------------------------- action */

export async function action({ request, params }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();

  const row = await db.query.forms.findFirst({
    where: and(
      eq(forms.id, params.formId),
      eq(forms.eventId, event.id),
      eq(forms.surface, "cfp"),
    ),
  });
  if (!row) throw new Response("Form not found.", { status: 404 });

  const formData = await request.formData();
  const intent = str(formData, "intent");
  const step = str(formData, "step") || params.step || "setup";
  const schema = parseFormSchema(row.schema);
  const settings = parseFormSettings(row.settings);

  const fail = (message: string) => data({ error: message, ok: false }, { status: 400 });
  const saveSchema = async (next: FormSchema) => {
    await db
      .update(forms)
      .set({ schema: asJson(next), updatedAt: new Date() })
      .where(eq(forms.id, row.id));
    return redirect(`/admin/forms/${row.id}/${step}`);
  };
  const saveSettings = async (next: FormSettings) => {
    await db
      .update(forms)
      .set({ settings: asJson(next), updatedAt: new Date() })
      .where(eq(forms.id, row.id));
    return redirect(`/admin/forms/${row.id}/${step}`);
  };

  switch (intent) {
    /* ---------------------------------------------------------- step 1 */
    case "save-setup": {
      const name = str(formData, "name");
      if (!name) return fail("Give the form a name.");
      const target = str(formData, "target") === "session" ? "session" : "submission";
      await db
        .update(forms)
        .set({ name, target, updatedAt: new Date() })
        .where(eq(forms.id, row.id));
      return saveSchema({
        ...schema,
        participants: {
          ...schema.participants,
          collect: formData.get("collectParticipants") === "on",
        },
      });
    }

    case "set-status": {
      const status = str(formData, "status");
      if (status !== "open" && status !== "closed" && status !== "draft") {
        return fail("Unknown status.");
      }
      // Opening a form with nothing to answer would publish an empty page.
      if (status === "open" && !schema.fields.some((f) => f.scope === "submission")) {
        return fail("Add at least one question before opening the form.");
      }
      await db
        .update(forms)
        .set({ status, updatedAt: new Date() })
        .where(eq(forms.id, row.id));
      return redirect(`/admin/forms/${row.id}/${step}`);
    }

    /* ------------------------------------------------- steps 2 / 3 / 4 copy */
    case "save-copy": {
      const which = str(formData, "which");
      if (which !== "welcome" && which !== "abstract" && which !== "participant") {
        return fail("Unknown section.");
      }
      const heading = str(formData, "heading");
      if (heading.length > 15) {
        // The public stepper renders this label; 15 chars is Sessionboard's own
        // cap and it is what keeps the mobile stepper on one line.
        return fail("Page heading must be 15 characters or fewer.");
      }
      return saveSettings({
        ...settings,
        [which]: { title: str(formData, "title"), heading, body: str(formData, "body") },
      });
    }

    /* ------------------------------------------------------------ fields */
    case "add-field": {
      const scope: FieldScope = str(formData, "scope") === "participant" ? "participant" : "submission";
      const fieldId = str(formData, "fieldId");
      const entry = await db.query.fields.findFirst({
        where: and(eq(fieldsTable.id, fieldId), eq(fieldsTable.eventId, event.id)),
      });
      if (!entry) return fail("That field is not in this event's library.");
      if (schema.fields.some((f) => f.fieldId === entry.id)) {
        return fail("That field is already on this form.");
      }

      const maxOrder = schema.fields
        .filter((f) => f.scope === scope)
        .reduce((max, f) => Math.max(max, f.order), -1);

      const constraints = entry.constraints as Record<string, unknown> | null;
      const ref: FormFieldRef = {
        fieldId: entry.id,
        key: entry.key,
        type: entry.type,
        label: entry.label,
        helpText: entry.helpText ?? undefined,
        scope,
        order: maxOrder + 1,
        required: Boolean(constraints?.required) || entry.isLocked,
        locked: entry.isLocked,
        validation: validationFromConstraints(constraints),
      };
      return saveSchema({ ...schema, fields: [...schema.fields, ref] });
    }

    case "create-field": {
      const scope: FieldScope = str(formData, "scope") === "participant" ? "participant" : "submission";
      const key = str(formData, "key")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const label = str(formData, "label");
      const typeRaw = str(formData, "type");
      if (!key || !label) return fail("A new field needs a label and a key.");
      if (!(FIELD_TYPES as readonly string[]).includes(typeRaw)) return fail("Unknown field type.");
      const type = typeRaw as FieldType;
      const module = moduleFor(scope);

      const clash = await db.query.fields.findFirst({
        where: and(
          eq(fieldsTable.eventId, event.id),
          eq(fieldsTable.module, module),
          eq(fieldsTable.key, key),
        ),
      });
      if (clash) return fail(`The key "${key}" is already used by "${clash.label}".`);

      const constraints: Record<string, unknown> = {};
      const maxLength = num(formData, "maxLength");
      if (maxLength !== undefined) constraints.maxLength = maxLength;
      const options = lines(formData, "options");
      if (options.length) constraints.options = options;

      const id = crypto.randomUUID();
      const maxOrder = schema.fields
        .filter((f) => f.scope === scope)
        .reduce((max, f) => Math.max(max, f.order), -1);

      const next: FormSchema = {
        ...schema,
        fields: [
          ...schema.fields,
          {
            fieldId: id,
            key,
            type,
            label,
            scope,
            order: maxOrder + 1,
            required: false,
            validation: validationFromConstraints(constraints),
          },
        ],
      };

      // Both writes in one batch: D1 has no interactive transactions, and a
      // registry row without its form reference (or the reverse) is a dangling
      // half-edit the admin cannot see or fix.
      await db.batch([
        db.insert(fieldsTable).values({
          id,
          eventId: event.id,
          module,
          key,
          label,
          type,
          constraints: asJson(constraints),
          order: 999,
        }),
        db.update(forms).set({ schema: asJson(next), updatedAt: new Date() }).where(eq(forms.id, row.id)),
      ]);
      return redirect(`/admin/forms/${row.id}/${step}`);
    }

    case "remove-field": {
      const key = str(formData, "key");
      const target = schema.fields.find((f) => f.key === key);
      if (target?.locked) return fail("Locked fields are part of the product and cannot be removed.");
      return saveSchema({
        ...schema,
        fields: schema.fields.filter((f) => f.key !== key),
        // A rule pointing at a field nobody can answer is a rule that silently
        // never fires. Drop the references with the field.
        rules: schema.rules
          .map((rule) => ({
            ...rule,
            when: rule.when.filter((c) => c.fieldKey !== key),
            targetKeys: rule.targetKeys.filter((k) => k !== key),
          }))
          .filter((rule) => rule.when.length > 0 && rule.targetKeys.length > 0),
        combinedLimits: schema.combinedLimits
          .map((limit) => ({ ...limit, fieldKeys: limit.fieldKeys.filter((k) => k !== key) }))
          .filter((limit) => limit.fieldKeys.length > 1),
        routing: {
          ...schema.routing,
          rules: schema.routing.rules
            .map((rule) => ({ ...rule, when: rule.when.filter((c) => c.fieldKey !== key) }))
            .filter((rule) => rule.when.length > 0),
        },
      });
    }

    case "toggle-required": {
      const key = str(formData, "key");
      return saveSchema({
        ...schema,
        fields: schema.fields.map((f) =>
          f.key === key && !f.locked ? { ...f, required: !f.required } : f,
        ),
      });
    }

    case "update-field": {
      const key = str(formData, "key");
      const validation: FieldValidation = {};
      const minLength = num(formData, "minLength");
      const maxLength = num(formData, "maxLength");
      if (minLength !== undefined) validation.minLength = minLength;
      if (maxLength !== undefined) validation.maxLength = maxLength;
      const pattern = str(formData, "pattern");
      if (pattern) validation.pattern = pattern;
      const options = lines(formData, "options");
      if (options.length) validation.options = options;

      if (
        validation.minLength !== undefined &&
        validation.maxLength !== undefined &&
        validation.minLength > validation.maxLength
      ) {
        return fail("Minimum length cannot exceed maximum length.");
      }

      return saveSchema({
        ...schema,
        fields: schema.fields.map((f) =>
          f.key === key
            ? {
                ...f,
                label: str(formData, "label") || f.label,
                helpText: str(formData, "helpText") || undefined,
                validation: Object.keys(validation).length ? validation : undefined,
              }
            : f,
        ),
      });
    }

    case "move-field-up":
    case "move-field-down": {
      const key = str(formData, "key");
      const target = schema.fields.find((f) => f.key === key);
      if (!target) return fail("That field is not on this form.");

      const siblings = schema.fields
        .filter((f) => f.scope === target.scope)
        .sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((f) => f.key === key);
      const swapWith = intent === "move-field-up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= siblings.length) {
        return redirect(`/admin/forms/${row.id}/${step}`);
      }

      const reordered = siblings.slice();
      [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
      const orderByKey = new Map(reordered.map((f, i) => [f.key, i]));

      return saveSchema({
        ...schema,
        fields: schema.fields.map((f) =>
          f.scope === target.scope ? { ...f, order: orderByKey.get(f.key) ?? f.order } : f,
        ),
      });
    }

    /* ------------------------------------------------- conditional logic */
    case "add-rule": {
      const whenKey = str(formData, "whenKey");
      const targetKey = str(formData, "targetKey");
      const op = str(formData, "op") as ConditionOperator;
      const actionName = str(formData, "action") as RuleAction;
      const scope: FieldScope = str(formData, "scope") === "participant" ? "participant" : "submission";

      if (!(CONDITION_OPERATORS as readonly string[]).includes(op)) return fail("Unknown operator.");
      if (!(RULE_ACTIONS as readonly string[]).includes(actionName)) return fail("Unknown action.");
      if (!whenKey || !targetKey) return fail("Pick both a trigger field and a target field.");
      if (whenKey === targetKey) {
        // A field that hides itself based on its own answer is unreachable.
        return fail("A rule cannot target the same field it tests.");
      }

      const rule: ConditionalRule = {
        id: crypto.randomUUID(),
        match: "all",
        when: [{ fieldKey: whenKey, op, value: str(formData, "value") }],
        action: actionName,
        targetKeys: [targetKey],
        scope,
      };
      return saveSchema({ ...schema, rules: [...schema.rules, rule] });
    }

    case "remove-rule":
      return saveSchema({
        ...schema,
        rules: schema.rules.filter((rule) => rule.id !== str(formData, "ruleId")),
      });

    /* --------------------------------------------- cross-field limits */
    case "add-limit": {
      const fieldKeys = formData.getAll("fieldKeys").map(String).filter(Boolean);
      const maxChars = num(formData, "maxChars");
      const label = str(formData, "label");
      if (fieldKeys.length < 2) return fail("A combined limit needs at least two fields.");
      if (!maxChars || maxChars < 1) return fail("Set a combined character limit of 1 or more.");

      const scopes = new Set(
        fieldKeys.map((key) => schema.fields.find((f) => f.key === key)?.scope ?? "submission"),
      );
      if (scopes.size > 1) {
        // A rule spanning both scopes has no well-defined counter: submission
        // fields exist once, participant fields exist per person.
        return fail("Pick fields from one section — submission fields or participant fields.");
      }

      const limit: CombinedLimitRule = {
        id: crypto.randomUUID(),
        label: label || "Combined limit",
        fieldKeys,
        maxChars,
        scope: scopes.has("participant") ? "participant" : "submission",
      };
      return saveSchema({ ...schema, combinedLimits: [...schema.combinedLimits, limit] });
    }

    case "remove-limit":
      return saveSchema({
        ...schema,
        combinedLimits: schema.combinedLimits.filter((l) => l.id !== str(formData, "limitId")),
      });

    /* ------------------------------------------------------ routing */
    case "add-route": {
      const whenKey = str(formData, "whenKey");
      const trackId = str(formData, "trackId");
      const op = str(formData, "op") as ConditionOperator;
      if (!(CONDITION_OPERATORS as readonly string[]).includes(op)) return fail("Unknown operator.");
      if (!whenKey || !trackId) return fail("A routing rule needs a field and a track.");

      // Routing writes `sessions.track_id` directly, so the id has to be a real
      // track on THIS event — a dangling id would produce untraceable rows.
      const track = await db.query.tracks.findFirst({
        where: and(eq(tracksTable.id, trackId), eq(tracksTable.eventId, event.id)),
      });
      if (!track) return fail("That track does not belong to this event.");

      const maxOrder = schema.routing.rules.reduce((max, r) => Math.max(max, r.order), -1);
      const rule: RoutingRule = {
        id: crypto.randomUUID(),
        match: "all",
        when: [{ fieldKey: whenKey, op, value: str(formData, "value") }],
        trackId,
        order: maxOrder + 1,
      };
      return saveSchema({
        ...schema,
        routing: { ...schema.routing, rules: [...schema.routing.rules, rule] },
      });
    }

    case "remove-route":
      return saveSchema({
        ...schema,
        routing: {
          ...schema.routing,
          rules: schema.routing.rules.filter((r) => r.id !== str(formData, "routeId")),
        },
      });

    case "move-route-up": {
      const routeId = str(formData, "routeId");
      const ordered = schema.routing.rules.slice().sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((r) => r.id === routeId);
      if (index <= 0) return redirect(`/admin/forms/${row.id}/${step}`);
      [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
      return saveSchema({
        ...schema,
        routing: { ...schema.routing, rules: ordered.map((r, i) => ({ ...r, order: i })) },
      });
    }

    /* ------------------------------------------- eligible tracks (step 3) */
    case "save-eligible-tracks": {
      const posted = formData
        .getAll("eligibleTrackIds")
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      // Same rule as routing: an id that is not a track on THIS event would end
      // up on a public form and in an allowlist the submit path checks against,
      // so it is rejected here rather than silently dropped later.
      const owned = posted.length
        ? await db.query.tracks.findMany({ where: eq(tracksTable.eventId, event.id) })
        : [];
      const ownedIds = new Set(owned.map((track) => track.id));
      const unknown = posted.find((id) => !ownedIds.has(id));
      if (unknown) return fail("One of those tracks does not belong to this event.");

      return saveSchema({ ...schema, eligibleTrackIds: Array.from(new Set(posted)) });
    }

    case "set-default-track": {
      const trackId = str(formData, "defaultTrackId");
      if (trackId) {
        const track = await db.query.tracks.findFirst({
          where: and(eq(tracksTable.id, trackId), eq(tracksTable.eventId, event.id)),
        });
        if (!track) return fail("That track does not belong to this event.");
      }
      return saveSchema({
        ...schema,
        routing: { ...schema.routing, defaultTrackId: trackId || null },
      });
    }

    /* -------------------------------------------------------- step 4 roles */
    case "save-roles": {
      const roles = PARTICIPANT_ROLES.map((key) => {
        const enabled = formData.get(`role.${key}.enabled`) === "on";
        const min = num(formData, `role.${key}.min`) ?? 0;
        const max = num(formData, `role.${key}.max`);
        return {
          key,
          label: key === "co_speaker" ? "Co-speaker" : key[0].toUpperCase() + key.slice(1),
          enabled,
          min: Math.max(0, min),
          max: max === undefined ? null : max,
        };
      });

      for (const role of roles) {
        if (role.enabled && role.max !== null && role.max < role.min) {
          return fail(`${role.label}: maximum cannot be below minimum.`);
        }
      }

      const maxTotal = num(formData, "maxTotal") ?? null;
      const minRequired = roles
        .filter((r) => r.enabled)
        .reduce((total, role) => total + role.min, 0);
      if (maxTotal !== null && maxTotal < minRequired) {
        // Otherwise the public form is unsubmittable and says nothing useful.
        return fail(
          `The overall cap of ${maxTotal} is below the ${minRequired} participants the roles already require.`,
        );
      }

      const next: FormSchema = {
        ...schema,
        participants: {
          collect: schema.participants.collect,
          roles,
          maxTotal,
          minTotal: null,
        },
      };

      // `forms.schema.participants` is the source of truth. The three scalar
      // columns are a MIRROR for the speaker role so SQL-level lanes (WS2/WS7)
      // can filter without parsing JSON — written in the same statement batch so
      // they cannot drift apart.
      const speaker = roles.find((r) => r.key === "speaker");
      await db.batch([
        db
          .update(forms)
          .set({
            schema: asJson(next),
            minSpeakers: speaker?.enabled ? speaker.min : 0,
            maxSpeakers: speaker?.enabled ? speaker.max : null,
            maxParticipantsTotal: maxTotal,
            updatedAt: new Date(),
          })
          .where(eq(forms.id, row.id)),
      ]);
      return redirect(`/admin/forms/${row.id}/${step}`);
    }

    /* ------------------------------------------------------------ step 5 */
    case "save-settings": {
      const closesRaw = str(formData, "closesAt");
      const closesAt = closesRaw ? zonedInputToEpoch(closesRaw, event.timezone) : null;
      if (closesRaw && closesAt === null) return fail("That close date could not be read.");

      const submissionLimit = num(formData, "submissionLimit") ?? null;
      if (submissionLimit !== null && submissionLimit < 1) {
        return fail("A submission limit must be 1 or more. Leave it blank for no limit.");
      }

      /*
       * Post-submit edit deadline (issue #1). Read next to the close date it
       * configures, because the two are one policy: "when do submissions stop
       * arriving" and "when do corrections stop landing" are the questions an
       * operator answers in the same sitting, and splitting them across steps
       * is how they end up contradicting each other.
       */
      const modeRaw = str(formData, "editDeadlineMode");
      const mode: EditDeadlineMode =
        modeRaw === "custom" || modeRaw === "open" ? modeRaw : "cfp_close";
      const editRaw = str(formData, "editDeadlineAt");
      const editAt = editRaw ? zonedInputToEpoch(editRaw, event.timezone) : null;
      if (editRaw && editAt === null) return fail("That edit deadline could not be read.");
      if (mode === "custom" && editAt === null) {
        return fail("Pick a date for the edit deadline, or choose another option.");
      }

      await db
        .update(forms)
        .set({
          closesAt: closesAt === null ? null : new Date(closesAt),
          submissionLimit,
          allowMultipleDrafts: formData.get("allowMultipleDrafts") === "on",
          updatedAt: new Date(),
        })
        .where(eq(forms.id, row.id));

      return saveSettings({
        ...settings,
        autoRedirectToPortal: formData.get("autoRedirectToPortal") === "on",
        successMessage: str(formData, "successMessage"),
        editDeadline: parseEditDeadline({ mode, at: editAt }),
      });
    }

    /* ------------------------------------------------------------ step 6 */
    case "save-notifications":
      return saveSettings({
        ...settings,
        notifications: {
          confirmationEmail: {
            enabled: formData.get("confirmationEnabled") === "on",
            subject: str(formData, "confirmationSubject"),
            body: str(formData, "confirmationBody"),
          },
          reminderEmail: {
            enabled: formData.get("reminderEnabled") === "on",
            daysBeforeClose: num(formData, "reminderDays") ?? 3,
            subject: str(formData, "reminderSubject"),
            body: str(formData, "reminderBody"),
          },
          notifyOnNew: emails(formData, "notifyOnNew"),
          notifyOnUpdate: emails(formData, "notifyOnUpdate"),
        },
      });

    default:
      return fail(`Unknown action "${intent}".`);
  }
}

/* ----------------------------------------------------------- component */

export default function FormBuilder({ loaderData, actionData }: Route.ComponentProps) {
  const {
    step,
    steps,
    form,
    schema,
    settings,
    submissionFields,
    participantFields,
    palette,
    fieldTypes,
    participantRoleKeys,
    tracks,
    event,
    publicUrl,
  } = loaderData;

  const basePath = `/admin/forms/${form.id}`;
  const index = steps.findIndex((s) => s.slug === step);
  const previous = index > 0 ? steps[index - 1] : null;
  const next = index < steps.length - 1 ? steps[index + 1] : null;
  const displayStatus = effectiveFormStatus(form, Date.now());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to="/admin/forms" className="text-sm text-gray-500 underline">
          ← Back to forms
        </Link>
        <h2 className="text-lg font-semibold">{form.name}</h2>
        <span data-testid="form-status">
          <Chip tone={displayStatus === "open" ? "accent" : "neutral"}>{displayStatus}</Chip>
        </span>
        <Chip>{form.target === "submission" ? "Abstracts" : "Sessions"}</Chip>

        <div className="ml-auto flex items-center gap-2">
          <a href={publicUrl} className="text-sm underline">
            View form ↗
          </a>
          <Form method="post">
            <input type="hidden" name="step" value={step} />
            <input
              type="hidden"
              name="status"
              value={form.status === "open" ? "closed" : "open"}
            />
            <button name="intent" value="set-status" className={BUTTON_CLASS}>
              {form.status === "open" ? "Close form" : "Open form"}
            </button>
          </Form>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Public link:{" "}
        <code className="font-mono break-all select-all">{publicUrl}</code>
      </p>

      {actionData?.error ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {actionData.error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <Stepper steps={steps} basePath={basePath} />

        <div className="space-y-4">
          {step === "setup" ? <StepSetup form={form} schema={schema} /> : null}
          {step === "welcome" ? <StepCopyEditor which="welcome" copy={settings.welcome} /> : null}

          {step === "abstract" ? (
            <>
              <StepCopyEditor which="abstract" copy={settings.abstract} />
              <Section
                title={form.target === "submission" ? "Abstract questions" : "Session questions"}
                description="Fields are references to the event field library — editing one there updates every form at once."
              >
                {submissionFields.length ? (
                  <ul className="mb-3 space-y-2">
                    {submissionFields.map((field, i) => (
                      <FieldCard
                        key={field.key}
                        field={field}
                        index={i}
                        count={submissionFields.length}
                        step={step}
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="mb-3">
                    <EmptyState title="No questions yet">
                      Add a field from the library below, or create a new one.
                    </EmptyState>
                  </div>
                )}
                <FieldPalette
                  palette={palette.submission}
                  scope="submission"
                  step={step}
                  fieldTypes={fieldTypes}
                />
              </Section>

              <ConditionalRuleEditor
                rules={schema.rules}
                fields={submissionFields}
                step={step}
                scope="submission"
              />
              <EligibleTracksEditor
                eligibleTrackIds={schema.eligibleTrackIds}
                tracks={tracks}
                step={step}
                /*
                 * Deliberately a narrow test — key or label is literally
                 * "track". A looser match ("Which track?") would start guessing
                 * at intent, and copy that wrongly tells an organizer their form
                 * asks about tracks is the same class of bug as the sentence
                 * this replaces.
                 */
                hasSubmissionTrackQuestion={submissionFields.some(
                  (field) =>
                    field.key.trim().toLowerCase() === "track" ||
                    field.label.trim().toLowerCase() === "track",
                )}
              />
              <RoutingEditor
                rules={schema.routing.rules.slice().sort((a, b) => a.order - b.order)}
                defaultTrackId={schema.routing.defaultTrackId}
                fields={submissionFields}
                tracks={tracks}
                step={step}
              />
            </>
          ) : null}

          {step === "participants" ? (
            <>
              {schema.participants.collect ? null : (
                <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                  This form does not collect participants. Turn it on in{" "}
                  <Link className="underline" to={`${basePath}/setup`}>
                    Submission setup
                  </Link>{" "}
                  to use this step.
                </p>
              )}
              <StepCopyEditor which="participant" copy={settings.participant} />
              <StepRoles
                roles={schema.participants.roles}
                roleKeys={participantRoleKeys}
                maxTotal={schema.participants.maxTotal}
              />
              <Section
                title="Participant questions"
                description="Asked once per participant. Locked fields (name, email) are how a submission finds its speaker."
              >
                {participantFields.length ? (
                  <ul className="mb-3 space-y-2">
                    {participantFields.map((field, i) => (
                      <FieldCard
                        key={field.key}
                        field={field}
                        index={i}
                        count={participantFields.length}
                        step={step}
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="mb-3">
                    <EmptyState title="No participant questions yet">
                      Name and email are always collected. Add anything else here.
                    </EmptyState>
                  </div>
                )}
                <FieldPalette
                  palette={palette.participant}
                  scope="participant"
                  step={step}
                  fieldTypes={fieldTypes}
                />
              </Section>
              <ConditionalRuleEditor
                rules={schema.rules}
                fields={participantFields}
                step={step}
                scope="participant"
              />
            </>
          ) : null}

          {step === "settings" ? (
            <>
              <StepSettings form={form} settings={settings} event={event} />
              <CombinedLimitEditor
                limits={schema.combinedLimits}
                fields={schema.fields}
                step={step}
              />
            </>
          ) : null}

          {step === "notifications" ? (
            <StepNotifications settings={settings} closesAtProse={form.closesAtProse} />
          ) : null}

          <div className="flex items-center gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
            {previous ? (
              <Link to={`${basePath}/${previous.slug}`} className="text-sm underline">
                ← {previous.title}
              </Link>
            ) : null}
            {next ? (
              <Link to={`${basePath}/${next.slug}`} className="ml-auto text-sm underline">
                {next.title} →
              </Link>
            ) : (
              <span className="ml-auto text-sm text-gray-500">Last step</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ step views */

function StepSetup({
  form,
  schema,
}: {
  form: { name: string; target: string };
  schema: FormSchema;
}) {
  return (
    <Section
      title="What kind of submissions do you want to collect?"
      description="Choose what submitters send, and whether to collect participant details. You can change these later by editing this form."
    >
      <Form method="post" className="space-y-4">
        <input type="hidden" name="step" value="setup" />
        <Field label="Internal form name" hint="Shown in the admin list only.">
          <input name="name" defaultValue={form.name} className={INPUT_CLASS} required />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Collects</legend>
          {[
            {
              value: "submission",
              title: "Abstracts",
              body: "Collect abstract submissions for review before sessions are finalised.",
            },
            {
              value: "session",
              title: "Sessions",
              body: "Collect full session proposals — a guaranteed slot, straight onto the agenda.",
            },
          ].map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
            >
              <input
                type="radio"
                name="target"
                value={option.value}
                defaultChecked={form.target === option.value}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="block text-xs text-gray-500">{option.body}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
          <input
            type="checkbox"
            name="collectParticipants"
            defaultChecked={schema.participants.collect}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium">Participants</span>
            <span className="block text-xs text-gray-500">
              Include a step to collect speaker and participant contact information. Turning this
              off removes step 4.
            </span>
          </span>
        </label>

        <button name="intent" value="save-setup" className={BUTTON_CLASS}>
          Save
        </button>
      </Form>
    </Section>
  );
}

function StepCopyEditor({
  which,
  copy,
}: {
  which: "welcome" | "abstract" | "participant";
  copy: { title: string; heading: string; body: string };
}) {
  const titles = {
    welcome: "Welcome screen",
    abstract: "Section heading and instructions",
    participant: "Section heading and instructions",
  };
  return (
    <Section
      title={titles[which]}
      description={
        which === "welcome"
          ? "The first screen a submitter sees. The page heading is what the public stepper renders."
          : "Shown above the questions on this step."
      }
    >
      <Form method="post" className="space-y-3">
        <input type="hidden" name="step" value={which === "welcome" ? "welcome" : which === "abstract" ? "abstract" : "participants"} />
        <input type="hidden" name="which" value={which} />
        <Field label={which === "welcome" ? "External form title" : "Section title"}>
          <input name="title" defaultValue={copy.title} className={INPUT_CLASS} />
        </Field>
        <Field label="Page heading" hint="15 characters max — this is the label in the public stepper.">
          <input name="heading" defaultValue={copy.heading} maxLength={15} className={INPUT_CLASS} />
        </Field>
        <Field label="Message" hint="Shown to submitters above the questions.">
          <textarea name="body" rows={5} defaultValue={copy.body} className={INPUT_CLASS} />
        </Field>
        <button name="intent" value="save-copy" className={BUTTON_CLASS}>
          Save
        </button>
      </Form>
    </Section>
  );
}

function StepRoles({
  roles,
  roleKeys,
  maxTotal,
}: {
  roles: FormSchema["participants"]["roles"];
  roleKeys: readonly string[];
  maxTotal: number | null;
}) {
  const byKey = new Map(roles.map((role) => [role.key, role]));

  return (
    <Section
      title="Participant roles"
      description="Choose which roles submitters can add. Set minimum and maximum counts per role, and an overall limit across all roles."
    >
      <Form method="post" className="space-y-3">
        <input type="hidden" name="step" value="participants" />
        <ul className="space-y-2">
          {roleKeys.map((key) => {
            const role = byKey.get(key);
            return (
              <li
                key={key}
                className="flex flex-wrap items-center gap-3 rounded border border-gray-200 px-3 py-2 dark:border-gray-800"
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`role.${key}.enabled`}
                    defaultChecked={role?.enabled ?? false}
                  />
                  {role?.label ?? key}
                </label>
                <label className="ml-auto flex items-center gap-1 text-xs text-gray-500">
                  Min
                  <input
                    type="number"
                    min={0}
                    name={`role.${key}.min`}
                    defaultValue={role?.min ?? 0}
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  Max
                  <input
                    type="number"
                    min={0}
                    name={`role.${key}.max`}
                    defaultValue={role?.max ?? ""}
                    placeholder="—"
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                </label>
              </li>
            );
          })}
        </ul>

        <Field
          label="Overall limit across all roles"
          hint="Blank means no overall cap."
        >
          <input
            type="number"
            min={1}
            name="maxTotal"
            defaultValue={maxTotal ?? ""}
            className={`${INPUT_CLASS} max-w-[10rem]`}
          />
        </Field>

        <p className="text-xs text-gray-500">
          Speaker minimum defaults to <strong>1</strong>. Raising it to 2 forces every
          submission to name a co-speaker, which blocks solo talks.
        </p>

        <button name="intent" value="save-roles" className={BUTTON_CLASS}>
          Save roles
        </button>
      </Form>
    </Section>
  );
}

/*
 * The `cfp_close` label OPENS with "Until the close date above" on purpose —
 * `tests/e2e/features-v012.spec.ts` selects this radio by that phrase, and the
 * design brief freezes it. The contradiction it used to carry is resolved by
 * COMPLETING the sentence rather than replacing it: the label now states the
 * accepted-speaker exception that `speakerEditLockReason` actually implements,
 * so label and hint say the same thing.
 */
export const EDIT_DEADLINE_OPTIONS = [
  [
    "cfp_close",
    "Until the close date above, except for accepted speakers",
    "The default. Pending speakers can edit until the call closes; accepted speakers may still correct their talk afterward.",
  ],
  [
    "custom",
    "Until a date I choose",
    "Applies to pending and accepted submissions alike, and replaces the close date above for edits.",
  ],
  ["open", "No deadline", "Edits stay open for as long as the status allows."],
] as const;

function StepSettings({
  form,
  settings,
  event,
}: {
  form: {
    closesAtInput: string;
    closesAtProse: string | null;
    submissionLimit: number | null;
    allowMultipleDrafts: boolean;
  };
  settings: FormSettings;
  event: { timezone: string; submissionLimit: number | null };
}) {
  // Same helpers as the close date above, so the deadline a speaker is held to
  // and the deadline an operator typed cannot disagree about which day it is.
  const editDeadlineInput = epochToZonedInput(settings.editDeadline.at, event.timezone);
  const editDeadlineProse = formatInZone(settings.editDeadline.at, event.timezone);

  return (
    <Section
      title="Form settings"
      description="Deadlines, limits, and what happens after a submitter presses Submit."
    >
      <Form method="post" className="space-y-4">
        <input type="hidden" name="step" value="settings" />

        <Field
          label="Close date"
          hint={
            <>
              The form stops accepting new submissions and draft saves after this. Setting it also
              enables draft-reminder emails. Times are in the event timezone (
              <code className="font-mono">{event.timezone}</code>).
              {form.closesAtProse ? <> Currently: {form.closesAtProse}.</> : null}
            </>
          }
        >
          <input
            type="datetime-local"
            name="closesAt"
            defaultValue={form.closesAtInput}
            className={`${INPUT_CLASS} max-w-xs`}
          />
        </Field>

        <Field
          label="Submission limit per person"
          hint={
            event.submissionLimit === null ? (
              "No event-level limit is set. Blank here means unlimited."
            ) : (
              <>
                Event max: <strong>{event.submissionLimit}</strong> — applies when no form-level
                limit is set. Includes saved drafts.
              </>
            )
          }
        >
          <input
            type="number"
            min={1}
            name="submissionLimit"
            defaultValue={form.submissionLimit ?? ""}
            placeholder={event.submissionLimit?.toString() ?? "unlimited"}
            className={`${INPUT_CLASS} max-w-[10rem]`}
          />
        </Field>

        <fieldset className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
          <legend className="px-1 text-sm font-medium">
            Speaker edits after submitting
          </legend>
          <p className="mb-2 text-xs text-gray-500">
            When a speaker stops being able to correct their own title, abstract and video.
            Review status always applies on top of this.
          </p>
          {EDIT_DEADLINE_OPTIONS.map(([value, label, hint]) => (
            <label key={value} className="mb-2 flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="editDeadlineMode"
                value={value}
                defaultChecked={settings.editDeadline.mode === value}
                className="mt-1"
              />
              <span>
                {label}
                <span className="block text-xs text-gray-500">{hint}</span>
              </span>
            </label>
          ))}
          <Field
            label="Edit deadline"
            // `Field` only associates its label when given an id — without this
            // the control has no accessible name at all.
            htmlFor="editDeadlineAt"
            hint={
              <>
                Used only by “Until a date I choose”. Times are in the event timezone (
                <code className="font-mono">{event.timezone}</code>).
                {editDeadlineProse ? <> Currently: {editDeadlineProse}.</> : null}
              </>
            }
          >
            <input
              id="editDeadlineAt"
              type="datetime-local"
              name="editDeadlineAt"
              defaultValue={editDeadlineInput}
              className={`${INPUT_CLASS} max-w-xs`}
            />
          </Field>
        </fieldset>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="allowMultipleDrafts"
            defaultChecked={form.allowMultipleDrafts}
            className="mt-1"
          />
          <span>
            Allow multiple draft submissions
            <span className="block text-xs text-gray-500">
              Submitters can keep more than one unfinished submission at a time.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="autoRedirectToPortal"
            defaultChecked={settings.autoRedirectToPortal}
            className="mt-1"
          />
          <span>
            Auto-redirect to the speaker portal
            <span className="block text-xs text-gray-500">
              Ten seconds after the confirmation page. With this off, submitters use a “Continue to
              portal” button instead.
            </span>
          </span>
        </label>

        <Field label="Success page message" hint="Shown on the public confirmation page.">
          <textarea
            name="successMessage"
            rows={4}
            defaultValue={settings.successMessage}
            className={INPUT_CLASS}
          />
        </Field>

        <button name="intent" value="save-settings" className={BUTTON_CLASS}>
          Save settings
        </button>
      </Form>
    </Section>
  );
}

function StepNotifications({
  settings,
  closesAtProse,
}: {
  settings: FormSettings;
  closesAtProse: string | null;
}) {
  const n = settings.notifications;
  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="step" value="notifications" />

      <Section
        title="Submitter notifications"
        description="The confirmation email is the one piece of comms the brief calls a must-have."
      >
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmationEnabled"
              defaultChecked={n.confirmationEmail.enabled}
            />
            Send a submission confirmation email
          </label>
          <Field label="Subject">
            <input
              name="confirmationSubject"
              defaultValue={n.confirmationEmail.subject}
              className={INPUT_CLASS}
            />
          </Field>
          <Field
            label="Body"
            hint="Sent to the submitter as soon as their submission lands, with a link back to it."
          >
            <textarea
              name="confirmationBody"
              rows={4}
              defaultValue={n.confirmationEmail.body}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Draft reminder"
        description={
          closesAtProse
            ? `Sent before the form closes on ${closesAtProse}.`
            : "Needs a close date — set one on Form settings before this can send."
        }
      >
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="reminderEnabled" defaultChecked={n.reminderEmail.enabled} />
            Remind submitters who have an unfinished draft
          </label>
          <Field label="Days before close">
            <input
              type="number"
              min={1}
              name="reminderDays"
              defaultValue={n.reminderEmail.daysBeforeClose}
              className={`${INPUT_CLASS} max-w-[8rem]`}
            />
          </Field>
          <Field label="Subject">
            <input
              name="reminderSubject"
              defaultValue={n.reminderEmail.subject}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Body">
            <textarea
              name="reminderBody"
              rows={3}
              defaultValue={n.reminderEmail.body}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Admin notifications"
        description="Who gets told about activity on this form. Comma- or space-separated."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="On a new submission">
            <input
              name="notifyOnNew"
              defaultValue={n.notifyOnNew.join(", ")}
              className={INPUT_CLASS}
              placeholder="program@example.com"
            />
          </Field>
          <Field label="On an updated submission">
            <input
              name="notifyOnUpdate"
              defaultValue={n.notifyOnUpdate.join(", ")}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      </Section>

      <button name="intent" value="save-notifications" className={BUTTON_CLASS}>
        Save notifications
      </button>
    </Form>
  );
}
