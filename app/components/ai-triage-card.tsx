/**
 * The "AI triage" card on an abstract's drill-in (ABS-14).
 *
 * Router-free markup like the rest of `admin.submission.tsx` — plain
 * `<form method="post">` — so the page still renders under
 * `renderToStaticMarkup` with no router context and the render tests stay real
 * page renders.
 *
 * Four states, and every one of them is visible:
 *   · an opinion            — score, recommendation, reasoning, model label
 *   · a failed attempt      — what the model actually said, kept
 *   · no row, AI available  — the "Run AI triage" button
 *   · no row, no binding    — unavailable note and no runnable controls
 *
 * "No binding" is a property of the DEPLOYMENT, not of the row, so its
 * explanation is rendered from `aiAvailable` alone rather than from the empty
 * branch. It used to hang off `triage === null`, which left the fifth state —
 * a seeded row on a deployment with no Workers AI, i.e. exactly the judged
 * demo — showing greyed-out "Run again" and "Dismiss" controls with no reason
 * for either. Disabled controls that do not say why are indistinguishable from
 * broken ones.
 *
 * The label is not decoration. A number on an organizer's screen that a human
 * did not put there has to say so, next to the model that produced it, or the
 * next person to read the page will take it for a committee score.
 */
/*
 * The recommendation type comes from the PURE `~/lib/review/ai-triage`, not
 * from `~/db/schema`: this is a client component, and reaching through the
 * schema drags drizzle's sqlite-core into the browser bundle (AGENTS.md's
 * 41.3 kB → 10.8 kB note). Same tuple either way — the schema re-exports it.
 */
import type { AiTriageRecommendation } from "~/lib/review/ai-triage";
import { buttonClass } from "~/components/portal-ui";

export interface AiTriageCardData {
  score: number | null;
  recommendation: AiTriageRecommendation | null;
  reasoning: string | null;
  model: string;
  status: "ok" | "failed";
  organizerScore: number | null;
  organizerNote: string | null;
  createdAt: string | null;
}

const RECOMMENDATION_LABELS: Record<AiTriageRecommendation, string> = {
  accept: "Lean accept",
  maybe: "Borderline",
  reject: "Lean reject",
};

/* Tone carries a WORD as well as a colour — the pill never means anything by
 * hue alone, matching StatusPill's rule in portal-ui.tsx. */
const RECOMMENDATION_TONES: Record<AiTriageRecommendation, string> = {
  accept:
    "bg-green-100 text-green-900 ring-green-600/20 dark:bg-green-950 dark:text-green-200 dark:ring-green-400/30",
  maybe:
    "bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30",
  reject:
    "bg-rose-100 text-rose-900 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30",
};

const ADVISORY = "Advisory only — decisions stay with your committee.";

const UNAVAILABLE_NOTE_ID = "ai-triage-unavailable-note";

/**
 * Why nothing can be run here. Rendered whenever the deployment has no `AI`
 * binding, with or without a stored row — the second half of the sentence is
 * what changes, because "no first pass can be run" reads as a contradiction
 * next to a first pass that is plainly on screen.
 */
function UnavailableNote({ hasRow }: { hasRow: boolean }) {
  return (
    <p
      id={UNAVAILABLE_NOTE_ID}
      className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      data-testid="ai-triage-unavailable"
    >
      AI triage unavailable in this deployment. The Workers AI binding is not configured
      here, so{" "}
      {hasRow
        ? "“Run again” and “Dismiss” are disabled and the first pass below cannot be refreshed or permanently removed — it is the pre-computed example this demo ships with"
        : "no first pass can be run"}
      . Every other part of review is unaffected.
    </p>
  );
}

function HiddenContext({ tab, trackId }: { tab: string; trackId: string | null }) {
  return (
    <>
      <input type="hidden" name="tab" value={tab} />
      {trackId ? <input type="hidden" name="track" value={trackId} /> : null}
    </>
  );
}

