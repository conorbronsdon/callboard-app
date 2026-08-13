import { Form, Link, redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { Shell } from "~/components/shell";
import { destroyLoginSession } from "~/lib/auth/auth.server";
import type { Route } from "./+types/auth.logout";

/**
 * POST does the sign-out — a state change must not happen on a GET a link
 * prefetcher might follow — and every "Sign out" control in the app posts here
 * directly, so nobody is routed through an interstitial.
 *
 * The GET view is the fallback for a person who typed /logout, or who followed
 * "Not you?" out of the submission wizard. There, a confirm is the right
 * behaviour: they are switching accounts mid-form.
 */
export async function action({ request }: Route.ActionArgs) {
  const cookie = await destroyLoginSession(request);
  throw redirect("/", { headers: { "Set-Cookie": cookie } });
}

export default function Logout(_: Route.ComponentProps) {
  return (
    <Shell title="Sign out">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
        Sign out of callboard on this device?
      </p>
      <Form method="post" className="flex flex-wrap items-center gap-4">
        <button type="submit" className={buttonClass("primary")}>
          Sign out
        </button>
        <Link to="/" className="text-sm underline">
          Stay signed in
        </Link>
      </Form>
    </Shell>
  );
}
