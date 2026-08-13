/** W6 compose journey: filter/template -> real-person preview -> bulk send -> history. */
import { expect, test } from "@playwright/test";

test("organizer previews resolved template copy and bulk-sends it to all speakers", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/comms");

  const compose = page.getByTestId("comms-compose");
  await expect(compose).toBeVisible();
  await compose.getByLabel("Recipients", { exact: true }).selectOption("all_speakers");
  await compose.getByLabel("Template").selectOption("task_reminder");
  await compose.getByRole("button", { name: "Use template" }).click();

  const selectedText = await compose.getByTestId("comms-selected-count").innerText();
  const selectedCount = Number(selectedText.match(/^(\d+) of \d+ selected$/)?.[1]);
  expect(selectedCount).toBeGreaterThan(1);
  await expect(compose.getByLabel("Body")).toHaveValue(/\{\{(?:speaker\.first_name|first_name)\}\}/);

  // `selectOption({ label })` takes a string, never a regex, and the option text
  // carries the address: "Priya Raman (priya.raman@example.com)". Resolve the
  // value instead of pinning the email — and assert the seeded speaker is really
  // in the selected set rather than silently previewing whoever came first.
  const previewSelect = compose.getByLabel("Preview recipient");
  const priyaValue = await previewSelect
    .locator("option", { hasText: "Priya Raman" })
    .first()
    .getAttribute("value");
  expect(priyaValue).toBeTruthy();
  await previewSelect.selectOption(priyaValue as string);
  await compose.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.getByTestId("comms-preview");
  await expect(preview).toContainText("Rendered for Priya Raman");
  await expect(page.getByTestId("comms-preview-body")).toContainText("Hi Priya");
  // SPK-14 evidence: raw and resolved forms remain visible together.
  await expect(compose.getByLabel("Body")).toHaveValue(/\{\{(?:speaker\.first_name|first_name)\}\}/);
  await expect(preview).toBeVisible();

  const subject = "Welcome to DevFlow Conf 2027 speakers";
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByRole("button", { name: "Send emails" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/comms\\?sent=${selectedCount}&failed=0$`));
  await expect(page.getByText(`Sent ${selectedCount} of ${selectedCount}.`)).toBeVisible();

  const sentRows = page.getByTestId("comm-row").filter({ hasText: subject });
  await expect(sentRows).toHaveCount(selectedCount);
  await expect(sentRows.first()).toContainText("sent");
});
