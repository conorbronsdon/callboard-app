import { expect, test, type Page } from "@playwright/test";

const MANUAL_NAME = "Roster E2E Speaker";
const MANUAL_EMAIL = "roster-e2e@example.com";
const CSV_NAME = "CSV Roster Person";
const CSV_EMAIL = "csv-roster-e2e@example.com";
const BIO_SENTINEL = "SBEK-ORG-EDIT-01";

async function openOrganizerRoster(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.locator("header nav").getByRole("link", { name: "Speakers", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/speakers$/);
}

async function uploadCsv(page: Page, csv: string) {
  const drawer = page.getByTestId("import-speaker-drawer");
  await drawer.locator("summary").click();
  await drawer.locator('input[type="file"]').setInputFiles({
    name: "speakers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await drawer.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByTestId("speaker-import-preview")).toBeVisible();
}

test("organizer manages a speaker roster from add through CSV import", async ({ page }) => {
  await openOrganizerRoster(page);

  const addDrawer = page.getByTestId("add-speaker-drawer");
  await addDrawer.locator("summary").click();
  await addDrawer.getByLabel("Full name").fill(MANUAL_NAME);
  await addDrawer.getByLabel("Email *").fill(MANUAL_EMAIL.toUpperCase());
  await addDrawer.getByLabel("Title").fill("Staff Engineer");
  await addDrawer.getByLabel("Company").fill("Roster Labs");
  await addDrawer.getByLabel("Biography").fill("Initial organizer-created bio.");
  await addDrawer.getByRole("button", { name: "Add speaker", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Speaker added");
  await expect(page.getByRole("link", { name: MANUAL_NAME, exact: true })).toBeVisible();

  await page.getByRole("search").getByLabel("Search name, email, or company").fill(MANUAL_NAME);
  await page.getByRole("search").getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: MANUAL_NAME, exact: true })).toBeVisible();
  await expect(page.getByText("Sam Speaker", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Sam Speaker", { exact: true })).toBeVisible();

  const manualRow = page.getByRole("listitem").filter({ hasText: MANUAL_NAME });
  await manualRow.getByLabel(`Status for ${MANUAL_NAME}`).selectOption("ready");
  await manualRow.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("status updated");
  await expect(manualRow).toContainText("Ready");
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: MANUAL_NAME })).toContainText(
    "Ready",
  );

  await page.getByRole("link", { name: MANUAL_NAME, exact: true }).click();
  await expect(page.getByTestId("speaker-detail-status")).toHaveText("Ready");
  await page.getByTestId("speaker-edit-details").locator("summary").click();
  await page.getByLabel("Biography").fill(BIO_SENTINEL);
  await page.getByRole("button", { name: "Save speaker details" }).click();
  await expect(page.getByRole("status")).toContainText("details saved");
  await page.reload();
  await expect(page.getByTestId("speaker-profile")).toContainText(BIO_SENTINEL);

  await page.getByRole("link", { name: "← Speakers" }).click();
  await uploadCsv(
    page,
    `Name,Email,Company,Bio\r\n${CSV_NAME},${CSV_EMAIL},CSV Company,"Imported, with detail"\r\nDuplicate Manual,${MANUAL_EMAIL},Ignored,Ignored\r\n`,
  );
  const preview = page.getByTestId("speaker-import-preview");
  await expect(preview).toContainText("1 to create · 1 duplicates skipped · 0 errors");
  await expect(preview).toContainText("Already on this event's roster.");
  await preview.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByRole("status")).toContainText("Imported 1 speaker; 1 duplicate skipped.");
  await expect(page.getByRole("link", { name: CSV_NAME, exact: true })).toBeVisible();

  const countBeforeMalformed = await page.getByTestId("speaker-row-count").innerText();
  await uploadCsv(
    page,
    "Name,Email\nWould Not Land,would-not-land@example.com\nMalformed,broken@\n",
  );
  await expect(page.getByTestId("speaker-import-preview")).toContainText("1 errors");
  await page.getByTestId("speaker-import-preview").getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByRole("alert")).toContainText("No speakers were added");
  await expect(page.getByText("Would Not Land", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Would Not Land", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("speaker-row-count")).toHaveText(countBeforeMalformed);
});

