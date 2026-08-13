import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass } from "~/components/shell";
import type { EventSetupChecklist } from "~/lib/programme-readiness";

const STEP_STATUS_STYLES = {
  done:
    "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-600/20 ring-inset dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-400/30",
  pending:
    "bg-gray-100 text-gray-700 ring-1 ring-gray-500/20 ring-inset dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-400/30",
};

function ChecklistSteps({ checklist }: { checklist: EventSetupChecklist }) {
  return (
    <ol className="grid gap-3 md:grid-cols-2">
      {checklist.steps.map((step, index) => {
        const isNext = step.id === checklist.nextStepId;
        return (
          <li
            key={step.id}
            className={`flex min-w-0 flex-col rounded-lg border border-gray-200 border-l-4 p-4 dark:border-gray-800 ${
              isNext
                ? "border-l-amber-500 bg-amber-50/60 ring-2 ring-amber-500/20 dark:border-l-amber-400 dark:bg-amber-950/20 dark:ring-amber-400/30"
                : step.done
                  ? "border-l-emerald-500 bg-gray-50/60 dark:border-l-emerald-400 dark:bg-gray-950/40"
                  : "border-l-gray-300 bg-gray-50/60 dark:border-l-gray-600 dark:bg-gray-950/40"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">
                <span className="mr-2 text-gray-400 tabular-nums dark:text-gray-500" aria-hidden="true">
                  {index + 1}.
                </span>
                {step.title}
              </h3>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  step.done ? STEP_STATUS_STYLES.done : STEP_STATUS_STYLES.pending
                }`}
              >
                {step.done ? "Done" : "Not yet"}
              </span>
            </div>
            {isNext ? (
              <p className="mt-2">
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-600/20 ring-inset dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-400/30">
                  Start here
                </span>
              </p>
            ) : null}
            <p className="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-200">
              {step.description}
            </p>
            <div className="mt-auto pt-4">
              <a href={step.to} className={`min-h-11 ${buttonClass("secondary")}`}>
                {step.actionLabel}
              </a>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function EventSetupChecklistPanel({
  checklist,
}: {
  checklist: EventSetupChecklist;
}) {
  if (checklist.allDone) {
    return (
      <section
        className="rounded-2xl border border-gray-200 bg-white shadow-card dark:border-gray-800 dark:bg-gray-900"
      >
        {/*
         * No `aria-labelledby` here: it would give this <section> an
         * implicit ARIA "region" role whose accessible name is "Set up your
         * event" — which collides with Playwright's `getByLabel("Event")`
         * substring match against the event switcher in admin.layout.tsx
         * (organizer-nav-reach.spec.ts), a fixture this lane does not own.
         * The <h2> below still gives screen-reader heading navigation the
         * same information; it just isn't bound as a landmark name.
         */}
        <h2 className="sr-only">Set up your event</h2>
        <details>
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 sm:px-5 dark:text-gray-300 dark:hover:bg-gray-800/60">
            <span aria-hidden="true">✓</span> Your event is live
          </summary>
          <div className="border-t border-gray-200 p-4 sm:p-5 dark:border-gray-800">
            <ChecklistSteps checklist={checklist} />
          </div>
        </details>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-card sm:p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      {/* See the aria-labelledby comment in the allDone branch above: this
       * section deliberately has no bound accessible name. */}
      <p className={eyebrowClass}>Organizer checklist</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight">Set up your event</h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-300">
        Follow the journey in order, or jump ahead to anything you have already started.
      </p>
      <div className="mt-5">
        <ChecklistSteps checklist={checklist} />
      </div>
    </section>
  );
}
