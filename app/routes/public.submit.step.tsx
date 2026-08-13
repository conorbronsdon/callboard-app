/**
 * Public CFP wizard, steps ②–⑤: Account → Submission → Participant → Review.
 *
 * Design rules for this route (AGENTS.md #8 — public routes are the speed-
 * scored surface):
 *  - Everything server-renders. Every step is a plain `<form method="post">`
 *    with named inputs and a server action that re-validates; the flow works
 *    with JavaScript disabled.
 *  - The client layer only adds LIVENESS — per-field errors as you type, the
 *    combined character counter, conditional show/hide, and the participant
 *    role indicator. It calls WS1a's evaluator, the same one the action runs,
 *    so the two can never disagree.
 *  - No spinners and no layout-shifting placeholders.
 */
import { useState } from "react";
import { Form, Link, data, redirect } from "react-router";

import { CombinedCounterBox, ErrorToast, FieldInput } from "~/components/submit/fields";
import {
  ClosedNotice,
  LimitReachedNotice,
  RichText,
  WizardShell,
} from "~/components/submit/shell";
import { WizardFooter } from "~/components/submit/stepper";
import {
  normalizeEmail,
  requestCfpSignup,
  shouldRevealMagicLink,
} from "~/lib/auth/auth.server";
import { isDemoMode } from "~/lib/env.server";
import { fieldLabels } from "~/lib/field-labels";
import { RATE_LIMIT_POLICIES, enforceRateLimit } from "~/lib/rate-limit.server";
import {
  checkEligibleTrack,
  combinedCounters,
  fieldStates,
  textOf,
  validate,
  visibleFields,
  type AnswerValue,
  type FormDefinition,
  type ValidationIssue,
} from "~/lib/public-submit/contract";
import {
  ensureDraft,
  loadSubmitContext,
  primaryFromPerson,
  saveDraft,
  storeSubmissionUpload,
  submitDraft,
} from "~/lib/public-submit/draft.server";
import { draftPayload, loadWizardView } from "~/lib/public-submit/view.server";
import {
  EMPTY_CONTENT,
  TRACK_KEY,
  canAddParticipant,
  checkContent,
  checkParticipants,
  enabledRoles,
  isWizardStep,
  resolveStep,
  stepPath,
  toFormAnswers,
  type DraftContent,
  type DraftParticipant,
  type WizardStep,
} from "~/lib/public-submit/wizard";
import type { Route } from "./+types/public.submit.step";

/** Keys whose "required" relaxes when the submitter chooses a video instead. */
const ABSTRACT_KEYS = ["abstract", "description", "body"];

export function resolveSubmissionError(input: {
  key: string;
  mode: "abstract" | "video";
  touched: boolean;
  liveError: string | undefined;
  serverError: string | undefined;
}): string | null {
  if (input.mode === "video" && ABSTRACT_KEYS.includes(input.key)) {
    return input.serverError ?? null;
  }
  if (input.touched) return input.liveError ?? null;
  return input.serverError ?? null;
}

export function blockingSubmissionErrors(
  serverErrors: Record<string, string>,
  errorFor: (key: string) => string | null,
): string[] {
  return Object.keys(serverErrors).filter(
    (key) => (key === TRACK_KEY || !key.startsWith("__")) && errorFor(key) !== null,
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Submit" }];
  const label = loaderData.view.chrome.labels[loaderData.view.step];
  return [{ title: `${label} — ${loaderData.view.form.name}` }];
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params }: Route.LoaderArgs) {
  const { context, view } = await loadWizardView({
    request,
    eventSlug: params.eventSlug,
    formId: params.formId,
    requestedStep: params.step,
  });

  // Canonicalise the URL when the requested step is not reachable yet.
  if (isWizardStep(params.step) && params.step !== view.step) {
    throw redirect(stepPath(view.event.slug, view.form.id, view.step));
  }
  if (view.step === "welcome") {
    throw redirect(`/submit/${view.event.slug}/${view.form.id}`);
  }

  return {
    view,
    def: context.def,
    draft: draftPayload(context.draft),
  };
}

/* ------------------------------------------------------------------ action */

type ActionData = {
  errors: Record<string, string>;
  message: string | null;
  magicLink: string | null;
  /**
   * Why the link above is on screen. A disposable demo Worker reveals it so a
   * judge can finish the signup that the console mailer would otherwise swallow
   * (`shouldRevealMagicLink`), and the caption has to say so — an unlabelled
   * link here would read as production behaviour.
   */
  magicLinkReveal: "dev" | "demo" | null;
  savedDraft: boolean;
};

const empty: ActionData = {
  errors: {},
  message: null,
  magicLink: null,
  magicLinkReveal: null,
  savedDraft: false,
};

/** Turn WS1a's issue list into the per-field map the inputs render from. */
function issuesToErrors(issues: ValidationIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key =
      issue.participantIndex !== undefined
        ? `p${issue.participantIndex}.${issue.fieldKey ?? issue.code}`
        : (issue.fieldKey ?? (issue.ruleId ? `__limit:${issue.ruleId}` : `__${issue.code}`));
    errors[key] ??= issue.message;
  }
  return errors;
}

