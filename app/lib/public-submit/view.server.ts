/**
 * Loader shaping shared by the three public-wizard routes.
 *
 * The wizard chrome (stepper labels, close-date sentence, submission-limit
 * sentence) is identical on every step, so it is built once here rather than
 * three times in three routes that could drift apart.
 */
import { loadSubmitContext, type DraftView, type SubmitContext } from "./draft.server";
import {
  closeDateSentence,
  resolveStep,
  stepLabels,
  submissionLimitSentence,
  type ClosedReason,
  type LimitCheck,
  type WizardChrome,
  type WizardStep,
} from "./wizard";

export type { WizardChrome };

export interface WizardView {
  event: { name: string; slug: string; timezone: string };
  form: {
    id: string;
    name: string;
    target: string;
    welcomeTitle: string | null;
    welcomeBody: string | null;
    /** Section title + intro for the step being rendered (WS1a StepCopy). */
    sectionTitle: string;
    sectionBody: string;
    successMessage: string;
    autoRedirectToPortal: boolean;
  };
  chrome: WizardChrome;
  /** Tracks the submitter may choose from. Empty = no picker on this form. */
  eligibleTracks: { id: string; name: string }[];
  limit: LimitCheck;
  closed: ClosedReason;
  signedIn: boolean;
  person: {
    email: string;
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  step: WizardStep;
}

function furthestStep(signedIn: boolean, hasDraft: boolean): WizardStep {
  if (!signedIn) return "account";
  return hasDraft ? "review" : "submission";
}

export function buildView(context: SubmitContext, requestedStep: string | undefined): WizardView {
  const step = resolveStep({
    requested: requestedStep,
    signedIn: !!context.person,
    hasDraft: !!context.draft,
  });
  const settings = context.def.settings;
  const copy =
    step === "participant"
      ? settings.participant
      : step === "submission"
        ? settings.abstract
        : settings.welcome;

  return {
    event: {
      name: context.event.name,
      slug: context.event.slug,
      timezone: context.event.timezone,
    },
    form: {
      id: context.form.id,
      name: context.form.name,
      target: context.form.target,
      welcomeTitle: context.form.welcomeTitle ?? settings.welcome.title ?? null,
      welcomeBody: context.form.welcomeBody ?? settings.welcome.body ?? null,
      sectionTitle: copy.title,
      sectionBody: copy.body,
      successMessage: context.form.thankYouBody ?? settings.successMessage,
      autoRedirectToPortal: settings.autoRedirectToPortal,
    },
    chrome: {
      labels: stepLabels(settings),
      closeSentence: closeDateSentence(context.def.closesAt, context.event.timezone),
      limitSentence: submissionLimitSentence(context.limit),
      furthest: furthestStep(!!context.person, !!context.draft),
    },
    eligibleTracks: context.eligibleTracks,
    limit: context.limit,
    closed: context.closed,
    signedIn: !!context.person,
    person: context.person
      ? {
          email: context.person.email,
          fullName: context.person.fullName,
          firstName: context.person.firstName,
          lastName: context.person.lastName,
        }
      : null,
    step,
  };
}

/** Loader entry point: resolve the form, then shape it for the step being rendered. */
export async function loadWizardView(input: {
  request: Request;
  eventSlug: string;
  formId: string;
  requestedStep?: string;
}): Promise<{ context: SubmitContext; view: WizardView }> {
  const context = await loadSubmitContext(input);
  return { context, view: buildView(context, input.requestedStep) };
}

/** Serialisable draft payload for the client-side live layer. */
export function draftPayload(draft: DraftView | null) {
  if (!draft) return null;
  return {
    id: draft.id,
    title: draft.title,
    fields: draft.fields,
    participants: draft.participants,
    content: draft.content,
    trackId: draft.trackId ?? null,
  };
}
