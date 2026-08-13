/**
 * Public CFP form — step ① Welcome.
 *
 * `/submit/<event-slug>/<form-id>` is the shareable link an admin copies out of
 * the form builder (research/sessionboard-api.md §7), so it renders the first
 * step directly instead of bouncing through a redirect. Steps 2-5 live at
 * `/submit/<event-slug>/<form-id>/step/<step>`.
 *
 * Viewable logged-out: an account is required to SUBMIT, never to read.
 * SSR-only — this page ships no wizard state and no client work.
 */
import { Link } from "react-router";

import { ClosedNotice, SanitizedRichText, WizardShell } from "~/components/submit/shell";
import { WizardFooter } from "~/components/submit/stepper";
import { loadWizardView } from "~/lib/public-submit/view.server";
import { stepPath } from "~/lib/public-submit/wizard";
import type { Route } from "./+types/public.submit";

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Submit" }];
  return [
    {
      title: `${loaderData.view.form.welcomeTitle ?? loaderData.view.form.name} — ${loaderData.view.event.name}`,
    },
    {
      name: "description",
      content: `Submit to ${loaderData.view.event.name}.`,
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { view } = await loadWizardView({
    request,
    eventSlug: params.eventSlug,
    formId: params.formId,
    requestedStep: "welcome",
  });
  return { view };
}

export default function PublicSubmitWelcome({ loaderData }: Route.ComponentProps) {
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

  return (
    <WizardShell
      eventName={view.event.name}
      eventSlug={view.event.slug}
      formId={view.form.id}
      formTitle={view.form.welcomeTitle ?? view.form.name}
      chrome={view.chrome}
      step="welcome"
    >
      <h2 className="mb-4 text-2xl font-semibold" data-testid="welcome-title">
        {view.form.welcomeTitle ?? view.form.name}
      </h2>
      <SanitizedRichText
        body={view.form.welcomeBody}
        sanitizedHtml={view.form.welcomeBodyHtml}
      />

      {view.limit.reached ? (
        <p
          data-testid="limit-reached"
          className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950"
        >
          You have reached this form&rsquo;s limit of {view.limit.limit} submission
          {view.limit.limit === 1 ? "" : "s"} per person.{" "}
          <Link to="/portal" className="underline">
            View your submissions
          </Link>
          .
        </p>
      ) : (
        <WizardFooter
          backTo={null}
          submitLabel="Get started"
          nextTo={stepPath(view.event.slug, view.form.id, "account")}
        />
      )}
    </WizardShell>
  );
}