export async function action({ request, params }: Route.ActionArgs) {
  const context = await loadSubmitContext({
    request,
    eventSlug: params.eventSlug,
    formId: params.formId,
  });

  // A form that closed between render and submit must not accept the write.
  if (context.closed) {
    throw redirect(`/submit/${context.event.slug}/${context.form.id}`);
  }

  const step = resolveStep({
    requested: params.step,
    signedIn: !!context.person,
    hasDraft: !!context.draft,
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "next");
  const next = (target: WizardStep) =>
    redirect(stepPath(context.event.slug, context.form.id, target));

  /* ── ② Account ─────────────────────────────────────────────────────────── */
  if (step === "account") {
    if (context.person) return next("submission");

    const name = String(formData.get("fullName") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const errors: Record<string, string> = {};
    if (!name) errors.fullName = "Enter your name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.email = "Enter a valid email address.";
    }
    if (Object.keys(errors).length) {
      return data<ActionData>({ ...empty, errors }, { status: 400 });
    }

    /**
     * A new address is not proof of a new identity: issuing a durable session
     * here lets the first visitor squat any mailbox that has not appeared in
     * Callboard yet. Every address therefore takes the same magic-link path.
     * The person/token rows may be created before verification, but only
     * /auth/verify can create the authenticated session.
     */
    const issued = await requestCfpSignup({
      request,
      email,
      eventId: context.event.id,
      fullName: name,
      redirectTo: stepPath(context.event.slug, context.form.id, "submission"),
    });
    const reveal = shouldRevealMagicLink();
    return data<ActionData>({
      ...empty,
      message: `We emailed a sign-in link to ${email}. Open it to verify your address and continue — it expires in 15 minutes.`,
      magicLink: reveal ? issued.url : null,
      // `isDemoMode()` is the stricter of the two, so it names the reveal
      // whenever it holds; a plain dev run falls through to "dev".
      magicLinkReveal: reveal ? (isDemoMode() ? "demo" : "dev") : null,
    });
  }

  // Everything past Account needs a signed-in owner and a draft to write into.
  if (!context.person) return next("account");

  await enforceRateLimit({
    scope: `cfp:${context.event.id}:${context.form.id}:write`,
    identifier: context.person.id,
    policy: RATE_LIMIT_POLICIES.cfpWrite,
  });

  const postedFile = formData.get("__videoFile");
  if (postedFile instanceof File && postedFile.size > 0) {
    await enforceRateLimit({
      scope: `cfp:${context.event.id}:upload`,
      identifier: context.person.id,
      policy: RATE_LIMIT_POLICIES.cfpUpload,
      message: "Too many submission files were uploaded. Please wait before trying again.",
    });
  }

  if (step === "review" && intent === "submit") {
    await enforceRateLimit({
      scope: `cfp:${context.event.id}:submit`,
      identifier: context.person.id,
      policy: RATE_LIMIT_POLICIES.cfpSubmit,
      message: "Too many submissions were attempted. Please wait before trying again.",
    });
  }

  if (context.limit.reached && !context.draft) {
    return data<ActionData>(
      { ...empty, errors: { __form: "Submission limit reached." } },
      { status: 400 },
    );
  }
  const draft =
    context.draft ??
    (await ensureDraft({
      event: context.event,
      form: context.form,
      def: context.def,
      person: context.person,
    }));

  /* ── ③ Submission ──────────────────────────────────────────────────────── */
  if (step === "submission") {
    const fields = readFieldAnswers(context.def, formData, draft.fields);
    const content = await readContentBlock({
      formData,
      previous: draft.content,
      event: context.event,
      draftId: draft.id,
      personId: context.person.id,
    });

    // The posted value is checked BEFORE it is stored: an id the form does not
    // accept never reaches the draft, so a later step cannot inherit it.
    const posted = formData.get(TRACK_KEY);
    const chosen = typeof posted === "string" ? posted : (draft.trackId ?? null);
    const track = checkEligibleTrack({
      eligibleTrackIds: context.def.eligibleTrackIds,
      chosen,
    });

    await saveDraft({
      draftId: draft.id,
      def: context.def,
      fields,
      participants: draft.participants,
      content: content.value,
      trackId: track.ok ? track.trackId : null,
    });

    if (intent === "save_draft") return data<ActionData>({ ...empty, savedDraft: true });

    const errors = validateSubmissionStep(context.def, fields, content.value);
    if (content.error) errors.__content = content.error;
    if (!track.ok) errors[TRACK_KEY] = track.error;
    if (Object.keys(errors).length) {
      return data<ActionData>({ ...empty, errors }, { status: 400 });
    }
    return next("participant");
  }

  /* ── ④ Participant ─────────────────────────────────────────────────────── */
  if (step === "participant") {
    let participants = readParticipantRows(context.def, formData);
    if (participants.length === 0) {
      participants = [primaryFromPerson(context.person, context.def)];
    }
    participants[0].isPrimary = true;

    if (intent === "add_participant") {
      participants.push({
        role: enabledRoles(context.def)[0]?.key ?? "speaker",
        firstName: "",
        lastName: "",
        email: "",
        bio: "",
        answers: {},
      });
    }
    // The row index rides on the button's own value — a hidden `index` input per
    // row would give `formData.get("index")` the FIRST row's number, not the
    // clicked one, and would always delete the wrong participant.
    if (intent.startsWith("remove_participant:")) {
      const index = Number(intent.split(":")[1]);
      if (Number.isInteger(index) && index > 0) participants.splice(index, 1);
    }

    await saveDraft({
      draftId: draft.id,
      def: context.def,
      fields: draft.fields,
      participants,
      content: draft.content,
      trackId: draft.trackId ?? null,
    });

    if (intent !== "next") {
      return data<ActionData>({ ...empty, savedDraft: intent === "save_draft" });
    }

    const live = checkParticipants({ def: context.def, participants });
    const result = validate(toFormAnswers(draft.fields, participants), context.def, {
      now: Date.now(),
    });
    const errors = issuesToErrors(
      result.issues.filter((issue) => issue.participantIndex !== undefined),
    );
    if (!live.ok) errors.__participants = live.errors.join(" ");
    if (Object.keys(errors).length) {
      return data<ActionData>({ ...empty, errors }, { status: 400 });
    }
    return next("review");
  }

  /* ── ⑤ Review ──────────────────────────────────────────────────────────── */
  if (step === "review" && intent === "submit") {
    const errors = validateSubmissionStep(context.def, draft.fields, draft.content);
    const live = checkParticipants({ def: context.def, participants: draft.participants });
    if (!live.ok) errors.__participants = live.errors.join(" ");
    const track = checkEligibleTrack({
      eligibleTrackIds: context.def.eligibleTrackIds,
      chosen: draft.trackId,
    });
    if (!track.ok) errors[TRACK_KEY] = track.error;
    if (Object.keys(errors).length) {
      return data<ActionData>({ ...empty, errors }, { status: 400 });
    }

    const result = await submitDraft({
      request,
      event: context.event,
      form: context.form,
      def: context.def,
      draft,
      submitter: context.person,
    });
    if (!result.ok) {
      // A closed form is a state the whole wizard has to re-render around; an
      // ineligible track is one answer, so it is reported as one answer's error
      // rather than bouncing the submitter to step ① with nothing explained.
      if (result.reason === "ineligible_track") {
        return data<ActionData>(
          { ...empty, errors: { [TRACK_KEY]: result.message } },
          { status: 400 },
        );
      }
      throw redirect(`/submit/${context.event.slug}/${context.form.id}`);
    }
    return redirect(
      `/submit/${context.event.slug}/${context.form.id}/success?s=${result.sessionId}`,
    );
  }

  return data<ActionData>(empty);
}

/* --------------------------------------------------------- action helpers */

/** Pull one value per submission-scope field out of the posted form data. */
function readFieldAnswers(
  def: FormDefinition,
  formData: FormData,
  previous: Record<string, AnswerValue>,
): Record<string, AnswerValue> {
  const answers: Record<string, AnswerValue> = { ...previous };
  for (const field of def.fields) {
    if (field.scope !== "submission") continue;
    const values = formData.getAll(field.key).filter((v) => typeof v === "string") as string[];
    if (values.length === 0) continue;
    answers[field.key] = field.type === "multiselect" ? values : values[0];
  }
  return answers;
}

async function readContentBlock(input: {
  formData: FormData;
  previous: DraftContent;
  event: Parameters<typeof storeSubmissionUpload>[0]["event"];
  draftId: string;
  personId: string;
}): Promise<{ value: DraftContent; error: string | null }> {
  const mode = String(input.formData.get("__contentMode") ?? input.previous.mode);
  const value: DraftContent = {
    ...EMPTY_CONTENT,
    ...input.previous,
    mode: mode === "video" ? "video" : "abstract",
    videoUrl: String(input.formData.get("__videoUrl") ?? input.previous.videoUrl ?? ""),
  };

  const file = input.formData.get("__videoFile");
  if (file instanceof File && file.size > 0) {
    const stored = await storeSubmissionUpload({
      event: input.event,
      draftId: input.draftId,
      personId: input.personId,
      file,
    });
    if (!stored.ok) return { value, error: stored.error };
    value.uploadKey = stored.key;
    value.uploadName = stored.filename;
    value.uploadSize = stored.size;
  }

  return { value, error: null };
}

/**
 * Server-side truth for the Submission step: WS1a's evaluator plus the
 * abstract-or-video rule. A video submission relaxes the prose requirement,
 * so the abstract field is marked optional for that pass only.
 */
function validateSubmissionStep(
  def: FormDefinition,
  fields: Record<string, AnswerValue>,
  content: DraftContent,
): Record<string, string> {
  const contentCheck = checkContent({
    allowed: "either",
    collectsAbstract: def.fields.some(
      (field) => field.scope === "submission" && ABSTRACT_KEYS.includes(field.key),
    ),
    mode: content.mode,
    abstract: ABSTRACT_KEYS.map((key) => textOf(fields[key])).find((t) => t.trim()) ?? "",
    videoUrl: content.videoUrl,
    uploadKey: content.uploadKey,
  });

  const effective: FormDefinition =
    contentCheck.mode === "video"
      ? {
          ...def,
          fields: def.fields.map((field) =>
            ABSTRACT_KEYS.includes(field.key) ? { ...field, required: false } : field,
          ),
        }
      : def;

  const result = validate(toFormAnswers(fields, []), effective, { now: Date.now() });
  const errors = issuesToErrors(
    // Participants are the NEXT step's problem; a role minimum must not block
    // the Submission step before the submitter has reached the roster.
    result.issues.filter((issue) => issue.participantIndex === undefined && !isRoleIssue(issue)),
  );
  if (contentCheck.error) errors.__content = contentCheck.error;
  return errors;
}

function isRoleIssue(issue: ValidationIssue): boolean {
  return (
    issue.code === "role_min" ||
    issue.code === "role_max" ||
    issue.code === "participants_max_total" ||
    issue.code === "participants_min_total"
  );
}

function readParticipantRows(def: FormDefinition, formData: FormData): DraftParticipant[] {
  const participantFields = def.fields.filter((field) => field.scope === "participant");
  const roleKeys = new Set(def.participants.roles.map((role) => role.key));
  const rows: DraftParticipant[] = [];

  for (let index = 0; ; index += 1) {
    const email = formData.get(`p${index}.email`);
    const first = formData.get(`p${index}.firstName`);
    if (email === null && first === null) break;

    const role = String(formData.get(`p${index}.role`) ?? "speaker");
    const answers: Record<string, AnswerValue> = {};
    for (const field of participantFields) {
      const values = formData
        .getAll(`p${index}.${field.key}`)
        .filter((v) => typeof v === "string") as string[];
      if (values.length) answers[field.key] = field.type === "multiselect" ? values : values[0];
    }

    rows.push({
      role: roleKeys.has(role) ? role : "speaker",
      firstName: String(first ?? "").trim(),
      lastName: String(formData.get(`p${index}.lastName`) ?? "").trim(),
      email: normalizeEmail(String(email ?? "")),
      bio: String(formData.get(`p${index}.bio`) ?? ""),
      isPrimary: index === 0,
      answers,
    });
  }
  return rows;
}

/* --------------------------------------------------------------- component */

export default function PublicSubmitStep({ loaderData, actionData }: Route.ComponentProps) {
  const { view } = loaderData;

  if (view.closed) {
    return (
      <ClosedNotice
        eventName={view.event.name}
        eventSlug={view.event.slug}
        formName={view.form.name}
        reason={view.closed}
      />
    );
  }
  if (view.limit.reached && !loaderData.draft) {
    return (
      <LimitReachedNotice
        eventName={view.event.name}
        formName={view.form.name}
        limit={view.limit.limit ?? 0}
      />
    );
  }

  return (
    <WizardShell
      eventName={view.event.name}
      eventSlug={view.event.slug}
      formId={view.form.id}
      formTitle={view.form.name}
      chrome={view.chrome}
      step={view.step}
    >
      {view.step === "account" ? (
        <AccountStep loaderData={loaderData} actionData={actionData} />
      ) : null}
      {view.step === "submission" ? (
        <SubmissionStep loaderData={loaderData} actionData={actionData} />
      ) : null}
      {view.step === "participant" ? (
        /*
         * `key` on the server-side row COUNT is load-bearing. Adding or removing
         * a participant round-trips through the action (so it works without
         * JavaScript), and the step's local state is seeded from loader data with
         * `useState` — which does not re-seed on revalidation. Without this key
         * the new row lands in the database and never appears on screen.
         * A remount is safe: the action saved every typed value before replying.
         */
        <ParticipantStep
          key={`participants-${loaderData.draft?.participants.length ?? 0}`}
          loaderData={loaderData}
          actionData={actionData}
        />
      ) : null}
      {view.step === "review" ? (
        <ReviewStep loaderData={loaderData} actionData={actionData} />
      ) : null}
    </WizardShell>
  );
}

type StepProps = {
  loaderData: Route.ComponentProps["loaderData"];
  actionData: Route.ComponentProps["actionData"];
};

/* ── ② Account ─────────────────────────────────────────────────────────── */

function AccountStep({ loaderData, actionData }: StepProps) {
  const { view } = loaderData;
  const errors = actionData?.errors ?? {};

  if (view.signedIn) {
    return (
      <Form method="post">
        <h2 className="mb-1 text-xl font-semibold">You&rsquo;re signed in</h2>
        <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
          Submitting as{" "}
          <strong data-testid="account-signed-in">
            {view.person?.fullName ?? view.person?.email}
          </strong>{" "}
          ({view.person?.email}).{" "}
          <Link to="/logout" className="underline">
            Not you?
          </Link>
        </p>
        <WizardFooter
          backTo={`/submit/${view.event.slug}/${view.form.id}`}
          submitLabel="Continue"
        />
      </Form>
    );
  }

  if (actionData?.message) {
    return (
      <div>
        <h2 className="mb-1 text-xl font-semibold">Check your email</h2>
        <p data-testid="account-magic-sent" className="text-sm text-gray-600 dark:text-gray-300">
          {actionData.message}
        </p>
        {actionData.magicLink ? (
          <div
            className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
            data-testid="account-magic-reveal"
            data-reveal-mode={actionData.magicLinkReveal ?? "dev"}
          >
            <p className="break-all">
              <span className="font-medium">
                {actionData.magicLinkReveal === "demo" ? "Demo mode:" : "Dev mode:"}
              </span>{" "}
              <a className="underline" href={actionData.magicLink} data-testid="account-dev-link">
                {actionData.magicLink}
              </a>
            </p>
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
              {actionData.magicLinkReveal === "demo"
                ? "Demo mode: this link would be emailed in production."
                : "Shown because this is a development build with no mail provider."}
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Form method="post">
      <h2 className="mb-1 text-xl font-semibold">Verify your email</h2>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
        We&rsquo;ll email a secure sign-in link. Open it to continue your submission; no
        password is required.
      </p>

      <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-800/50">
        <div className="mb-4">
          <label htmlFor="fullName" className="mb-1 block text-sm font-medium">
            Your name <span className="text-red-600">*</span>
          </label>
          <input
            id="fullName"
            name="fullName"
            autoComplete="name"
            required
            aria-invalid={errors.fullName ? true : undefined}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
          />
          {errors.fullName ? (
            <p data-testid="error-fullName" className="mt-1 text-sm text-red-600">
              {errors.fullName}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            Your email address <span className="text-red-600">*</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            aria-invalid={errors.email ? true : undefined}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
          />
          {errors.email ? (
            <p data-testid="error-email" className="mt-1 text-sm text-red-600">
              {errors.email}
            </p>
          ) : null}
        </div>
      </div>

      <WizardFooter
        backTo={`/submit/${view.event.slug}/${view.form.id}`}
        submitLabel="Email me a sign-in link"
      />
    </Form>
  );
}

/* ── ③ Submission ──────────────────────────────────────────────────────── */

function SubmissionStep({ loaderData, actionData }: StepProps) {
  const { view, def, draft } = loaderData;
  const [fields, setFields] = useState<Record<string, AnswerValue>>(draft?.fields ?? {});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"abstract" | "video">(draft?.content.mode ?? "abstract");
  const [trackChoice, setTrackChoice] = useState(draft?.trackId ?? "");

  const serverErrors = actionData?.errors ?? {};
  const answers = toFormAnswers(fields, []);
  const visible = visibleFields(answers, def);
  const states = fieldStates(answers, def, "submission");
  const counters = combinedCounters(answers, def).filter((c) => c.scope === "submission");

  // Live per-field validation: run the shared evaluator, then show a message
  // only for fields the submitter has actually touched (plus everything the
  // server rejected). Same rules, no premature red.
  const liveIssues = validate(answers, def, {}).issues;
  const liveByKey = new Map(
    liveIssues
      .filter((issue) => issue.participantIndex === undefined && issue.fieldKey)
      .map((issue) => [issue.fieldKey as string, issue.message]),
  );
  const liveTrack = checkEligibleTrack({
    eligibleTrackIds: def.eligibleTrackIds,
    chosen: trackChoice,
  });

  const update = (key: string, value: AnswerValue) => {
    setFields((current) => ({ ...current, [key]: value }));
    setTouched((current) => ({ ...current, [key]: true }));
  };

  const errorFor = (key: string): string | null => {
    if (mode === "video" && ABSTRACT_KEYS.includes(key)) return serverErrors[key] ?? null;
    const liveError =
      key === TRACK_KEY ? (liveTrack.ok ? undefined : liveTrack.error) : liveByKey.get(key);
    return resolveSubmissionError({
      key,
      mode,
      touched: touched[key] === true,
      liveError,
      serverError: serverErrors[key],
    });
  };

  const blocking = blockingSubmissionErrors(serverErrors, errorFor);
  const trackError = errorFor(TRACK_KEY);

  return (
    <Form method="post" encType="multipart/form-data" data-testid="submission-form">
      <h2 className="mb-1 text-xl font-semibold">{view.form.sectionTitle}</h2>
      <RichText body={view.form.sectionBody} />

      {actionData?.savedDraft ? (
        <p
          data-testid="draft-saved"
          className="my-5 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        >
          Draft saved. This page&rsquo;s link brings you straight back to it.
        </p>
      ) : (
        <div className="mb-5" />
      )}

      {def.fields.filter((f) => f.scope === "submission").length === 0 ? (
        <p
          data-testid="no-questions"
          className="mb-5 rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700"
        >
          This form has no questions yet — continue to add participants.
        </p>
      ) : null}

      {counters.map((counter) => (
        <CombinedCounterBox
          key={counter.ruleId}
          ruleId={counter.ruleId}
          label={counter.label}
          used={counter.used}
          max={counter.max}
          countedLabels={fieldLabels(counter.countedKeys, def.fields)}
        />
      ))}

      {visible.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={fields[field.key]}
          error={errorFor(field.key)}
          required={
            (states.get(field.key)?.required ?? false) &&
            !(mode === "video" && ABSTRACT_KEYS.includes(field.key))
          }
          onChange={(next) => update(field.key, next)}
        />
      ))}

      {view.eligibleTracks.length ? (
        <div className="mb-5">
          {/* "Programme track", not "Track". A form is free to ask its own
              question labelled Track — the seeded CFP does — and two controls
              with the same accessible name is both a confusing page and a
              Playwright strict-mode failure (design brief §6C). This one names
              what it actually binds to: the track on the programme. */}
          <label htmlFor={TRACK_KEY} className="mb-1 block text-sm font-medium">
            Programme track <span className="text-red-600">*</span>
          </label>
          <select
            id={TRACK_KEY}
            name={TRACK_KEY}
            value={trackChoice}
            onChange={(event) => {
              setTrackChoice(event.target.value);
              setTouched((current) => ({ ...current, [TRACK_KEY]: true }));
            }}
            aria-invalid={trackError ? true : undefined}
            data-testid="track-select"
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="">Choose a track…</option>
            {view.eligibleTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
          {trackError ? (
            <p data-testid="error-track" className="mt-1 text-sm text-red-600">
              {trackError}
            </p>
          ) : null}
        </div>
      ) : null}

      <fieldset className="mb-5 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium">Submission format</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(["abstract", "video"] as const).map((option) => (
            <label key={option} className="flex items-center gap-2">
              <input
                type="radio"
                name="__contentMode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                data-testid={`content-mode-${option}`}
              />
              {option === "abstract" ? "Written abstract" : "Video"}
            </label>
          ))}
        </div>

        {mode === "video" ? (
          <div className="mt-4">
            <label htmlFor="__videoUrl" className="mb-1 block text-sm font-medium">
              Video link
            </label>
            <input
              id="__videoUrl"
              name="__videoUrl"
              type="url"
              inputMode="url"
              placeholder="https://"
              defaultValue={draft?.content.videoUrl ?? ""}
              className="mb-3 w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
            />
            <label htmlFor="__videoFile" className="mb-1 block text-sm font-medium">
              …or upload a file (25 MB max)
            </label>
            <input id="__videoFile" name="__videoFile" type="file" className="text-sm" />
            {draft?.content.uploadName ? (
              <p data-testid="upload-name" className="mt-2 text-xs text-gray-500">
                Attached: {draft.content.uploadName}
              </p>
            ) : null}
          </div>
        ) : null}

        {serverErrors.__content ? (
          <p data-testid="error-content" className="mt-2 text-sm text-red-600">
            {serverErrors.__content}
          </p>
        ) : null}
      </fieldset>

      {Object.entries(serverErrors)
        .filter(([key]) => key.startsWith("__limit:"))
        .map(([key, message]) => (
          <p key={key} data-testid="error-limit" className="mb-3 text-sm text-red-600">
            {message}
          </p>
        ))}

      <WizardFooter
        backTo={stepPath(view.event.slug, view.form.id, "account")}
        submitLabel="Next"
        secondary={
          <button
            type="submit"
            name="intent"
            value="save_draft"
            formNoValidate
            data-testid="save-draft"
            className="text-sm text-gray-600 underline dark:text-gray-300"
          >
            Save draft
          </button>
        }
      />
      <input type="hidden" name="intent" value="next" />

      {blocking.length > 0 ? (
        <ErrorToast
          title="Missing required information"
          body="Complete all marked fields before continuing."
        />
      ) : null}
    </Form>
  );
}

/* ── ④ Participant ─────────────────────────────────────────────────────── */

function ParticipantStep({ loaderData, actionData }: StepProps) {
  const { view, def, draft } = loaderData;
  const roles = enabledRoles(def);
  const participantFields = def.fields.filter((field) => field.scope === "participant");

  const initial: DraftParticipant[] = draft?.participants?.length
    ? draft.participants
    : [
        {
          role: roles[0]?.key ?? "speaker",
          firstName: view.person?.firstName ?? "",
          lastName: view.person?.lastName ?? "",
          email: view.person?.email ?? "",
          bio: "",
          isPrimary: true,
          answers: {},
        },
      ];
  const [rows, setRows] = useState<DraftParticipant[]>(initial);

  const check = checkParticipants({ def, participants: rows });
  const serverError = actionData?.errors.__participants
    ? check.ok
      ? null
      : check.errors.join(" ")
    : null;

  const patch = (index: number, key: keyof DraftParticipant, value: string) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    );
  const patchAnswer = (index: number, key: string, value: AnswerValue) =>
    setRows((current) =>
      current.map((row, i) =>
        i === index ? { ...row, answers: { ...(row.answers ?? {}), [key]: value } } : row,
      ),
    );

  return (
    <Form method="post" data-testid="participant-form">
      <h2 className="mb-1 text-xl font-semibold">{view.form.sectionTitle}</h2>
      <RichText body={view.form.sectionBody} />

      {/*
       * Same confirmation as the Submission step (line ~776). Without it the
       * "Save draft" click here has zero visible effect — the POST succeeds
       * and the draft persists, but a reviewer watching the screen sees no
       * change at all and reasonably reads the button as broken/unclickable.
       * The other three intents on this step (Next, Add participant, Remove
       * participant) all produce a visible change; this one has to too.
       */}
      {actionData?.savedDraft ? (
        <p
          data-testid="draft-saved"
          className="my-5 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        >
          Draft saved. This page&rsquo;s link brings you straight back to it.
        </p>
      ) : (
        <div className="mb-5" />
      )}

      <div
        data-testid="participant-requirements"
        className="my-5 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
      >
        <p className="mb-1 font-semibold">Participant requirements</p>
        {check.roles.map((role) => (
          <p
            key={role.role}
            data-testid={`role-indicator-${role.role}`}
            data-satisfied={role.satisfied ? "true" : "false"}
            className={role.satisfied ? "text-gray-600 dark:text-gray-300" : "text-red-600"}
          >
            {role.satisfied ? "✓" : "⊘"} {role.indicator}
          </p>
        ))}
        {check.maxTotal ? (
          <p className="mt-1 text-xs text-gray-500">
            {check.total} of {check.maxTotal} participants total.
          </p>
        ) : null}
      </div>

      {rows.map((row, index) => {
        const roleState = check.roles.find((entry) => entry.role === row.role);
        return (
          <fieldset
            key={index}
            data-testid={`participant-row-${index}`}
            className="mb-5 rounded-lg border border-gray-200 p-4 dark:border-gray-800"
          >
            <legend className="flex items-center gap-2 px-1 text-sm font-medium">
              Participant {index + 1} of {rows.length}
              {index === 0 ? (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  primary contact
                </span>
              ) : null}
            </legend>

            <label className="mb-1 block text-sm font-medium" htmlFor={`p${index}.role`}>
              Role for this participant
            </label>
            <select
              id={`p${index}.role`}
              name={`p${index}.role`}
              value={row.role}
              onChange={(event) => patch(index, "role", event.target.value)}
              className="mb-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
            >
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.label}
                </option>
              ))}
            </select>
            {roleState?.hint ? (
              <p
                data-testid={`role-hint-${row.role}`}
                className="mb-3 text-sm font-medium text-red-600"
              >
                {roleState.hint}
              </p>
            ) : (
              <div className="mb-3" />
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <TextRow
                label="First Name"
                name={`p${index}.firstName`}
                value={row.firstName}
                onChange={(value) => patch(index, "firstName", value)}
              />
              <TextRow
                label="Last Name"
                name={`p${index}.lastName`}
                value={row.lastName}
                onChange={(value) => patch(index, "lastName", value)}
              />
            </div>
            <TextRow
              label="Email"
              name={`p${index}.email`}
              type="email"
              value={row.email}
              readOnly={index === 0}
              onChange={(value) => patch(index, "email", value)}
            />
            <label className="mt-3 mb-1 block text-sm font-medium" htmlFor={`p${index}.bio`}>
              Biography
            </label>
            <textarea
              id={`p${index}.bio`}
              name={`p${index}.bio`}
              rows={3}
              value={row.bio ?? ""}
              onChange={(event) => patch(index, "bio", event.target.value)}
              className="mb-4 w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900"
            />

            {participantFields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                namePrefix={`p${index}.`}
                value={row.answers?.[field.key]}
                error={actionData?.errors[`p${index}.${field.key}`] ?? null}
                required={field.required}
                onChange={(next) => patchAnswer(index, field.key, next)}
              />
            ))}

            {index > 0 ? (
              <button
                type="submit"
                name="intent"
                value={`remove_participant:${index}`}
                formNoValidate
                data-testid={`remove-participant-${index}`}
                className="text-sm text-red-600 underline"
              >
                Remove this participant
              </button>
            ) : null}
          </fieldset>
        );
      })}

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {check.total} participant{check.total === 1 ? "" : "s"} added
        </p>
        <button
          type="submit"
          name="intent"
          value="add_participant"
          formNoValidate
          disabled={!canAddParticipant(check)}
          data-testid="add-participant"
          className="rounded-full border border-gray-300 px-4 py-1.5 text-sm disabled:opacity-40 dark:border-gray-700"
        >
          + Add participant
        </button>
      </div>

      {serverError ? (
        <p data-testid="error-participants" className="mb-3 text-sm text-red-600">
          {serverError}
        </p>
      ) : null}

      <WizardFooter
        backTo={stepPath(view.event.slug, view.form.id, "submission")}
        submitLabel="Next"
        secondary={
          <button
            type="submit"
            name="intent"
            value="save_draft"
            formNoValidate
            data-testid="save-draft"
            className="text-sm text-gray-600 underline dark:text-gray-300"
          >
            Save draft
          </button>
        }
      />
      <input type="hidden" name="intent" value="next" />

      {serverError ? (
        <ErrorToast
          title="Participant requirements not met"
          body="Fix the highlighted roles before continuing."
        />
      ) : null}
    </Form>
  );
}