export function AiTriageCard({
  triage,
  aiAvailable,
  tab,
  trackId,
  className,
}: {
  triage: AiTriageCardData | null;
  /** False when this deployment has no `AI` binding. */
  aiAvailable: boolean;
  tab: string;
  trackId: string | null;
  className?: string;
}) {
  return (
    <section className={className} data-testid="ai-triage-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-gray-500 uppercase">
            AI triage
          </h3>
          <p className="mt-1 text-sm text-gray-500">{ADVISORY}</p>
        </div>
        {triage ? (
          <div className="flex flex-wrap items-center gap-2">
            <form method="post">
              <input type="hidden" name="intent" value="run-ai-triage" />
              <HiddenContext tab={tab} trackId={trackId} />
              <button
                type="submit"
                data-testid="ai-triage-rerun"
                disabled={!aiAvailable}
                // Points at the sentence below, so the reason for the disabled
                // state is announced with the control rather than only sitting
                // near it. The id exists only when the note does.
                aria-describedby={aiAvailable ? undefined : UNAVAILABLE_NOTE_ID}
                className={buttonClass("secondary", "sm")}
              >
                Run again
              </button>
            </form>
            <form method="post">
              <input type="hidden" name="intent" value="dismiss-ai-triage" />
              <HiddenContext tab={tab} trackId={trackId} />
              <button
                type="submit"
                data-testid="ai-triage-dismiss"
                disabled={!aiAvailable}
                aria-describedby={aiAvailable ? undefined : UNAVAILABLE_NOTE_ID}
                title={
                  aiAvailable
                    ? undefined
                    : "Dismiss is permanent, and this deployment cannot re-run AI triage to restore the result."
                }
                className={buttonClass("secondary", "sm")}
              >
                Dismiss
              </button>
            </form>
          </div>
        ) : aiAvailable ? (
          <form method="post">
            <input type="hidden" name="intent" value="run-ai-triage" />
            <HiddenContext tab={tab} trackId={trackId} />
            <button
              type="submit"
              data-testid="ai-triage-run"
              className={buttonClass("secondary", "sm")}
            >
              Run AI triage
            </button>
          </form>
        ) : null}
      </div>

      {/* One instance per card, in either state — never two, never none. */}
      {aiAvailable ? null : <UnavailableNote hasRow={triage !== null} />}

      {triage === null ? (
        aiAvailable ? (
          <p className="mt-3 text-sm text-gray-500" data-testid="ai-triage-empty">
            No AI first pass on this submission yet. Running one scores the abstract 1–5
            with a short rationale; it never changes the status.
          </p>
        ) : null
      ) : triage.status === "failed" ? (
        <div
          className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
          data-testid="ai-triage-failed"
        >
          <p className="font-medium text-amber-900 dark:text-amber-200">
            The model answered, but not in a form we could read. Nothing was scored.
          </p>
          <p className="mt-1 break-words whitespace-pre-line text-gray-700 dark:text-gray-300">
            {triage.reasoning || "The model returned no text."}
          </p>
          <p className="mt-2 text-xs text-gray-500" data-testid="ai-triage-model-failed">
            AI-generated ({triage.model})
          </p>
          {triage.organizerScore !== null ? (
            <p className="mt-2 text-sm font-medium tabular-nums" data-testid="organizer-score">
              Organizer: {triage.organizerScore}/5
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3" data-testid="ai-triage-result">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums" data-testid="ai-triage-score">
              {triage.score ?? "—"}
              <span className="ml-1 text-sm font-normal text-gray-500">/ 5</span>
            </span>
            {triage.recommendation ? (
              <span
                data-testid="ai-triage-recommendation"
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${RECOMMENDATION_TONES[triage.recommendation]}`}
              >
                {RECOMMENDATION_LABELS[triage.recommendation]}
              </span>
            ) : null}
            {triage.organizerScore !== null ? (
              <span className="text-sm font-medium tabular-nums" data-testid="organizer-score">
                Organizer: {triage.organizerScore}/5
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-line">
            {triage.reasoning}
          </p>
          <p className="mt-2 text-xs text-gray-500" data-testid="ai-triage-model">
            AI-generated ({triage.model})
            {triage.createdAt ? ` · ${triage.createdAt.slice(0, 10)}` : null}
          </p>
        </div>
      )}

      {triage ? (
        <form method="post" className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="save-organizer-score" />
          <HiddenContext tab={tab} trackId={trackId} />
          <label className="text-sm text-gray-700 dark:text-gray-300">
            Your score
            <input
              type="number"
              name="organizerScore"
              min={1}
              max={5}
              step={1}
              required
              defaultValue={triage.organizerScore ?? ""}
              aria-label="Your score"
              className="ml-2 w-16 rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <label className="min-w-48 flex-1 text-sm text-gray-700 dark:text-gray-300">
            Your note
            <input
              type="text"
              name="organizerNote"
              maxLength={200}
              defaultValue={triage.organizerNote ?? ""}
              aria-label="Your note"
              className="ml-2 w-full max-w-md rounded border border-gray-300 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <button type="submit" className={buttonClass("secondary", "sm")}>
            Save your score
          </button>
        </form>
      ) : null}
    </section>
  );
}
