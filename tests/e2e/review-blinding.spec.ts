/**
 * ABS-07: blinding a round hides the author from the REVIEWER, never from the
 * organizer.
 *
 * The speaker name is read off the unblinded page rather than hard-coded, so
 * this journey cannot silently pass against a reseeded corpus: if the reviewer
 * workspace stopped showing identity altogether, the capture step below fails
 * instead of the absence assertion passing for the wrong reason.
 */
import { expect, test, type Page } from "@playwright/test";

const SLUG = "frontier-ai-summit-2026";

async function enterOrganizerWorkspace(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("blinding a round hides the author from the reviewer but not the organizer", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);

  // 1. Unblinded: the reviewer can see who submitted. Capture that name.
  await page.goto(`/review?event=${SLUG}`);
  const firstCard = page.getByTestId("reviewer-assignment").first();
  await expect(firstCard).toBeVisible();
  const speakerLine = await firstCard
    .getByTestId("reviewer-speaker-name")
    .first()
    .innerText();
  const speakerName = speakerLine.split(" · ")[0].trim();
  expect(speakerName.length).toBeGreaterThan(2);

  // 2. Organizer turns the round blind.
  await page.goto("/admin/reviews");
  const blind = page.getByLabel("Blind this round for reviewers", { exact: true });
  await blind.check();
  await page.getByRole("button", { name: "Save blinding", exact: true }).click();
  await expect(page.getByLabel("Blind this round for reviewers", { exact: true })).toBeChecked();

  // 3. Reviewer now sees the anonymized item and no identity anywhere on the page.
  await page.goto(`/review?event=${SLUG}`);
  await expect(page.getByTestId("reviewer-assignment").first()).toContainText("Blind review");
  await expect(page.getByTestId("reviewer-speaker")).toHaveCount(0);
  await expect(page.getByText(speakerName, { exact: false })).toHaveCount(0);
  // The work itself survives blinding — a loader that dropped the session would
  // pass every absence assertion above and break the product.
  await expect(page.getByTestId("reviewer-scorecard").first()).toBeVisible();

  // 4. The organizer still sees the same person by name.
  await page.goto("/admin/speakers");
  await expect(page.getByText(speakerName, { exact: false }).first()).toBeVisible();
});