function TextRow({
  label,
  name,
  value,
  onChange,
  type = "text",
  readOnly = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  readOnly?: boolean;
}) {
  return (
    <div className="mt-3 sm:mt-0">
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label} <span className="text-red-600">*</span>
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base read-only:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:read-only:bg-gray-800"
      />
    </div>
  );
}

/* ── ⑤ Review ──────────────────────────────────────────────────────────── */

function ReviewStep({ loaderData, actionData }: StepProps) {
  const { view, def, draft } = loaderData;
  const fields = draft?.fields ?? {};
  const participants = draft?.participants ?? [];
  const visible = visibleFields(toFormAnswers(fields, participants), def);
  const participantFields = def.fields.filter((field) => field.scope === "participant");
  const serverErrors = actionData?.errors ?? {};
  const content = draft?.content ?? EMPTY_CONTENT;

  const editSubmission = stepPath(view.event.slug, view.form.id, "submission");
  const editParticipant = stepPath(view.event.slug, view.form.id, "participant");

  return (
    <Form method="post" data-testid="review-form">
      <h2 className="mb-1 text-xl font-semibold">Review and submit</h2>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
        Check everything below. You can edit any section before submitting.
      </p>

      <SummaryHeader title="Submission" editTo={editSubmission} />
      <dl className="mb-6 divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {visible.map((field) => (
          <div key={field.key} className="grid gap-1 py-3 sm:grid-cols-3">
            <dt className="text-sm font-medium text-gray-600 dark:text-gray-300">
              {field.label}
            </dt>
            <dd
              data-testid={`review-${field.key}`}
              className="text-sm whitespace-pre-wrap sm:col-span-2"
            >
              {textOf(fields[field.key], field.type) || (
                <span className="text-gray-500 dark:text-gray-400">Not answered</span>
              )}
            </dd>
          </div>
        ))}
        {view.eligibleTracks.length ? (
          <div className="grid gap-1 py-3 sm:grid-cols-3">
            <dt className="text-sm font-medium text-gray-600 dark:text-gray-300">
              Programme track
            </dt>
            <dd data-testid="review-track" className="text-sm sm:col-span-2">
              {view.eligibleTracks.find((track) => track.id === draft?.trackId)?.name ?? (
                <span className="text-gray-500 dark:text-gray-400">Not answered</span>
              )}
            </dd>
          </div>
        ) : null}
        {/* "Submission type", not "Format": a form that asks its own Format
            question (Talk / Workshop) already renders a Format row above, and
            two rows with the same label reads as a bug. */}
        <div className="grid gap-1 py-3 sm:grid-cols-3">
          <dt className="text-sm font-medium text-gray-600 dark:text-gray-300">
            Submission type
          </dt>
          <dd data-testid="review-content" className="text-sm sm:col-span-2">
            {content.mode === "video"
              ? `Video — ${content.videoUrl || content.uploadName || "attached"}`
              : "Written abstract"}
          </dd>
        </div>
      </dl>

      <SummaryHeader title="Participants" editTo={editParticipant} />
      <ul className="mb-6 divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-800 dark:border-gray-800">
        {participants.map((participant, index) => (
          <li key={index} className="py-3 text-sm" data-testid={`review-participant-${index}`}>
            <span className="font-medium">
              {participant.firstName} {participant.lastName}
            </span>{" "}
            <span className="text-gray-500">
              ·{" "}
              {def.participants.roles.find((role) => role.key === participant.role)?.label ??
                participant.role}{" "}
              · {participant.email}
            </span>

            {/* Everything the wizard COLLECTED for this participant is shown
                back. A biography typed two steps ago that never reappears on
                Review looks like it was thrown away. */}
            {participant.bio?.trim() ? (
              <div className="mt-2">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                  Biography
                </p>
                <p
                  data-testid={`review-participant-${index}-bio`}
                  className="text-sm whitespace-pre-wrap text-gray-600 dark:text-gray-300"
                >
                  {participant.bio}
                </p>
              </div>
            ) : null}

            {participantFields.map((field) => {
              const answer = textOf(participant.answers?.[field.key], field.type);
              if (!answer) return null;
              return (
                <div key={field.key} className="mt-2">
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                    {field.label}
                  </p>
                  <p
                    data-testid={`review-participant-${index}-${field.key}`}
                    className="text-sm whitespace-pre-wrap text-gray-600 dark:text-gray-300"
                  >
                    {answer}
                  </p>
                </div>
              );
            })}
          </li>
        ))}
      </ul>

      {Object.entries(serverErrors).map(([key, message]) => (
        <p key={key} data-testid="review-error" className="mb-3 text-sm text-red-600">
          {message}
        </p>
      ))}

      <WizardFooter
        backTo={editParticipant}
        submitLabel="Submit"
        secondary={
          view.limit.limit ? (
            <span className="text-xs text-gray-500">
              {view.limit.used} of {view.limit.limit} used
            </span>
          ) : null
        }
      />
      <input type="hidden" name="intent" value="submit" />
    </Form>
  );
}

function SummaryHeader({ title, editTo }: { title: string; editTo: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between">
      <h3 className="text-sm font-semibold tracking-wide uppercase">{title}</h3>
      <Link
        to={editTo}
        data-testid={`edit-${title.toLowerCase()}`}
        className="text-sm text-blue-600 underline dark:text-blue-400"
      >
        Edit
      </Link>
    </div>
  );
}
