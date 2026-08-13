/**
 * WS1b golden path: the public 5-step CFP wizard, walked on a 375px viewport
 * from a freshly seeded database (`npm run e2e:seed`).
 *
 * Covers the lane's done-when: submit → portal, validation MUST-FIRE and
 * MUST-NOT-FIRE, the closed-form page, the zero-question form, draft save and
 * resume, submission-limit enforcement, and the red-annotated success-page
 * auto-redirect into the speaker portal.
 */
import { expect, test, type Page } from "@playwright/test";

const EVENT = "frontier-ai-summit-2026";
const FORM_CONDITIONAL = "ws1btst-0000-4000-8000-000000000001";
const FORM_CLOSED = "ws1btst-0000-4000-8000-000000000002";
const FORM_EMPTY = "ws1btst-0000-4000-8000-000000000003";
const FORM_ONE_SHOT = "ws1btst-0000-4000-8000-000000000004";
const SEEDED_CFP = "000000fo-0000-4000-8000-000000000001";

const submitUrl = (formId: string) => `/submit/${EVENT}/${formId}`;

/** A fresh address per test — the fixtures delete this pattern on every seed. */
function newEmail(tag: string): string {
  return `ws1b-e2e-${tag}-${Date.now().toString(36)}@example.com`;
}

/** Welcome → Account → dev magic link → verified Submission step. */
async function createAccount(page: Page, formId: string, name: string, email: string) {
  await page.goto(submitUrl(formId));
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/account$/);

  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Your email address").fill(email);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("account-magic-sent")).toBeVisible();
  await page.getByTestId("account-dev-link").click();
  await expect(page).toHaveURL(/\/step\/submission$/);
}

/** Nothing on a phone-width page may scroll sideways. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "page must not scroll horizontally at 375px").toBeLessThanOrEqual(0);
}

/* ------------------------------------------------------------- zero states */

test("closed form renders a clean closed page instead of a broken form", async ({ page }) => {
  await page.goto(submitUrl(FORM_CLOSED));

  await expect(page.getByTestId("closed-notice")).toContainText("close date");
  await expect(page.getByTestId("submission-form")).toHaveCount(0);
  await expect(page.getByTestId("wizard-next")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Deep-linking past the closed page does not get you a form either.
  await page.goto(`${submitUrl(FORM_CLOSED)}/step/submission`);
  await expect(page.getByTestId("closed-notice")).toBeVisible();
});

test("a form with no questions still renders and completes end to end", async ({ page }) => {
  const email = newEmail("empty");
  await createAccount(page, FORM_EMPTY, "Zoe Zero", email);

  await expect(page.getByTestId("no-questions")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/participant$/);
  await expect(page.getByTestId("role-indicator-speaker")).toHaveAttribute(
    "data-satisfied",
    "true",
  );

  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/review$/);
  await page.getByTestId("wizard-next").click();

  await expect(page).toHaveURL(/\/success\?s=/);
  await expect(page.getByTestId("success-friendly-id")).toContainText("ABS-");
});

test("the seeded CFP form renders its registry fields and constraints", async ({ page }) => {
  await page.goto(submitUrl(SEEDED_CFP));
  await expect(page.getByTestId("welcome-title")).toBeVisible();
  await expect(page.getByTestId("form-info")).toContainText("Submission Limit: 3 submissions");

  const email = newEmail("seeded");
  await createAccount(page, SEEDED_CFP, "Lee Seeded", email);

  // The seed now writes FULLY HYDRATED refs (label/type/validation), and
  // `hydrateFieldRefs` still reconciles them against the `fields` registry —
  // so a per-field counter comes from the registry's maxLength either way.
  await expect(page.getByLabel("Session title")).toBeVisible();
  await expect(page.getByLabel("Track")).toBeVisible();
  await expect(page.getByTestId("counter-title")).toContainText("/120");
});

/* --------------------------------------------------- the full golden path */

