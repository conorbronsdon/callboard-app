/**
 * Public-wizard chrome: the 5-step indicator and the computed info panel.
 *
 * Pure SSR — no state, no effects, no client JS. At 375px the stepper wraps to
 * two rows instead of scrolling sideways; the arrows are decorative and hidden
 * from assistive tech.
 */
import { Link } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import {
  WIZARD_STEPS,
  stepIndex,
  stepPath,
  type WizardStep,
} from "~/lib/public-submit/wizard";

export function Stepper({
  current,
  labels,
  eventSlug,
  formId,
  furthest,
}: {
  current: WizardStep;
  labels: Record<WizardStep, string>;
  eventSlug: string;
  formId: string;
  /** Highest step reached — earlier steps stay clickable, later ones do not. */
  furthest: WizardStep;
}) {
  const currentIndex = stepIndex(current);
  const furthestIndex = stepIndex(furthest);

  return (
    <ol
      aria-label="Submission steps"
      className="mb-5 flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-xs"
    >
      {WIZARD_STEPS.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        const reachable = index <= furthestIndex && !active;

        const circle = [
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
          done
            ? "border-green-600 bg-green-600 text-white"
            : active
              ? "border-blue-600 text-blue-700 ring-2 ring-blue-200 dark:text-blue-300 dark:ring-blue-900"
              : "border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400",
        ].join(" ");

        const label = [
          "whitespace-nowrap",
          active
            ? "font-semibold text-blue-700 dark:text-blue-300"
            : "text-gray-500 dark:text-gray-400",
        ].join(" ");

        const body = (
          <span className="flex items-center gap-1.5">
            <span className={circle} aria-hidden="true">
              {done ? "✓" : index + 1}
            </span>
            <span className={label}>{labels[step]}</span>
          </span>
        );

        return (
          <li key={step} className="flex items-center gap-1">
            {reachable ? (
              <Link
                to={stepPath(eventSlug, formId, step)}
                data-step-link={step}
                aria-label={`Step ${index + 1}: ${labels[step]}`}
              >
                {body}
              </Link>
            ) : (
              <span
                data-step={step}
                aria-current={active ? "step" : undefined}
                aria-label={`Step ${index + 1}: ${labels[step]}`}
              >
                {body}
              </span>
            )}
            {index < WIZARD_STEPS.length - 1 ? (
              <span aria-hidden="true" className="px-0.5 text-gray-300 dark:text-gray-600">
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The bordered panel under the stepper on every step: close date in the event
 * timezone and the effective per-user submission limit (screenshot p15_1).
 * Renders nothing when the form sets neither — no empty box.
 */
export function FormInfoPanel({
  closeSentence,
  limitSentence,
}: {
  closeSentence: string | null;
  limitSentence: string | null;
}) {
  if (!closeSentence && !limitSentence) return null;
  return (
    <div
      data-testid="form-info"
      className="mb-6 rounded-lg border border-gray-200 px-4 py-3 text-center text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300"
    >
      {closeSentence ? <p>{closeSentence}</p> : null}
      {limitSentence ? <p>{limitSentence}</p> : null}
    </div>
  );
}

/*
 * The wizard's forward control, from the shared helper rather than a private
 * pill. It was the same blue as `buttonClass("primary")` by coincidence, with
 * its own radius, padding and weight — so the button a submitter clicks five
 * times in a row was one of four in the product that would not move when the
 * helper moved. The visible change is the radius: `rounded-full` → the shared
 * `rounded-lg`, which is what every other primary in the product already is.
 */
const NEXT_BUTTON = buttonClass("primary");

/**
 * Wizard footer. `Back` is a plain link. The primary control submits the
 * enclosing form, unless `nextTo` is given — then it is a link, so a step with
 * nothing to save (Welcome) costs no round trip.
 */
export function WizardFooter({
  backTo,
  submitLabel,
  secondary,
  nextTo,
}: {
  backTo: string | null;
  submitLabel: string;
  secondary?: React.ReactNode;
  nextTo?: string;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-5 dark:border-gray-800">
      {backTo ? (
        <Link
          to={backTo}
          data-testid="wizard-back"
          className="text-sm text-gray-600 underline dark:text-gray-300"
        >
          Back
        </Link>
      ) : null}
      <div className="ml-auto flex items-center gap-3">
        {secondary}
        {nextTo ? (
          <Link to={nextTo} data-testid="wizard-next" className={NEXT_BUTTON}>
            {submitLabel}
          </Link>
        ) : (
          <button type="submit" data-testid="wizard-next" className={NEXT_BUTTON}>
            {submitLabel}
          </button>
        )}
      </div>
    </div>
  );
}
