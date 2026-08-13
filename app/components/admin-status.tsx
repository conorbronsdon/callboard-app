/**
 * The abstract status pill and its inline editor (screenshots p19_1).
 *
 * Extracted from `admin.submissions.tsx` so the abstracts TABLE and the abstract
 * DETAIL page share one implementation. "Same popover/save semantics" is only
 * true if it is the same component — two copies would drift the first time one
 * of them grew a status.
 *
 * Deliberately router-free: a plain `<details>` and a plain `<form method="post">`,
 * so both screens work with zero client JS and both render under
 * `renderToStaticMarkup` in tests without router context.
 *
 * Nothing is written until Save. Cancel resets the radio group to the row's
 * current status (and closes the popover when JS is on), so a mis-click never
 * commits a review decision.
 */
import { buttonClass } from "~/components/portal-ui";
import { ADMIN_ASSIGNABLE_STATUSES, tabFor } from "~/lib/review/pipeline";
import type { SessionStatus } from "~/db/schema";

const BUTTON = buttonClass("primary");
const GHOST_BUTTON = buttonClass("secondary");

export function StatusPill({ status }: { status: SessionStatus }) {
  const tab = tabFor(status);
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tab.tone}`}>{tab.label}</span>
  );
}

export function StatusCell({
  sessionId,
  status,
  tab,
  trackId,
  returnTo,
}: {
  sessionId: string;
  status: SessionStatus;
  /** The tab the caller is filtered to — preserved across the redirect. */
  tab: SessionStatus;
  trackId: string | null;
  /** Where the action should send the admin back to. Omit for the list page. */
  returnTo?: string;
}) {
  /*
   * IN NORMAL FLOW, deliberately (measured, not assumed — polish lane):
   * the abstracts table scrolls inside an `overflow-x-auto` wrapper, which
   * crops an `absolute` panel to a ~40px sliver; `fixed` escapes the crop but
   * is not offset by the wrapper's horizontal scroll and landed ~700px
   * off-screen at 375px. An in-flow panel expands its row instead — nothing
   * can clip it and it travels with its cell at every width.
   */
  return (
    <details className="w-max">
      <summary
        aria-label={`Change status (currently ${tabFor(status).label})`}
        className="inline-flex cursor-pointer list-none items-center gap-2"
      >
        <StatusPill status={status} />
        {/*
          No `aria-label` here: the `<summary>` above already carries one, and
          an accessible name on an ancestor replaces the whole subtree for
          assistive tech. A second label on this span is dead weight that reads
          as a second control in the markup without ever being announced.
        */}
        <span className="text-xs text-gray-500 dark:text-gray-400">Change</span>
        <span
          data-status-disclosure
          aria-hidden="true"
          className="text-xs text-gray-400 dark:text-gray-500"
        >
          ▾
        </span>
      </summary>
      <form
        method="post"
        data-testid={`status-popover-${sessionId}`}
        className="mt-2 w-56 max-w-[calc(100vw-3rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        <input type="hidden" name="intent" value="set-status" />
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="tab" value={tab} />
        {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}

        <p className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">Status</p>
        <div className="space-y-1">
          {ADMIN_ASSIGNABLE_STATUSES.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input type="radio" name="status" value={option} defaultChecked={option === status} />
              <StatusPill status={option} />
            </label>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="reset"
            className={GHOST_BUTTON}
            // Progressive enhancement: reset always works, closing needs JS.
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Cancel
          </button>
          <button type="submit" className={BUTTON}>
            Save
          </button>
        </div>
      </form>
    </details>
  );
}
