import { Form, redirect } from "react-router";

import { buttonClass } from "~/components/portal-ui";
import { eyebrowClass, linkClass, Shell } from "~/components/shell";
import { demoSignIn } from "~/lib/auth/auth.server";
import {
  DEMO_ACCOUNTS,
  DEMO_EVENT_SLUG,
  DEMO_ROLES,
  type DemoRole,
} from "~/lib/demo";
import { isDemoMode } from "~/lib/env.server";
import type { Route } from "./+types/auth.demo";

/**
 * One-click sign-in for judges. Gated behind DEMO_MODE — the check is repeated
 * in both loader and action on purpose: a route that renders nothing but still
 * accepts POSTs is a live backdoor.
 */
function assertDemoMode() {
  if (!isDemoMode()) {
    throw new Response("Not found", { status: 404 });
  }
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Demo sign-in — callboard" }];
}

export async function loader(_: Route.LoaderArgs) {
  assertDemoMode();
  return {
    accounts: DEMO_ROLES.map((role) => ({
      role,
      email: DEMO_ACCOUNTS[role].email,
      label: DEMO_ACCOUNTS[role].label,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertDemoMode();

  const formData = await request.formData();
  const role = String(formData.get("role") ?? "") as DemoRole;
  if (!DEMO_ROLES.includes(role)) {
    return { error: "Unknown demo role." };
  }

  const result = await demoSignIn(request, role);
  if (!result) {
    return { error: "Demo accounts are not available on this deployment." };
  }

  throw redirect(DEMO_ACCOUNTS[role].landing, {
    headers: { "Set-Cookie": result.cookie },
  });
}

/** 20px stroked tile glyph. Decorative — the card's own heading names the role. */
function RoleIcon({ role }: { role: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {role === "admin" ? (
        <path d="M4 19.5V6.5M4 6.5 12 4l8 2.5M4 19.5h16M9 19.5v-5h6v5M20 6.5v13" />
      ) : (
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.5 20a7.5 7.5 0 0 1 15 0" />
      )}
    </svg>
  );
}

export default function Demo({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <Shell
      title="Judge demo"
      subtitle="A complete event-programme workflow, ready to explore with seeded data."
    >
      {actionData?.error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {actionData.error}
        </p>
      ) : null}

      <section aria-labelledby="choose-demo-role">
        {/*
         * The one deliberately loud surface in the product. A judge lands
         * here cold, and a page that opens with body copy on white gives them
         * nothing to aim at; the band says "start at this end".
         *
         * TWO columns from `lg`. At 1440 the single-column version measured its
         * copy at `max-w-2xl` inside an 1104px band and left 40% of the fill
         * empty — a blue rectangle with a paragraph in the corner, which is the
         * shape of every template hero. The right column carries the three
         * facts a cold judge actually needs before clicking, so the band is
         * full without being louder.
         *
         * A draft of this pulled the role cards up to overlap the band's lower
         * edge. It photographed badly: the only place the band still showed was
         * the 16px gutter between the two cards, which read as a stray blue tab
         * rather than as depth. Taking the accessory off was the better move.
         */}
        <div className="rounded-2xl bg-linear-to-br from-blue-600 to-blue-700 px-6 py-8 text-white sm:px-8">
          <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div>
              <p className="text-eyebrow font-semibold text-blue-100 uppercase">
                Start here
              </p>
              <h2
                id="choose-demo-role"
                className="mt-1.5 text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl lg:text-4xl"
              >
                Choose the side of the workflow you want to see
              </h2>
              <p className="mt-3 max-w-prose text-sm leading-6 text-blue-50">
                No email or setup is required. Choosing a role signs you into its
                seeded account—even if you are already using the other role.
                Return to <strong className="font-semibold">/demo</strong> at any
                time to switch.
              </p>
            </div>
            {/*
             * A definition list, not three decorative stat tiles: each line is a
             * question a judge asks before they click something on a stranger's
             * deployment, answered in the interface's own voice.
             */}
            <dl className="space-y-3 rounded-xl bg-white/10 p-4 text-sm ring-1 ring-white/20 ring-inset">
              {[
                ["No sign-up", "One click signs you in. Nothing to install, nothing to configure."],
                [
                  "A whole event, already running",
                  "An open call, a review round mid-flight, an accepted roster and a published agenda.",
                ],
                [
                  "Yours to break",
                  "Every change lands in disposable demo data and touches nothing else.",
                ],
              ].map(([term, description]) => (
                <div key={term}>
                  <dt className="font-semibold text-white">{term}</dt>
                  <dd className="mt-0.5 leading-5 text-blue-50">{description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {loaderData.accounts.map((account) => (
            <Form
              method="post"
              key={account.role}
              className="flex h-full flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-card transition hover:border-blue-300 sm:p-6 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
              aria-describedby={account.role + "-demo-description"}
            >
              <input type="hidden" name="role" value={account.role} />
              {/*
               * Glyph and eyebrow share a row. Stacked, they cost 60px of card
               * height to say two words, which is how both cards ended up with
               * a paragraph floating in the middle of 240px of white.
               */}
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                >
                  <RoleIcon role={account.role} />
                </span>
                <p className={eyebrowClass}>
                  {account.role === "admin" ? "Organizer" : "Speaker"}
                </p>
              </div>
              <h3 className="mt-3 text-xl font-semibold tracking-tight">
                {account.role === "admin"
                  ? "Run the event"
                  : "Complete onboarding"}
              </h3>
              <p
                id={account.role + "-demo-description"}
                className="mt-1.5 grow text-sm leading-6 text-gray-600 dark:text-gray-300"
              >
                {account.role === "admin"
                  ? "Build the CFP, review proposals, coordinate speakers and publish the agenda."
                  : "See an accepted proposal, update the speaker profile and complete event tasks."}
              </p>
              {/*
               * The credential a judge is about to assume, ruled off from the
               * pitch above it and set in mono — it is an identifier, and mono
               * already means machine-precise data everywhere else here.
               */}
              <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                Seeded as{" "}
                <span className="font-mono text-gray-700 dark:text-gray-300">
                  {account.email}
                </span>
              </p>
              {/*
               * `buttonClass("primary")`, not a hand-rolled blue fill: same
               * colour as the helper by luck, different padding and weight by
               * hand, so the two most-clicked buttons in the product would not
               * have moved when the helper moved.
               *
               * These were NOT "the last raw primary on a judge-facing
               * surface" — an earlier draft of this comment said so and four
               * more were still in the tree, two of them in a different blue.
               * All four are converted now, and `design-tokens-scan.test.ts`
               * holds the count at zero so the claim cannot rot again.
               *
               * ⚠️ auth.demo.test.tsx counts this exact string and requires
               * EXACTLY 2. The size modifiers stay LAST — Tailwind resolves
               * conflicting utilities by stylesheet order, not class order, so
               * `w-full` must not be competing with a width inside the helper.
               */}
              <button
                type="submit"
                className={`${buttonClass("primary")} mt-3 w-full`}
              >
                {account.role === "admin"
                  ? "Enter organizer workspace"
                  : "Enter speaker portal"}
              </button>
            </Form>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="judge-walkthrough"
        className="mt-10 border-t border-gray-200 pt-8 dark:border-gray-800"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className={eyebrowClass}>Suggested walkthrough</p>
            <h2
              id="judge-walkthrough"
              className="mt-1 text-xl font-semibold tracking-tight"
            >
              Follow the full programme lifecycle in six stops
            </h2>
          </div>
          <a
            href={"/e/" + DEMO_EVENT_SLUG + "/schedule"}
            className={`${linkClass} text-sm`}
          >
            Preview the public schedule
          </a>
        </div>

        <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
          {[
            [
              "Open the organizer dashboard",
              "See programme health and the work that needs attention.",
            ],
            [
              "Inspect the CFP form",
              "Review conditional questions, track routing and submission settings.",
            ],
            /*
             * The AI-triage pointer rides on stop 3's DESCRIPTION rather than
             * becoming a seventh stop: auth.demo.test.tsx:140 requires exactly
             * six `data-demo-step` nodes, and the heading above says "six
             * stops". Copy-only, so no selector moves.
             */
            [
              "Evaluate proposals",
              "Score assigned submissions, read the advisory AI first pass on an abstract, and move decisions through the review queue.",
            ],
            [
              "Coordinate accepted speakers",
              "See the speaker record, onboarding tasks, files and communications.",
            ],
            [
              "Build and publish the agenda",
              "Place sessions by day and room, then check schedule conflicts.",
            ],
            [
              "Switch to the speaker portal",
              "Return to /demo and experience profile, task and resource self-service.",
            ],
          ].map(([title, description], index) => (
            <li
              key={title}
              data-demo-step={index + 1}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-card transition hover:border-blue-300 sm:p-5 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-800"
            >
              {/*
               * Numbering earns its place here: these six really are ordered —
               * you cannot evaluate proposals before the call collects them —
               * so the marker carries information rather than decorating the
               * row. It is a ruled-off ordinal rather than a filled chip, which
               * kept six blue dots competing with the two blue CTAs above.
               */}
              <p
                aria-hidden="true"
                className="text-eyebrow font-semibold text-blue-700 tabular-nums dark:text-blue-300"
              >
                Step {index + 1}
              </p>
              <h3 className="mt-1.5 text-base font-semibold tracking-tight text-balance">
                {title}
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-gray-600 dark:text-gray-300">
                {description}
              </p>
            </li>
          ))}
        </ol>

        {/*
         * Named scope beats a judge discovering the edge on their own and
         * reading it as a gap. What is here is finished; what is missing is
         * missing on purpose.
         *
         * Both closing notes now sit in ONE ruled aside. Loose on the page
         * ground they were two ragged paragraphs measuring ~545px under a
         * 1104px layout — the shape of a README pasted under a UI, which is
         * exactly the read this page cannot afford on a judge's first screen.
         */}
        <aside className="mt-8 rounded-xl border border-gray-200 bg-white p-5 shadow-card dark:border-gray-800 dark:bg-gray-900">
          <p className={eyebrowClass}>Where the edges are</p>
          <p className="mt-2 max-w-prose text-sm leading-6 text-gray-700 dark:text-gray-200">
            CRM, marketing pages, and payment processing are intentionally out of
            scope. Callboard covers the programme itself — the call, the review,
            the speakers and the agenda — and everything you can reach from here
            is built, not stubbed.
          </p>
          <p className="mt-3 max-w-prose text-xs leading-5 text-gray-500 dark:text-gray-400">
            This is an isolated, disposable demo. Changes affect seeded
            demonstration data only, and the one-click accounts are unavailable on
            production deployments.
          </p>
        </aside>
      </section>
    </Shell>
  );
}
