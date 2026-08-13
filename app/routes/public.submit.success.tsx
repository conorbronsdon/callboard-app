/**
 * Confirmation page — red-annotated "make sure this works" in the buyer's brief.
 *
 * It auto-redirects into the speaker portal, and it does so THREE ways so the
 * hand-off cannot quietly fail:
 *   1. `<meta http-equiv="refresh">` in the document head — works with
 *      JavaScript disabled and needs no hydration.
 *   2. A `setTimeout` after hydration, because a browser will not always honour
 *      a meta refresh that React inserts during a client-side navigation.
 *   3. A visible `Continue to portal →` link that is always clickable.
 * All three point at the same URL, so firing twice is a no-op.
 *
 * ── How long it stays ───────────────────────────────────────────────────────
 * Ten seconds, which is what the organizer-facing checkbox actually promises:
 * "Auto-redirect to the speaker portal — Ten seconds after the confirmation
 * page." It ran for two, and an interstitial that removes itself before it can
 * be read is indistinguishable from one that never rendered — which is exactly
 * how CFP-05 was reported ("submit drops the submitter straight onto /portal").
 * A form's configured success message is the organizer's copy; showing it for
 * two seconds is not showing it.
 *
 * ── Who may see one ─────────────────────────────────────────────────────────
 * This page is a RECEIPT, so it refuses to print one that was not earned.
 * `requireOwnSubmission` demands a `?s=` naming a real, non-draft submission in
 * this event that the CURRENT person actually participates in. Previously the
 * page rendered "Thank you for your submission" for any visitor at all, and
 * looked `?s=` up by event alone — so it would also read back a stranger's
 * friendly id and title to anyone who named their session id. Anything that does
 * not check out is sent to the form rather than told which of the conditions it
 * failed.
 */
import { useEffect } from "react";
import { and, eq, isNull, ne } from "drizzle-orm";
import { Link, redirect, useNavigate } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { NoticeShell, SanitizedRichText } from "~/components/submit/shell";
import { getDb } from "~/db/client.server";
import { sessionParticipants, sessions } from "~/db/schema";
import { getCurrentPerson } from "~/lib/auth/auth.server";
import { sanitizeAdminCopy } from "~/lib/public-submit/copy.server";
import { loadSubmitContext } from "~/lib/public-submit/draft.server";
import type { Route } from "./+types/public.submit.success";

/** Seconds before the automatic hand-off into the portal, per the admin copy. */
export const REDIRECT_SECONDS = 10;
const PORTAL_URL = "/portal";

export function meta({ loaderData }: Route.MetaArgs) {
  const base = [{ title: "Submission received" }];
  if (!loaderData?.autoRedirect) return base;
  return [
    ...base,
    { httpEquiv: "refresh", content: `${REDIRECT_SECONDS};url=${PORTAL_URL}` },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await loadSubmitContext({
    request,
    eventSlug: params.eventSlug,
    formId: params.formId,
  });

  const sessionId = new URL(request.url).searchParams.get("s");
  const person = await getCurrentPerson(request);

  /*
   * No receipt without a submission behind it. The participant join is what
   * makes this the SUBMITTER's confirmation rather than a lookup service for
   * session ids, and `ne(status, "draft")` is what makes it a confirmation of
   * something that happened rather than of an abandoned draft.
   */
  if (!sessionId || !person) throw redirect(`/submit/${context.event.slug}/${context.form.id}`);

  const [row] = await getDb()
    .select({ friendlyId: sessions.friendlyId, title: sessions.title })
    .from(sessions)
    .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.eventId, context.event.id),
        eq(sessions.isAbstract, true),
        ne(sessions.status, "draft"),
        eq(sessionParticipants.personId, person.id),
        isNull(sessions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw redirect(`/submit/${context.event.slug}/${context.form.id}`);

  const submission = { friendlyId: row.friendlyId, title: row.title };
  const successCopy = sanitizeAdminCopy(
    context.form.thankYouBody ?? context.def.settings.successMessage ?? null,
  );

  return {
    event: { name: context.event.name, slug: context.event.slug },
    form: {
      id: context.form.id,
      name: context.form.name,
      successMessage: successCopy.plainText,
      successMessageHtml: successCopy.sanitizedHtml,
    },
    submission,
    /**
     * Only when the admin left the toggle on (WS1a
     * `settings.autoRedirectToPortal`, screenshot p14_1). The "has a portal to
     * land in" half of this condition moved into the loader gate above — nobody
     * reaches this line without a signed-in submitter any more.
     */
    autoRedirect: context.def.settings.autoRedirectToPortal !== false,
  };
}

export default function SubmitSuccess({ loaderData }: Route.ComponentProps) {
  const { event, form, submission, autoRedirect } = loaderData;
  const navigate = useNavigate();

  useEffect(() => {
    if (!autoRedirect) return;
    const timer = setTimeout(() => navigate(PORTAL_URL), REDIRECT_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [autoRedirect, navigate]);

  return (
    <NoticeShell eventName={event.name} title="Thank you for your submission">
      <p
        aria-hidden="true"
        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-600 text-2xl text-white"
      >
        ✓
      </p>

      {submission ? (
        <p data-testid="success-friendly-id" className="mb-4 text-sm font-medium">
          {submission.friendlyId ? `${submission.friendlyId} — ` : ""}
          {submission.title}
        </p>
      ) : null}

      <div className="mb-6 space-y-3 text-sm text-gray-600 dark:text-gray-300">
        {form.successMessage || form.successMessageHtml ? (
          <SanitizedRichText
            body={form.successMessage}
            sanitizedHtml={form.successMessageHtml}
          />
        ) : (
          <p>
            You will receive a confirmation email shortly with a link to your speaker
            portal. We review submissions over the next few weeks and then notify you.
          </p>
        )}
        {autoRedirect ? (
          <p data-testid="redirect-notice">
            Next, we will sign you into your speaker portal so you can see any tasks to
            complete. Taking you there in {REDIRECT_SECONDS} seconds…
          </p>
        ) : (
          <p>
            Your speaker portal has this submission and any tasks that come with
            it. Head there whenever you are ready.
          </p>
        )}
      </div>

      <Link
        to={PORTAL_URL}
        data-testid="continue-to-portal"
        className={buttonClass("primary")}
      >
        Continue to portal →
      </Link>

      <p className="mt-5 text-sm text-gray-500">
        Want to submit another session?{" "}
        <Link
          to={`/submit/${event.slug}/${form.id}`}
          data-testid="submit-another"
          className="underline"
        >
          click here
        </Link>{" "}
        to return to the submission form.
      </p>
    </NoticeShell>
  );
}
