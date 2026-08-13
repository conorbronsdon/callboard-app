/**
 * Conor's live-demo report: on an admin submission page, "the review scoring
 * shows the values, but I can't click in and fill them out — should I be
 * doing it somewhere else or is that a mistake?"
 *
 * By design (DECISIONS #53): review authority is event-scoped team
 * membership plus an assignment in an open round. An organizer's own
 * submission page is not the scoring surface for a round their team is not
 * assigned to — that is the reviewer workspace at /review, reached from
 * Admin > Settings > View as > "View as reviewer". Accepted submissions are
 * the clean, always-true repro: the seed only assigns review teams to
 * pending/queue abstracts (scripts/seed.mjs), so every accepted abstract has
 * NO team assignment at all, on any fresh seed — no fixture surgery needed.
 *
 * app/routes/admin.submission.scoring.test.tsx pins the read-only render at
 * the unit level (including the harder case: an organizer's OWN prior score
 * turning read-only after losing team access). This spec is the complement —
 * it proves the inline "open as reviewer" link is not a dead end: it lands on
 * a real, working, submittable scorecard in the reviewer workspace.
 */
import { expect, test, type Page } from "@playwright/test";

const SLUG = "frontier-ai-summit-2026";

async function enterOrganizerWorkspace(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("an unassigned round is read-only, and its reviewer-workspace link actually works", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);

  /* ── an accepted abstract's round has no team assignment on this admin ── */
  await page.goto("/admin/submissions");
  await page.getByRole("link", { name: /^Accepted \d+$/ }).click();
  await expect(page).toHaveURL(/tab=accepted/);
  await page.locator("tbody tr td a").first().click();

  const notice = page.getByTestId("review-round-1-readonly-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Your reviewer teams are not assigned");
  const openAsReviewer = notice.getByRole("link", { name: "open as reviewer" });
  await expect(openAsReviewer).toBeVisible();

  // MUST-FIRE: read-only means nothing left in the DOM that a click could
  // open — no input, select, textarea or submit button for this round.
  const scorecard = page.getByTestId("review-round-1");
  await expect(scorecard.locator("input[name^='score-']")).toHaveCount(0);
  await expect(scorecard.locator("select[name^='score-']")).toHaveCount(0);
  await expect(scorecard.locator("textarea[name='comment']")).toHaveCount(0);
  await expect(scorecard.getByRole("button", { name: /Submit score|Update score/ })).toHaveCount(
    0,
  );

  /* ── the link is not a dead end: it reaches a real, working scorecard ── */
  await openAsReviewer.click();
  await expect(page).toHaveURL(/\/admin\/view-as$/);
  await expect(page.getByRole("heading", { name: "Reviewer workspace" })).toBeVisible();

  const reviewerRow = page.locator("table").filter({ hasText: "Reviewer" }).locator("tbody tr").first();
  await expect(reviewerRow).toBeVisible();
  await reviewerRow.getByRole("button", { name: "View as reviewer" }).click();

  await expect(page.getByText(/Viewing reviewer workspace as/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/review\\?event=${SLUG}`));

  const assignment = page.getByTestId("reviewer-assignment").first();
  await expect(assignment).toBeVisible();
  const form = assignment.getByTestId("reviewer-scorecard");
  const numericInputs = form.locator('input[type="number"]');
  const numericCount = await numericInputs.count();
  for (let index = 0; index < numericCount; index += 1) {
    await numericInputs.nth(index).fill("3");
  }
  for (const select of await form.locator("select").all()) {
    const options = await select.locator("option").all();
    if (options.length > 1) await select.selectOption({ index: 1 });
  }
  await form.getByRole("button", { name: /Submit score|Update score/ }).click();
  // A resubmit-safe proof the write landed: the button relabels once a
  // review row exists, which only happens after a successful save.
  await expect(
    assignment.getByTestId("reviewer-scorecard").getByRole("button", { name: "Update score" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back to organizer" }).click();
  await expect(page).toHaveURL(/\/admin\/view-as$/);
});