test("golden path: conditional CFP → submit → speaker portal, on a 375px viewport", async ({
  page,
}) => {
  const email = newEmail("golden");

  /* ① Welcome — the computed info panel */
  await page.goto(submitUrl(FORM_CONDITIONAL));
  await expect(page.getByTestId("form-info")).toContainText(
    "Form submissions will be accepted until December 31",
  );
  await expect(page.getByTestId("form-info")).toContainText(
    "Submission Limit: 2 submissions per user",
  );
  await expectNoHorizontalOverflow(page);

  /* ② Account — verify the address through the dev-only magic link */
  await createAccount(page, FORM_CONDITIONAL, "Gina Golden", email);

  /* ③ Submission */
  const title = page.getByLabel("Session title");
  const format = page.getByLabel("Format");

  // MUST-NOT-FIRE: the conditional field is absent for a Talk.
  await format.selectOption("Talk");
  await expect(page.getByLabel("Audience takeaways")).toHaveCount(0);

  // MUST-FIRE: choosing Workshop reveals it.
  await format.selectOption("Workshop");
  const takeaways = page.getByLabel("Audience takeaways");
  await expect(takeaways).toBeVisible();

  // MUST-FIRE: live per-field validation below the minimum length.
  await title.fill("Agents in anger");
  await takeaways.fill("too short");
  await expect(page.getByTestId("error-takeaways")).toContainText("at least 20");

  // MUST-NOT-FIRE: the same field goes quiet once it is long enough.
  await takeaways.fill("Three concrete things you can apply on Monday morning.");
  await expect(page.getByTestId("error-takeaways")).toHaveCount(0);

  // Cross-field combined counter — brief annotation "make sure this works".
  const counter = page.getByTestId("combined-limit-programme");
  await expect(counter).toHaveAttribute("data-over", "false");
  await expect(page.getByTestId("combined-count-programme")).toContainText("/ 120 characters");

  // MUST-FIRE: push the pair over the shared 120-character budget.
  await takeaways.fill("x".repeat(150));
  await expect(counter).toHaveAttribute("data-over", "true");

  // …and the server refuses to advance while it is over.
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/submission$/);
  await expect(page.getByTestId("error-limit")).toBeVisible();

  // MUST-NOT-FIRE: back under the cap, the counter clears and Next works.
  await page.getByLabel("Audience takeaways").fill("Three things to apply on Monday.");
  await expect(page.getByTestId("combined-limit-programme")).toHaveAttribute("data-over", "false");
  await expectNoHorizontalOverflow(page);
  await page.getByTestId("wizard-next").click();

  /* ④ Participant — role min/max live indicator */
  await expect(page).toHaveURL(/\/step\/participant$/);
  const indicator = page.getByTestId("role-indicator-speaker");
  await expect(indicator).toHaveText(/Speaker: 2–4 required · 1 added/);
  await expect(indicator).toHaveAttribute("data-satisfied", "false");
  await expect(page.getByTestId("role-hint-speaker")).toHaveText(
    "Add 1 more Speaker (minimum 2).",
  );

  // MUST-FIRE: the step refuses to advance one speaker short.
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/participant$/);
  await expect(page.getByTestId("error-participants")).toBeVisible();

  // Add the co-speaker.
  await page.getByTestId("add-participant").click();
  await expect(page.getByTestId("participant-row-1")).toBeVisible();
  await page.locator('[name="p1.firstName"]').fill("Sam");
  await page.locator('[name="p1.lastName"]').fill("Second");
  await page.locator('[name="p1.email"]').fill(newEmail("cospeaker"));

  // MUST-NOT-FIRE: the indicator is satisfied at the minimum.
  await expect(page.getByTestId("role-indicator-speaker")).toHaveText(
    /Speaker: 2–4 required · 2 added/,
  );
  await expect(page.getByTestId("role-indicator-speaker")).toHaveAttribute(
    "data-satisfied",
    "true",
  );
  await expectNoHorizontalOverflow(page);
  await page.getByTestId("wizard-next").click();

  /* ⑤ Review — summary + edit-in-place links */
  await expect(page).toHaveURL(/\/step\/review$/);
  await expect(page.getByTestId("review-form")).toBeVisible();
  await expect(page.getByTestId("review-title")).toHaveText("Agents in anger");
  await expect(page.getByTestId("review-format")).toHaveText("Workshop");
  await expect(page.getByTestId("review-participant-0")).toContainText("Gina Golden");
  await expect(page.getByTestId("review-participant-1")).toContainText("Sam Second");

  // The edit link goes back to the step it names, with answers intact.
  await page.getByTestId("edit-submission").click();
  await expect(page).toHaveURL(/\/step\/submission$/);
  await expect(page.getByTestId("submission-form")).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveValue("Agents in anger");
  await page.goBack();
  await expect(page).toHaveURL(/\/step\/review$/);
  // Wait for the review FORM, not just the URL: React Router swaps the URL
  // before the component tree, and clicking too early submits the submission
  // step's form that is still mounted.
  await expect(page.getByTestId("review-form")).toBeVisible();

  await page.screenshot({ path: "tests/e2e/artifacts/review-375.png", fullPage: true });
  await page.getByTestId("wizard-next").click();

  /* Success → speaker portal, automatically */
  await expect(page).toHaveURL(/\/success\?s=/);
  await expect(page.getByTestId("success-friendly-id")).toContainText("ABS-");
  await expect(page.getByTestId("redirect-notice")).toBeVisible();
  await expect(page.getByTestId("continue-to-portal")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/artifacts/success-375.png", fullPage: true });

  // The red-annotated hand-off: no click required. The interstitial now runs for
  // the ten seconds the organizer-facing setting advertises (CFP-05), so the
  // budget has to clear that with room for the screenshot above it.
  await page.waitForURL("**/portal", { timeout: 25_000 });
  await expect(page.getByRole("navigation", { name: "Portal sections" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The seam is only real if the submission is actually THERE: the CFP row and
  // the portal's view of it are the same `sessions` record.
  await page.goto("/portal/submissions");
  await expect(page.getByText("Agents in anger")).toBeVisible();
});

/* ------------------------------------------------------ drafts and limits */

test("a draft saves and resumes with its answers intact", async ({ page }) => {
  const email = newEmail("draft");
  await createAccount(page, FORM_CONDITIONAL, "Dora Draft", email);

  await page.getByLabel("Session title").fill("Half-finished idea");
  await page.getByLabel("Format").selectOption("Talk");
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("draft-saved")).toBeVisible();

  // Leave entirely, then come back to the form's public URL.
  await page.goto("/");
  await page.goto(`${submitUrl(FORM_CONDITIONAL)}/step/submission`);
  await expect(page.getByLabel("Session title")).toHaveValue("Half-finished idea");
  await expect(page.getByLabel("Format")).toHaveValue("Talk");
});

test("submission limit: a second attempt gets the limit page, not a form", async ({ page }) => {
  const email = newEmail("limit");
  await createAccount(page, FORM_ONE_SHOT, "Otto Once", email);

  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/participant$/);
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/review$/);
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/success\?s=/);

  // MUST-FIRE: the cap is 1, and one is used.
  await page.goto(submitUrl(FORM_ONE_SHOT));
  await expect(page.getByTestId("limit-reached")).toBeVisible();
  await expect(page.getByTestId("wizard-next")).toHaveCount(0);

  await page.goto(`${submitUrl(FORM_ONE_SHOT)}/step/submission`);
  await expect(page.getByTestId("limit-reached")).toBeVisible();

  // MUST-NOT-FIRE: a different form is unaffected by this one's cap.
  await page.goto(submitUrl(FORM_EMPTY));
  await expect(page.getByTestId("limit-reached")).toHaveCount(0);
});

test("a video submission uploads through the Worker R2 proxy and survives a reload", async ({
  page,
}) => {
  const email = newEmail("upload");
  await createAccount(page, FORM_CONDITIONAL, "Vic Video", email);

  await page.getByLabel("Session title").fill("A talk, but on tape");
  await page.getByLabel("Format").selectOption("Talk");

  // Switching to Video reveals the link + upload block…
  await page.getByTestId("content-mode-video").check();
  await page.setInputFiles("#__videoFile", {
    name: "pitch.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("a stand-in for a 30-second pitch video"),
  });
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("draft-saved")).toBeVisible();

  // …and the stored object is attached to the draft, so it comes back on reload.
  await expect(page.getByTestId("upload-name")).toContainText("pitch.txt");
  await page.reload();
  await expect(page.getByTestId("upload-name")).toContainText("pitch.txt");

  // MUST-NOT-FIRE: an uploaded file alone satisfies a video submission — no
  // link required, and no "write an abstract" complaint.
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/step\/participant$/);
});
