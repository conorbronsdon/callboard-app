/**
 * The public wizard's page frame: centred card, stepper, info panel.
 * Mobile-first — a single column that only gains width past `sm`.
 */
import { Link } from "react-router";

import { eyebrowClass } from "~/components/shell";
import type { WizardChrome, WizardStep } from "~/lib/public-submit/wizard";

import { FormInfoPanel, Stepper } from "./stepper";

export function WizardShell({
  eventName,
  eventSlug,
  formId,
  formTitle,
  chrome,
  step,
  children,
}: {
  eventName: string;
  eventSlug: string;
  formId: string;
  formTitle: string;
  chrome: WizardChrome;
  step: WizardStep;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 px-3 py-6 text-gray-900 sm:px-4 sm:py-10 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto w-full max-w-2xl">
        <p className={`mb-4 text-center ${eyebrowClass} tracking-wide`}>{eventName}</p>
        <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-8 dark:border-gray-800 dark:bg-gray-900">
          <Stepper
            current={step}
            labels={chrome.labels}
            eventSlug={eventSlug}
            formId={formId}
            furthest={chrome.furthest}
          />
          <FormInfoPanel
            closeSentence={chrome.closeSentence}
            limitSentence={chrome.limitSentence}
          />
          <h1 className="sr-only">{formTitle}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">
          Powered by <Link to="/" className="underline">callboard</Link>
        </p>
      </div>
    </div>
  );
}

/** Bare frame for the terminal states (closed / limit reached) — no stepper. */
export function NoticeShell({
  eventName,
  title,
  children,
}: {
  eventName: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 px-3 py-10 text-gray-900 sm:px-4 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto w-full max-w-xl">
        <p className={`mb-4 text-center ${eyebrowClass} tracking-wide`}>{eventName}</p>
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center sm:p-8 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="mb-3 text-xl font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Clean closed page — never a broken form, never a 404. The close date is
 * brief-annotated "kinda impt"; a closed form that still renders inputs reads as
 * a bug, and one that 404s reads as a dead link.
 *
 * `no_eligible_tracks` reuses this page rather than getting its own: from the
 * submitter's side it is the same fact — the form is not taking submissions —
 * and the alternative was the state it replaces, a form that rendered every
 * input, accepted them, and returned a 400 with nothing on the page.
 */
export function ClosedNotice({
  eventName,
  eventSlug,
  formName,
  reason,
}: {
  eventName: string;
  eventSlug: string;
  formName: string;
  reason: "not_open" | "past_close_date" | "no_eligible_tracks";
}) {
  return (
    <NoticeShell
      eventName={eventName}
      title={reason === "no_eligible_tracks" ? "This call is not open" : "This call is closed"}
    >
      <p data-testid="closed-notice" className="text-sm text-gray-600 dark:text-gray-300">
        {reason === "past_close_date"
          ? `${formName} stopped accepting submissions on its close date.`
          : reason === "no_eligible_tracks"
            ? // Honest about whose problem it is. A submitter cannot pick a
              // track that no longer exists, so "try again" would be a lie —
              // only the organisers can reopen this one.
              `${formName} accepts only tracks that no longer exist, so nobody can submit to it. Let the organisers know if you were expecting to.`
            : `${formName} is not accepting submissions right now.`}
      </p>
      <p className="mt-4 text-sm">
        <Link to={`/e/${eventSlug}`} className="underline">
          Back to {eventName}
        </Link>
      </p>
    </NoticeShell>
  );
}

/** Per-user submission cap reached (screenshot p13_2 — two-level limit). */
export function LimitReachedNotice({
  eventName,
  formName,
  limit,
}: {
  eventName: string;
  formName: string;
  limit: number;
}) {
  return (
    <NoticeShell eventName={eventName} title="Submission limit reached">
      <p data-testid="limit-reached" className="text-sm text-gray-600 dark:text-gray-300">
        {formName} allows {limit} submission{limit === 1 ? "" : "s"} per person, including
        saved drafts. You have used them all.
      </p>
      <p className="mt-4 text-sm">
        <Link to="/portal" className="underline">
          View your submissions in the speaker portal
        </Link>
      </p>
    </NoticeShell>
  );
}

/** Escaped paragraph fallback for admin copy that contains no markup. */
const richTextClass =
  "space-y-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300";

export function RichText({ body }: { body: string | null }) {
  if (!body?.trim()) return null;
  return (
    <div className={richTextClass}>
      {body
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
    </div>
  );
}

/** Render only HTML that a server loader has already passed through the allowlist. */
export function SanitizedRichText({
  body,
  sanitizedHtml,
}: {
  body: string | null;
  sanitizedHtml: string | null;
}) {
  if (sanitizedHtml) {
    return (
      <div
        className={richTextClass}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }
  return <RichText body={body} />;
}
