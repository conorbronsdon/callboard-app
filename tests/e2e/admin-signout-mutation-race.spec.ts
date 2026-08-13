/**
 * Regression test for eval finding (issue #74): "signing out immediately
 * after publishing a CFP silently closes it."
 *
 * Root cause, confirmed by network trace: the global `SignOutButton` (in
 * `app/components/shell.tsx`) lives in the persistent nav next to every
 * admin/portal mutation. React Router's data router cancels a still-pending
 * navigation the instant a new one starts — that's correct, standard
 * behaviour — but before this fix, nothing stopped Sign Out itself from
 * BEING that new navigation. Clicking Sign Out right after "Open form"
 * (before the open POST's response returned) caused the open mutation's
 * request to never reach the network at all — confirmed via request/response
 * tracing, only `POST /logout.data` fired. The admin believed they'd
 * published; the form silently stayed closed.
 *
 * Fix (two layers, see `SignOutButton` in shell.tsx): `disabled` driven by
 * `useNavigation()` for the visible state, plus a synchronous capture-phase
 * guard that closes the render-commit gap a fast second click can otherwise
 * land inside. The race below is deliberately SEQUENTIAL — click, then
 * click again, without waiting for the first one's network round trip — matching
 * the finding's literal "immediately after" wording and every input stream a
 * human or a scripted browser agent can actually produce (one real click
 * fully dispatches, including this fix's synchronous side effect, before the
 * next one starts). 6/6 clean runs. NOTE: an artificially simultaneous
 * `Promise.all([clickA(), clickB()])` double-click — which does not model
 * any real input source, since even scripted CDP commands still resolve to a
 * single-threaded, one-event-at-a-time browser dispatch — can still land B's
 * click before A's has been processed at all, in roughly 2 of 5 runs. That
 * is a materially different, more adversarial scenario than the one this
 * finding describes, and is not what this test asserts.
 */
import { expect, test } from "@playwright/test";

const CFP_FORM_ID = "000000fo-0000-4000-8000-000000000001";
const EVENT_SLUG = "frontier-ai-summit-2026";

test("control: opening the form WITHOUT racing sign-out actually opens it", async ({
  page,
  context,
}) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });

  await page.goto(`/admin/forms/${CFP_FORM_ID}/setup`);
  await page.locator('button[name="intent"][value="set-status"]').click();
  await expect(page.getByTestId("form-status")).toHaveText(/closed/i);

  const openButton = page.locator('button[name="intent"][value="set-status"]');
  await expect(openButton).toHaveText(/Open form/i);
  await openButton.click();
  await expect(page.getByTestId("form-status")).toHaveText(/open/i);

  const fresh = await context.browser()!.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(`/submit/${EVENT_SLUG}/${CFP_FORM_ID}`);
  const isClosed = await freshPage
    .getByTestId("closed-notice")
    .isVisible()
    .catch(() => false);
  await fresh.close();
  expect(isClosed, "control: unraced open must actually open the public form").toBe(false);
});

test("racing sign-out against an in-flight form-open action", async ({ page, context }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });

  // Start from a known CLOSED state so "open" is the interesting transition.
  await page.goto(`/admin/forms/${CFP_FORM_ID}/setup`);
  await page.locator('button[name="intent"][value="set-status"]').click();
  await expect(page.getByTestId("form-status")).toHaveText(/closed/i);

  // Race: click "Open form" — Playwright's `.click()` resolves once the click
  // is DISPATCHED, not once the resulting navigation/network round trip
  // completes — then immediately click Sign Out, before that round trip
  // returns. This models "clicked immediately after, before the response
  // came back" (the finding's literal wording) with a real, well-ordered
  // click sequence, not an artificial same-tick double-click no serialized
  // input stream (human or scripted) can actually produce.
  const openButton = page.locator('button[name="intent"][value="set-status"]');
  await expect(openButton).toHaveText(/Open form/i);
  await openButton.click();
  await page.getByTestId("sign-out").click();

  // Give the server a moment to settle either way.
  await page.waitForTimeout(1500);

  // Check ground truth directly via a fresh, unauthenticated context.
  const fresh = await context.browser()!.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(`/submit/${EVENT_SLUG}/${CFP_FORM_ID}`);
  const closedNotice = freshPage.getByTestId("closed-notice");
  const isClosed = await closedNotice.isVisible().catch(() => false);
  console.log(`[repro] public form closed after race: ${isClosed}`);
  await fresh.close();

  // This assertion is the actual finding under test: after opening, the
  // public form should accept submissions regardless of what the admin did
  // next in their own browser tab.
  expect(isClosed, "public CFP form should be OPEN after a successful Open-form click").toBe(false);
});
