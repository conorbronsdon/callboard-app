import { and, asc, eq, exists, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Form, Link, data, redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import {
  eventPeople,
  fields as fieldsTable,
  forms,
  people,
  sessionParticipants,
  sessions,
  type Session,
} from "~/db/schema";
import {
  addSessionParticipant,
  checkParticipantAddConflict,
  PARTICIPANT_ROLE_LABELS,
  removeSessionParticipant,
} from "~/lib/admin/session-participants.server";
import { recordSessionRevision } from "~/lib/admin/session-revisions.server";
import { findOrCreatePerson, normalizeEmail } from "~/lib/auth/auth.server";
import {
  hydrateFieldRefs,
  toFormDefinition,
  validate,
  type AnswerValue,
  type FormDefinition,
} from "~/lib/form-schema";
import { speakerVisibleStatus } from "~/lib/portal-progress";
import { portalRecordContext } from "~/lib/portal/portal.server";
import {
  PARTICIPANT_CONFLICT_COPY,
  PROGRAMME_MISSING_COPY,
  SPEAKER_EDIT_LOCK_COPY,
  speakerEditLockReason,
  validateSubmissionEdit,
} from "~/lib/portal/submission-edit";
import type { Route } from "./+types/portal.submission.edit";

const INPUT =
  "mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900";
const ABSTRACT_KEYS = ["abstract", "description", "body"] as const;

async function ownedSubmission(input: {
  sessionId: string;
  eventId: string;
  personId: string;
}) {
  const rows = await getDb()
    .select({ session: sessions, form: forms })
    .from(sessions)
    .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
    .innerJoin(forms, eq(forms.id, sessions.formId))
    .where(
      and(
        eq(sessions.id, input.sessionId),
        eq(sessions.eventId, input.eventId),
        eq(sessions.isAbstract, true),
        eq(forms.eventId, input.eventId),
        eq(forms.surface, "cfp"),
        eq(sessionParticipants.personId, input.personId),
        eq(sessionParticipants.isPrimary, true),
        isNull(sessions.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The event this page runs in is the SUBMISSION's, not whichever event ambient
 * portal resolution would have picked — the identical defect the task detail had
 * (SPK-09 / CNT-02), reached through `/portal/submissions` and the dashboard,
 * both of which link here without an `?event=`.
 *
 * Ownership is the `isPrimary` participant row, matching `ownedSubmission`: a
 * co-author is not the editor, so their submission is not found here and no
 * event is resolved from it.
 */
const submissionEventId = (sessionId: string) => async (personId: string) => {
  const [row] = await getDb()
    .select({ eventId: sessions.eventId })
    .from(sessions)
    .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.isAbstract, true),
        eq(sessionParticipants.personId, personId),
        eq(sessionParticipants.isPrimary, true),
        isNull(sessions.deletedAt),
      ),
    )
    .limit(1);
  return row?.eventId ?? null;
};

export function meta() {
  return [{ title: "Edit submission — callboard" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { actor, event } = await portalRecordContext(request, submissionEventId(params.sessionId));
  const owned = await ownedSubmission({
    sessionId: params.sessionId,
    eventId: event.id,
    personId: actor.person.id,
  });
  if (!owned) throw new Response("Submission not found.", { status: 404 });
  const { session: submission, form } = owned;
  const definition = toFormDefinition(form);
  const coAuthorRoles = definition.participants.roles
    .filter((role) => role.enabled && role.key !== "speaker")
    .map((role) => ({ value: role.key, label: role.label }));
  const lockReason = speakerEditLockReason({
    status: submission.status,
    closesAt: definition.closesAt,
    policy: definition.settings.editDeadline,
  });
  const [programme, participantRows] = await Promise.all([
    submission.status === "accepted" && submission.composedIntoSessionId
      ? getDb().query.sessions.findFirst({
          where: and(
            eq(sessions.id, submission.composedIntoSessionId),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, false),
            isNull(sessions.deletedAt),
          ),
        })
      : null,
    getDb()
      .select({
        personId: people.id,
        name: people.fullName,
        email: people.email,
        role: sessionParticipants.role,
        isPrimary: sessionParticipants.isPrimary,
      })
      .from(sessionParticipants)
      .innerJoin(people, eq(people.id, sessionParticipants.personId))
      .where(eq(sessionParticipants.sessionId, submission.id))
      .orderBy(asc(sessionParticipants.order)),
  ]);

  return {
    submission: {
      id: submission.id,
      friendlyId: submission.friendlyId,
      title: submission.title,
      abstract: submission.description ?? "",
      videoUrl: submission.videoUrl ?? "",
      /*
       * Projected, like every other portal payload. This route 404s on
       * ownership alone, never on lock state, so a queued proposal still
       * renders a 200 with its status serialised into the document. `lockReason`
       * is what the page reads; the raw queue token has no business on the wire.
       */
      status: speakerVisibleStatus(submission.status),
      updatedAt: submission.updatedAt.getTime(),
      programmeUpdatedAt: programme?.updatedAt.getTime() ?? null,
      editable:
        lockReason === null &&
        (submission.status !== "accepted" || programme !== null),
      lockReason:
        submission.status === "accepted" && programme === null
          ? ("programme_missing" as const)
          : lockReason,
    },
    participants: participantRows.map((participant) => ({
      personId: participant.personId,
      name: participant.name ?? participant.email,
      email: participant.email,
      role: participant.role,
      roleLabel: PARTICIPANT_ROLE_LABELS[participant.role],
      isPrimary: participant.isPrimary,
    })),
    coAuthorRoles,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  // Same derivation as the loader: rendering under one event and writing under
  // another is the bug, not a detail.
  const { actor, event } = await portalRecordContext(request, submissionEventId(params.sessionId));
  const owned = await ownedSubmission({
    sessionId: params.sessionId,
    eventId: event.id,
    personId: actor.person.id,
  });
  if (!owned) throw new Response("Submission not found.", { status: 404 });
  const { session: submission, form } = owned;
  const formDefinition = toFormDefinition(form);
  const body = await request.formData();
  const intent = String(body.get("intent") ?? "");
  const lockReason = speakerEditLockReason({
    status: submission.status,
    closesAt: formDefinition.closesAt,
    policy: formDefinition.settings.editDeadline,
  });

  if (lockReason) {
    return data(
      { ok: false as const, errors: { form: SPEAKER_EDIT_LOCK_COPY[lockReason] } },
      { status: 409 },
    );
  }

  const coAuthorRoleConfigs = formDefinition.participants.roles.filter(
    (role) => role.enabled && role.key !== "speaker",
  );
  const db = getDb();
  let participantProgramme: Session | null = null;

  if (
    (intent === "add-coauthor" || intent === "remove-coauthor") &&
    submission.status === "accepted"
  ) {
    participantProgramme = submission.composedIntoSessionId
      ? (await db.query.sessions.findFirst({
          where: and(
            eq(sessions.id, submission.composedIntoSessionId),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, false),
            isNull(sessions.deletedAt),
          ),
        })) ?? null
      : null;
    if (!participantProgramme) {
      return data(
        { ok: false as const, errors: { form: PROGRAMME_MISSING_COPY } },
        { status: 409 },
      );
    }
  }

  if (intent === "add-coauthor") {
    if (coAuthorRoleConfigs.length === 0) {
      return data(
        {
          ok: false as const,
          errors: { form: "This call for proposals does not collect co-authors." },
        },
        { status: 400 },
      );
    }

    const name = String(body.get("name") ?? "").trim();
    const email = String(body.get("email") ?? "").trim();
    const role = String(body.get("role") ?? "").trim();
    if (!email || !email.includes("@")) {
      return data(
        { ok: false as const, errors: { form: "Enter the co-author's email address." } },
        { status: 400 },
      );
    }
    const roleConfig = coAuthorRoleConfigs.find((candidate) => candidate.key === role);
    if (!roleConfig) {
      return data(
        { ok: false as const, errors: { form: "Pick a role for this co-author." } },
        { status: 400 },
      );
    }

    const currentParticipants = await db
      .select({ role: sessionParticipants.role })
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, submission.id));
    const maxTotal = formDefinition.participants.maxTotal;
    if (maxTotal !== null && currentParticipants.length >= maxTotal) {
      return data(
        {
          ok: false as const,
          errors: {
            form: `This call for proposals allows at most ${maxTotal} participants.`,
          },
        },
        { status: 400 },
      );
    }
    const roleCount = currentParticipants.filter(
      (participant) => participant.role === roleConfig.key,
    ).length;
    if (roleConfig.max !== null && roleCount >= roleConfig.max) {
      return data(
        {
          ok: false as const,
          errors: {
            form: `This call for proposals allows at most ${roleConfig.max} ${roleConfig.label.toLowerCase()} participants.`,
          },
        },
        { status: 400 },
      );
    }

    const existingPerson = await db.query.people.findFirst({
      where: eq(people.email, normalizeEmail(email)),
    });
    if (participantProgramme && existingPerson) {
      const conflictCheck = await checkParticipantAddConflict({
        eventId: event.id,
        programmeSessionId: participantProgramme.id,
        personId: existingPerson.id,
        personName: existingPerson.fullName ?? existingPerson.email,
      });
      if (conflictCheck.blocked) {
        return data(
          { ok: false as const, errors: { form: PARTICIPANT_CONFLICT_COPY } },
          { status: 409 },
        );
      }
    }

    const person = await findOrCreatePerson(email, { fullName: name || null });
    await db
      .insert(eventPeople)
      .values({ eventId: event.id, personId: person.id, eventRole: "speaker" })
      .onConflictDoNothing();

    // addSessionParticipant mirrors onto the composed programme session when
    // this submission has been accepted, so the co-author appears on the public
    // schedule and organizer record without a second write path here.
    const result = await addSessionParticipant({
      sessionId: submission.id,
      eventId: event.id,
      personId: person.id,
      role,
    });
    if (!result.ok) {
      return data(
        { ok: false as const, errors: { form: result.error } },
        { status: 400 },
      );
    }
    return redirect("/portal/submissions/" + submission.id + "/edit");
  }

  if (intent === "remove-coauthor") {
    const result = await removeSessionParticipant({
      sessionId: submission.id,
      eventId: event.id,
      personId: String(body.get("personId") ?? ""),
    });
    if (!result.ok) {
      return data(
        { ok: false as const, errors: { form: result.error } },
        { status: 400 },
      );
    }
    return redirect("/portal/submissions/" + submission.id + "/edit");
  }

  if (intent !== "" && intent !== "save") {
    return data(
      { ok: false as const, errors: { form: `Unknown intent "${intent}".` } },
      { status: 400 },
    );
  }

  const expectedUpdatedAt = Number(body.get("expectedUpdatedAt"));
  if (!Number.isFinite(expectedUpdatedAt) || expectedUpdatedAt !== submission.updatedAt.getTime()) {
    return data(
      { ok: false as const, errors: { form: "This submission changed while you were editing it. Reload and try again." } },
      { status: 409 },
    );
  }

  const checked = validateSubmissionEdit({
    title: String(body.get("title") ?? ""),
    abstract: String(body.get("abstract") ?? ""),
    videoUrl: String(body.get("videoUrl") ?? ""),
  });
  if (!checked.ok) return data({ ok: false as const, errors: checked.errors }, { status: 400 });

  const registry = await getDb().query.fields.findMany({
    where: and(eq(fieldsTable.eventId, event.id), isNull(fieldsTable.archivedAt)),
  });
  const parsed = formDefinition;
  const hydrated: FormDefinition = {
    ...parsed,
    fields: hydrateFieldRefs(parsed.fields, registry),
    // Participant answers and roster are immutable in this correction surface.
    // They were validated when submitted and must not block a content fix.
    participants: { ...parsed.participants, collect: false },
  };

  const previous = (submission.answers ?? {}) as Record<string, AnswerValue>;
  const abstractKey =
    ABSTRACT_KEYS.find((key) => Object.hasOwn(previous, key)) ??
    ABSTRACT_KEYS.find((key) => hydrated.fields.some((field) => field.key === key)) ??
    "abstract";
  const answers: Record<string, AnswerValue> = {
    ...previous,
    title: checked.value.title,
    [abstractKey]: checked.value.abstract,
  };
  if (
    Object.hasOwn(previous, "video_url") ||
    hydrated.fields.some(
      (field) => field.scope === "submission" && field.key === "video_url",
    )
  ) {
    answers.video_url = checked.value.videoUrl;
  }

  const definitionFor = (videoUrl: string): FormDefinition =>
    videoUrl
      ? {
          ...hydrated,
          fields: hydrated.fields.map((field) =>
            ABSTRACT_KEYS.includes(field.key as (typeof ABSTRACT_KEYS)[number])
              ? { ...field, required: false }
              : field,
          ),
        }
      : hydrated;

  const baseline = validate(
    { fields: previous, participants: [] },
    definitionFor(submission.videoUrl ?? ""),
  );
  const evaluated = validate(
    { fields: answers, participants: [] },
    definitionFor(checked.value.videoUrl),
  );

  // Historical issues are grandfathered because this three-field correction
  // page cannot repair them. The edit may not create a new issue, and it must
  // still repair every issue on an editable field or combined rule it affects.
  const editableKeys = new Set(["title", abstractKey, "video_url"]);
  const affectedCombinedRules = new Set(
    evaluated.counters
      .filter((counter) => counter.countedKeys.some((key) => editableKeys.has(key)))
      .map((counter) => counter.ruleId),
  );
  const issueIdentity = (issue: (typeof evaluated.issues)[number]) =>
    [
      issue.code,
      issue.fieldKey ?? "",
      issue.ruleId ?? "",
      issue.participantIndex ?? "",
      issue.roleKey ?? "",
    ].join("|");
  const baselineIssues = new Set(baseline.issues.map(issueIdentity));
  const editIssues = evaluated.issues.filter(
    (issue) =>
      (issue.fieldKey !== undefined && editableKeys.has(issue.fieldKey)) ||
      (issue.code === "combined_limit" &&
        issue.ruleId !== undefined &&
        affectedCombinedRules.has(issue.ruleId)) ||
      !baselineIssues.has(issueIdentity(issue)),
  );

  if (editIssues.length > 0) {
    const errors: Record<string, string> = {};
    for (const issue of editIssues) {
      const key = issue.fieldKey;
      if (key === "title") errors.title ??= issue.message;
      else if (key && ABSTRACT_KEYS.includes(key as (typeof ABSTRACT_KEYS)[number])) {
        errors.abstract ??= issue.message;
      } else if (key === "video_url") errors.videoUrl ??= issue.message;
      else errors.form = errors.form ? errors.form + " " + issue.message : issue.message;
    }
    return data({ ok: false as const, errors }, { status: 400 });
  }

  const expectedProgrammeUpdatedAt = Number(body.get("expectedProgrammeUpdatedAt"));
  const programme =
    submission.status === "accepted" && submission.composedIntoSessionId
      ? await db.query.sessions.findFirst({
          where: and(
            eq(sessions.id, submission.composedIntoSessionId),
            eq(sessions.eventId, event.id),
            eq(sessions.isAbstract, false),
            isNull(sessions.deletedAt),
          ),
        })
      : null;
  if (
    submission.status === "accepted" &&
    (!programme ||
      !Number.isFinite(expectedProgrammeUpdatedAt) ||
      expectedProgrammeUpdatedAt !== programme.updatedAt.getTime())
  ) {
    return data(
      {
        ok: false as const,
        errors: {
          form:
            "This accepted submission or its programme session changed while you were editing it. Reload and try again.",
        },
      },
      { status: 409 },
    );
  }

  const updatedAt = new Date();
  const values = {
    title: checked.value.title,
    description: checked.value.abstract || null,
    videoUrl: checked.value.videoUrl || null,
    answers,
    updatedAt,
  };
  const submissionScope = [
    eq(sessions.id, submission.id),
    eq(sessions.eventId, event.id),
    eq(sessions.formId, form.id),
    eq(sessions.status, submission.status),
    eq(sessions.updatedAt, submission.updatedAt),
    eq(sessions.isAbstract, true),
    isNull(sessions.deletedAt),
  ];

  let updated: { id: string }[];
  if (submission.status === "accepted") {
    const programId = submission.composedIntoSessionId;
    if (!programId) {
      return data(
        {
          ok: false as const,
          errors: {
            form:
              "This accepted submission is missing its programme session. Contact the programme team.",
          },
        },
        { status: 409 },
      );
    }

    // D1 has no interactive transactions. Keep the accepted abstract and its
    // composed programme session in one atomic batch. The programme write runs
    // first only while the source abstract is still the version the speaker
    // loaded; the abstract write then requires that exact programme write.
    const source = alias(sessions, "speaker_edit_source");
    const composed = alias(sessions, "speaker_edit_composed");
    const sourceStillCurrent = db
      .select({ id: source.id })
      .from(source)
      .where(
        and(
          eq(source.id, submission.id),
          eq(source.eventId, event.id),
          eq(source.formId, form.id),
          eq(source.status, "accepted"),
          eq(source.updatedAt, submission.updatedAt),
          eq(source.composedIntoSessionId, programId),
          eq(source.isAbstract, true),
          isNull(source.deletedAt),
        ),
      );
    const programmeUpdated = db
      .update(sessions)
      .set({
        title: checked.value.title,
        description: checked.value.abstract || null,
        updatedAt,
      })
      .where(
        and(
          eq(sessions.id, programId),
          eq(sessions.eventId, event.id),
          eq(sessions.isAbstract, false),
          eq(sessions.updatedAt, programme!.updatedAt),
          isNull(sessions.deletedAt),
          exists(sourceStillCurrent),
        ),
      )
      .returning({ id: sessions.id });
    const programmeNowMatches = db
      .select({ id: composed.id })
      .from(composed)
      .where(
        and(
          eq(composed.id, programId),
          eq(composed.eventId, event.id),
          eq(composed.isAbstract, false),
          eq(composed.updatedAt, updatedAt),
          isNull(composed.deletedAt),
        ),
      );
    const submissionUpdated = db
      .update(sessions)
      .set(values)
      .where(and(...submissionScope, exists(programmeNowMatches)))
      .returning({ id: sessions.id });

    const [programmeRows, submissionRows] = await db.batch([
      programmeUpdated,
      submissionUpdated,
    ]);
    updated = submissionRows;
    if (programmeRows.length === 0) updated = [];
  } else {
    updated = await db
      .update(sessions)
      .set(values)
      .where(and(...submissionScope))
      .returning({ id: sessions.id });
  }

  if (updated.length === 0) {
    return data(
      { ok: false as const, errors: { form: "This submission or its programme session changed while you were editing it. Reload and try again." } },
      { status: 409 },
    );
  }

  await recordSessionRevision({
    sessionIds: [
      ...updated.map((row) => row.id),
      ...(submission.status === "accepted" && submission.composedIntoSessionId
        ? [submission.composedIntoSessionId]
        : []),
    ],
    title: checked.value.title,
    description: checked.value.abstract || null,
    editor: {
      personId: actor.person.id,
      name: actor.person.fullName ?? actor.person.email,
      source: "portal_edit",
    },
    now: updatedAt,
  });

  // The record-named route derives the event from this submission id; the
  // submissions list would instead trust an unrelated ambient event cookie.
  return redirect("/portal/submissions/" + submission.id + "/edit");
}

export default function EditSubmission({ loaderData, actionData }: Route.ComponentProps) {
  const { submission, participants, coAuthorRoles } = loaderData;
  const errors =
    actionData && "errors" in actionData
      ? (actionData.errors as Record<string, string | undefined>)
      : {};

  if (!submission.editable) {
    return (
      <div className="space-y-4">
        <Link to="/portal/submissions" className="text-sm underline">
          ← Your submissions
        </Link>
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <h1 className="font-semibold">This submission is locked</h1>
          <p className="mt-1 text-sm">
            {submission.lockReason === "programme_missing"
              ? PROGRAMME_MISSING_COPY
              : `${
                  SPEAKER_EDIT_LOCK_COPY[
                    submission.lockReason ?? "review_advanced"
                  ]
                } Contact the programme team if a correction is still needed.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link to="/portal/submissions" className="text-sm underline">
        ← Your submissions
      </Link>
      <header>
        <h1 className="text-xl font-semibold">Edit submission</h1>
        <p className="mt-1 text-sm text-gray-500">
          {submission.friendlyId ?? "Submission"} · Changes are visible to reviewers
          immediately.
        </p>
      </header>

      {errors.form ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {errors.form}
        </p>
      ) : null}

      <Form method="post" className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
        <input type="hidden" name="expectedUpdatedAt" value={submission.updatedAt} />
        {submission.programmeUpdatedAt !== null ? (
          <input
            type="hidden"
            name="expectedProgrammeUpdatedAt"
            value={submission.programmeUpdatedAt}
          />
        ) : null}
        <label className="block text-sm font-medium">
          Session title
          <input name="title" defaultValue={submission.title} maxLength={120} required className={INPUT} />
          {errors.title ? <span className="mt-1 block text-red-600">{errors.title}</span> : null}
        </label>

        <label className="block text-sm font-medium">
          Abstract
          <textarea name="abstract" defaultValue={submission.abstract} rows={10} className={INPUT} />
          {errors.abstract ? <span className="mt-1 block text-red-600">{errors.abstract}</span> : null}
        </label>

        <label className="block text-sm font-medium">
          Video link <span className="font-normal text-gray-500">(optional)</span>
          <input name="videoUrl" type="url" defaultValue={submission.videoUrl} className={INPUT} />
          {errors.videoUrl ? <span className="mt-1 block text-red-600">{errors.videoUrl}</span> : null}
        </label>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass("primary")}>
            Save changes
          </button>
          <Link to="/portal/submissions" className={buttonClass("secondary")}>
            Cancel
          </Link>
        </div>
      </Form>

      {coAuthorRoles.length > 0 ? (
        <section className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <div>
            <h2 className="font-semibold">Co-authors</h2>
            <p className="mt-1 text-sm text-gray-500">
              Add the people who are presenting or supporting this submission with you.
            </p>
          </div>

          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {participants.map((participant) => (
              <li
                key={`${participant.personId}-${participant.role}`}
                className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    {participant.name || participant.email}
                  </p>
                  <p className="text-sm text-gray-500 break-all">{participant.email}</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  {participant.roleLabel}
                </span>
                {participant.isPrimary ? (
                  <span className="ml-auto text-xs text-gray-500">You</span>
                ) : (
                  <form method="post" className="ml-auto">
                    <input type="hidden" name="intent" value="remove-coauthor" />
                    <input type="hidden" name="personId" value={participant.personId} />
                    <button type="submit" className={buttonClass("secondary")}>
                      Remove
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          <form method="post" className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="add-coauthor" />
            <label className="block text-sm font-medium">
              Name <span className="font-normal text-gray-500">(optional)</span>
              <input name="name" type="text" placeholder="Full name" className={INPUT} />
            </label>
            <label className="block text-sm font-medium">
              Email
              <input name="email" type="email" required className={INPUT} />
            </label>
            <label className="block text-sm font-medium">
              Role
              <select name="role" className={INPUT}>
                {coAuthorRoles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button type="submit" className={buttonClass("primary")}>
                Add co-author
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
