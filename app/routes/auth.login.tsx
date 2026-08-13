import { Form, Link, redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { Shell } from "~/components/shell";
import {
  getCurrentPerson,
  sendMagicLink,
  shouldRevealMagicLink,
} from "~/lib/auth/auth.server";
import { isDemoMode } from "~/lib/env.server";
import { hasAnyReviewMembership } from "~/lib/review/access.server";
import type { Route } from "./+types/auth.login";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in — callboard" }];
}

/** Only allow relative paths — an open redirect here would be a real hole. */
function safeRedirect(value: string | null): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}

export async function loader({ request }: Route.LoaderArgs) {
  const person = await getCurrentPerson(request);
  if (person) {
    const destination = person.role === "admin"
      ? "/admin"
      : (await hasAnyReviewMembership(person.id) ? "/review" : "/portal");
    throw redirect(destination);
  }
  const redirectTo = safeRedirect(new URL(request.url).searchParams.get("redirectTo"));
  return { redirectTo: redirectTo ?? null, demoMode: isDemoMode() };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const redirectTo = safeRedirect(String(formData.get("redirectTo") ?? "") || null);

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false as const, error: "Enter a valid email address.", devLink: null };
  }

  const issued = await sendMagicLink({ request, email, redirectTo });

  return {
    ok: true as const,
    error: null,
    /**
     * In dev — and on a disposable demo Worker, which pins the console mailer
     * too — the link is also surfaced in the UI, because otherwise it exists
     * only in a log nobody reading this page can see. Never in production: that
     * would hand a login to anyone who can type an email address.
     */
    devLink: shouldRevealMagicLink() ? issued.url : null,
  };
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <Shell title="Sign in" subtitle="We email you a link — no password.">
      <div className="max-w-md">
        {actionData?.ok ? (
          <div className="rounded border border-green-300 bg-green-50 p-4 text-sm dark:border-green-800 dark:bg-green-950">
            <p>Check your email for a sign-in link. It expires in 15 minutes.</p>
            {actionData.devLink ? (
              <div
                className="mt-3"
                data-testid="login-magic-reveal"
                data-reveal-mode={loaderData.demoMode ? "demo" : "dev"}
              >
                <p className="break-all">
                  <span className="font-medium">
                    {loaderData.demoMode ? "Demo mode:" : "Dev mode:"}
                  </span>{" "}
                  <a className="underline" href={actionData.devLink}>
                    {actionData.devLink}
                  </a>
                </p>
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                  {loaderData.demoMode
                    ? "Demo mode: this link would be emailed in production."
                    : "Shown because this is a development build with no mail provider."}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <Form method="post" className="space-y-4">
            <input type="hidden" name="redirectTo" value={loaderData.redirectTo ?? ""} />
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            {actionData?.error ? (
              <p className="text-sm text-red-600">{actionData.error}</p>
            ) : null}
            <button type="submit" className={buttonClass("primary")}>
              Email me a link
            </button>
          </Form>
        )}

        {loaderData.demoMode ? (
          <p className="mt-6 text-sm text-gray-500">
            Judging?{" "}
            <Link className="underline" to="/demo">
              Skip the email — one-click demo sign-in
            </Link>
            .
          </p>
        ) : null}
      </div>
    </Shell>
  );
}
