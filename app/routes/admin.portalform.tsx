/**
 * Admin → Portal form editor. The **3-step** wizard (screenshots p25_1–p27_1):
 *
 *   1. Form Setup      — name, external title, type
 *   2. Form Questions  — section heading, instructions, the field list
 *   3. Settings        — deadline, login requirement, confirmation email, reminder
 *
 * Deliberately NOT a client-side wizard: each step is a plain form that POSTs
 * and re-renders. There is no "unsaved changes" state to lose, it works without
 * JS, and the step is in the URL so a half-built form is linkable. The `Next`
 * button carries the same inline hint the screenshots show when a step is
 * incomplete.
 *
 * Validity comes from `stepIssues` in `~/lib/portal-form`, which is unit-tested
 * — the button state and the server's refusal read the same function, so they
 * cannot disagree.
 */
import { Form, Link, redirect, useNavigation } from "react-router";
import { and, eq } from "drizzle-orm";

import { FieldLabel, Notice, buttonClass, inputClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { forms, tasks } from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { requireCurrentEvent } from "~/lib/event.server";
import {
  PORTAL_FORM_TYPE_COPY,
  PORTAL_FORM_TYPES,
  PORTAL_QUESTION_TYPES,
  PORTAL_WIZARD_STEPS,
  canPublish,
  questionKey,
  readPortalSchema,
  readPortalSettings,
  stepIssues,
  type PortalFormDraft,
  type PortalQuestion,
  type PortalWizardStep,
} from "~/lib/portal-form";
import type { Route } from "./+types/admin.portalform";

const STEP_IDS = PORTAL_WIZARD_STEPS.map((step) => step.id);

function currentStep(url: URL): PortalWizardStep {
  const requested = url.searchParams.get("step") ?? "setup";
  return (STEP_IDS as readonly string[]).includes(requested)
    ? (requested as PortalWizardStep)
    : "setup";
}

/** Rebuild the draft shape the pure validators expect from a `forms` row. */
function toDraft(row: {
  name: string;
  welcomeTitle: string | null;
  schema: unknown;
  settings: unknown;
}): PortalFormDraft {
  const settings = readPortalSettings(row.settings);
  return {
    name: row.name,
    title: row.welcomeTitle ?? "",
    type: settings.type,
    schema: readPortalSchema(row.schema),
    settings,
  };
}

export function meta() {
  return [{ title: "Portal form — callboard admin" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);

  const row = await getDb().query.forms.findFirst({
    where: and(
      eq(forms.id, params.formId),
      eq(forms.eventId, event.id),
      eq(forms.surface, "portal"),
    ),
  });
  if (!row) {
    throw new Response("Form not found.", { status: 404 });
  }

  const usedBy = await getDb()
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(eq(tasks.formId, row.id))
    .limit(20);

  const draft = toDraft(row);
  const step = currentStep(new URL(request.url));

  return {
    formId: row.id,
    status: row.status,
    step,
    draft,
    issues: stepIssues(draft, step),
    publishable: canPublish(draft),
    usedBy,
    questionTypes: PORTAL_QUESTION_TYPES,
    steps: PORTAL_WIZARD_STEPS,
    types: PORTAL_FORM_TYPES.map((type) => ({ id: type, ...PORTAL_FORM_TYPE_COPY[type] })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  await requireAdmin(request);
  const event = await requireCurrentEvent(request);
  const db = getDb();

  const row = await db.query.forms.findFirst({
    where: and(
      eq(forms.id, params.formId),
      eq(forms.eventId, event.id),
      eq(forms.surface, "portal"),
    ),
  });
  if (!row) throw new Response("Form not found.", { status: 404 });

  const body = await request.formData();
  const intent = String(body.get("intent") ?? "");
  const schema = readPortalSchema(row.schema);
  const settings = readPortalSettings(row.settings);

  if (intent === "setup") {
    await db
      .update(forms)
      .set({
        name: String(body.get("name") ?? "").trim() || "Untitled portal form",
        welcomeTitle: String(body.get("title") ?? "").trim(),
      })
      .where(eq(forms.id, row.id));
    return redirect(`/admin/portal-forms/${row.id}?step=questions`);
  }

  if (intent === "section") {
    await db
      .update(forms)
      .set({
        schema: {
          ...schema,
          sectionTitle: String(body.get("sectionTitle") ?? "").trim() || "Your information",
          description: String(body.get("description") ?? ""),
        },
      })
      .where(eq(forms.id, row.id));
    return { ok: "Section saved." };
  }

  if (intent === "add-question") {
    const label = String(body.get("label") ?? "").trim();
    if (!label) return { error: "Give the question a label." };

    const type = String(body.get("type") ?? "text");
    if (!(PORTAL_QUESTION_TYPES as readonly string[]).includes(type)) {
      return { error: "Unknown question type." };
    }

    const options = String(body.get("options") ?? "")
      .split("\n")
      .map((option) => option.trim())
      .filter(Boolean);

    const question: PortalQuestion = {
      key: questionKey(label, schema.questions.map((existing) => existing.key)),
      label,
      type: type as PortalQuestion["type"],
      required: body.get("required") === "on",
      locked: body.get("locked") === "on",
      helpText: String(body.get("helpText") ?? "").trim() || undefined,
      ...(options.length ? { options } : {}),
      ...(type === "file" ? { filePurpose: "document" as const } : {}),
    };

    await db
      .update(forms)
      .set({ schema: { ...schema, questions: [...schema.questions, question] } })
      .where(eq(forms.id, row.id));
    return { ok: `Added "${label}".` };
  }

  if (intent === "remove-question") {
    const key = String(body.get("key") ?? "");
    await db
      .update(forms)
      .set({
        schema: {
          ...schema,
          questions: schema.questions.filter((question) => question.key !== key),
        },
      })
      .where(eq(forms.id, row.id));
    return { ok: "Question removed." };
  }

  if (intent === "move-question") {
    const key = String(body.get("key") ?? "");
    const delta = Number(body.get("delta") ?? 0);
    const list = [...schema.questions];
    const index = list.findIndex((question) => question.key === key);
    const target = index + delta;
    if (index >= 0 && target >= 0 && target < list.length) {
      [list[index], list[target]] = [list[target], list[index]];
      await db.update(forms).set({ schema: { ...schema, questions: list } }).where(eq(forms.id, row.id));
    }
    return { ok: "Reordered." };
  }

  if (intent === "settings") {
    const deadline = String(body.get("deadline") ?? "").trim();
    const reminder = String(body.get("reminderDaysBefore") ?? "").trim();
    await db
      .update(forms)
      .set({
        settings: {
          ...settings,
          deadlineAt: deadline ? Date.parse(`${deadline}T23:59:59Z`) : null,
          requireLogin: body.get("requireLogin") === "on",
          sendConfirmationEmail: body.get("sendConfirmationEmail") === "on",
          confirmationBody: String(body.get("confirmationBody") ?? ""),
          reminderDaysBefore: reminder ? Number(reminder) : null,
        },
        closesAt: deadline ? new Date(Date.parse(`${deadline}T23:59:59Z`)) : null,
      })
      .where(eq(forms.id, row.id));
    return { ok: "Settings saved." };
  }

  if (intent === "publish") {
    const draft = toDraft(row);
    if (!canPublish(draft)) {
      return { error: "Finish every step before publishing." };
    }
    await db.update(forms).set({ status: "open" }).where(eq(forms.id, row.id));
    return { ok: "Form published — it can now be attached to a task." };
  }

  return { error: "Unknown action." };
}

export default function AdminPortalForm({ loaderData, actionData }: Route.ComponentProps) {
  const { formId, status, step, draft, issues, publishable, usedBy, questionTypes, steps, types } =
    loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <Link to="/admin/portal-forms" className="text-gray-500 underline">
              ← All portal forms
            </Link>
          </p>
          <h1 className="mt-1 text-lg font-semibold">{draft.name}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {status} · used by {usedBy.length} task{usedBy.length === 1 ? "" : "s"}
          </p>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <button type="submit" className={buttonClass()} disabled={!publishable || busy}>
            {status === "open" ? "Re-publish" : "Publish"}
          </button>
        </Form>
      </header>

      {/* step strip */}
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((wizardStep, index) => {
          const active = wizardStep.id === step;
          return (
            <li key={wizardStep.id}>
              <Link
                to={`/admin/portal-forms/${formId}?step=${wizardStep.id}`}
                className={[
                  "block rounded-lg border p-3",
                  active
                    ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                    : "border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900",
                ].join(" ")}
              >
                <span className="text-xs text-gray-500">Step {index + 1}</span>
                <span className="block text-sm font-medium">{wizardStep.label}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {wizardStep.subtitle}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      {actionData && "error" in actionData && actionData.error ? (
        <Notice tone="error">{actionData.error}</Notice>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <Notice tone="success">{actionData.ok}</Notice>
      ) : null}

      {issues.length > 0 ? (
        <Notice tone="info">
          Complete all required fields on this step to continue:{" "}
          {issues.join(" ")}
        </Notice>
      ) : null}

      {/* ─────────── step 1 ─────────── */}
      {step === "setup" ? (
        <Form method="post" className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <input type="hidden" name="intent" value="setup" />
          <div>
            <FieldLabel htmlFor="name" required hint="Internal — only admins see this.">
              Name
            </FieldLabel>
            <input
              id="name"
              name="name"
              defaultValue={draft.name}
              placeholder="e.g. Speaker Contact Form"
              className={inputClass}
            />
          </div>
          <div>
            <FieldLabel htmlFor="title" required hint="What the speaker sees at the top of the form.">
              Title
            </FieldLabel>
            <input
              id="title"
              name="title"
              defaultValue={draft.title}
              placeholder="e.g. Confirm your travel details"
              className={inputClass}
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Type</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {types.map((type) => (
                <label
                  key={type.id}
                  className="flex cursor-pointer gap-2 rounded-lg border border-gray-200 p-3 has-checked:border-blue-600 has-checked:bg-blue-50 dark:border-gray-800 dark:has-checked:bg-blue-950"
                >
                  <input
                    type="radio"
                    name="type"
                    value={type.id}
                    defaultChecked={draft.type === type.id}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium">{type.label}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {type.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Contact- and group-scoped forms (sponsors, exhibitors) are not in this
              release.
            </p>
          </fieldset>
          <button type="submit" className={buttonClass()} disabled={busy}>
            Save and continue →
          </button>
        </Form>
      ) : null}

      {/* ─────────── step 2 ─────────── */}
      {step === "questions" ? (
        <div className="space-y-5">
          <Form method="post" className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
            <input type="hidden" name="intent" value="section" />
            <div>
              <FieldLabel htmlFor="sectionTitle" required>
                Section title
              </FieldLabel>
              <input
                id="sectionTitle"
                name="sectionTitle"
                defaultValue={draft.schema.sectionTitle}
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="description" hint="Markdown. Shown above the questions.">
                Description and instructions
              </FieldLabel>
              <textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={draft.schema.description ?? ""}
                className={inputClass}
              />
            </div>
            <button type="submit" className={buttonClass("secondary")} disabled={busy}>
              Save section
            </button>
          </Form>

          <div className="rounded-xl border border-gray-200 dark:border-gray-800">
            <h2 className="border-b border-gray-200 px-4 py-2 text-sm font-semibold dark:border-gray-800">
              Questions ({draft.schema.questions.length})
            </h2>
            {draft.schema.questions.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500">
                No questions yet. Add the first one below.
              </p>
            ) : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                {draft.schema.questions.map((question, index) => (
                  <li key={question.key} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {question.label}
                        {question.required ? <span className="text-rose-600"> *</span> : null}
                        {question.locked ? <span title="Locked"> 🔒</span> : null}
                      </p>
                      <p className="font-mono text-xs text-gray-500">
                        {question.key} · {question.type}
                        {question.options?.length ? ` · ${question.options.length} options` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <MoveButton formIntent="move-question" questionKeyValue={question.key} delta={-1} disabled={index === 0} label="↑" />
                      <MoveButton
                        formIntent="move-question"
                        questionKeyValue={question.key}
                        delta={1}
                        disabled={index === draft.schema.questions.length - 1}
                        label="↓"
                      />
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove-question" />
                        <input type="hidden" name="key" value={question.key} />
                        <button type="submit" className="px-2 py-1 text-xs text-rose-600 underline">
                          Remove
                        </button>
                      </Form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Form method="post" className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
            <input type="hidden" name="intent" value="add-question" />
            <h2 className="text-sm font-semibold">Add a field</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="label" required>
                  Label
                </FieldLabel>
                <input id="label" name="label" required className={inputClass} />
              </div>
              <div>
                <FieldLabel htmlFor="type">Type</FieldLabel>
                <select id="type" name="type" className={inputClass} defaultValue="text">
                  {questionTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <FieldLabel htmlFor="helpText">Help text</FieldLabel>
                <input id="helpText" name="helpText" className={inputClass} />
              </div>
              <div className="sm:col-span-2">
                <FieldLabel htmlFor="options" hint="One per line. Only for select / multiselect.">
                  Options
                </FieldLabel>
                <textarea id="options" name="options" rows={3} className={inputClass} />
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="required" className="h-4 w-4" /> Required
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="locked" className="h-4 w-4" /> Locked (visible, not
                editable)
              </label>
            </div>
            <button type="submit" className={buttonClass()} disabled={busy}>
              + Add field
            </button>
          </Form>
        </div>
      ) : null}

      {/* ─────────── step 3 ─────────── */}
      {step === "settings" ? (
        <Form method="post" className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <input type="hidden" name="intent" value="settings" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="deadline" hint="After this date the form is read-only.">
                Deadline
              </FieldLabel>
              <input
                id="deadline"
                name="deadline"
                type="date"
                defaultValue={
                  draft.settings.deadlineAt
                    ? new Date(draft.settings.deadlineAt).toISOString().slice(0, 10)
                    : ""
                }
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="reminderDaysBefore" hint="Days before the deadline. Needs a deadline.">
                Reminder
              </FieldLabel>
              <input
                id="reminderDaysBefore"
                name="reminderDaysBefore"
                type="number"
                min={0}
                defaultValue={draft.settings.reminderDaysBefore ?? ""}
                className={inputClass}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="requireLogin"
              defaultChecked={draft.settings.requireLogin}
              className="h-4 w-4"
            />
            Require the speaker to be signed in
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="sendConfirmationEmail"
              defaultChecked={draft.settings.sendConfirmationEmail}
              className="h-4 w-4"
            />
            Send a confirmation email on submit
          </label>
          <div>
            <FieldLabel htmlFor="confirmationBody">Confirmation email body</FieldLabel>
            <textarea
              id="confirmationBody"
              name="confirmationBody"
              rows={3}
              defaultValue={draft.settings.confirmationBody ?? ""}
              placeholder="Thank you for submitting your form. Here is a link to your submission."
              className={inputClass}
            />
          </div>
          <button type="submit" className={buttonClass()} disabled={busy}>
            Save settings
          </button>
        </Form>
      ) : null}

      {usedBy.length > 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Attached to: {usedBy.map((task) => task.title).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function MoveButton({
  formIntent,
  questionKeyValue,
  delta,
  disabled,
  label,
}: {
  formIntent: string;
  questionKeyValue: string;
  delta: number;
  disabled: boolean;
  label: string;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={formIntent} />
      <input type="hidden" name="key" value={questionKeyValue} />
      <input type="hidden" name="delta" value={delta} />
      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-gray-700"
      >
        {label}
      </button>
    </Form>
  );
}
