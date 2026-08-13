/**
 * ABS-14 walked as a judge would walk it, against `npm run seed` output only.
 *
 * Two things have to be true on a cold demo:
 *   1. The seeded advisory opinions RENDER, labelled as AI, with no button
 *      pressed and no Workers AI binding required.
 *   2. A submission with no opinion shows an INTENTIONAL state, never a blank
 *      card. Which intentional state depends on whether the running Worker has
 *      an `AI` binding, so the test reads that off the page rather than
 *      assuming it — a guess here is exactly the kind of assertion that passes
 *      for the wrong reason. It then cross-checks the abstracts list, so the
 *      two independent surfaces have to agree.
 *
 * Abstract ids are the seed's deterministic ones (`id("se", n)` in
 * scripts/seed.mjs), the same trick seeded-demo.spec.ts uses for the CFP form:
 * the friendly id in the table is plain text, not a link, so navigating by
 * "ABS-11" is not a thing a click can do.
 */
import { expect, test, type Page } from "@playwright/test";

const abstractId = (oneBased: number) =>
  `000000se-0000-4000-8000-${String(oneBased).padStart(12, "0")}`;

/** ABS-11 — seeded with a 5/5 "Lean accept" opinion. Pending. */
const TRIAGED = abstractId(11);
/** ABS-13 — pending and deliberately left un-triaged by the seed. */
const UNTRIAGED = abstractId(13);
const SEEDED_MODEL_LABEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast (seeded example)";
const ADVISORY = "Advisory only — decisions stay with your committee.";

async function signInAsAdmin(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function openAbstract(page: Page, id: string) {
  await page.goto(`/admin/submissions/${id}?tab=pending`);
  await expect(page.getByTestId("detail-abstract")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test("a seeded AI opinion renders labelled, scored and marked advisory", async ({ page }) => {
  await openAbstract(page, TRIAGED);

  const card = page.getByTestId("ai-triage-card");
  await expect(card).toBeVisible();
  // Not optional copy — it is the guarantee the feature makes to an organizer
  // reading a number no human wrote.
  await expect(card).toContainText(ADVISORY);

  await expect(page.getByTestId("ai-triage-result")).toBeVisible();
  await expect(page.getByTestId("ai-triage-score")).toContainText("5");
  await expect(page.getByTestId("ai-triage-recommendation")).toContainText("Lean accept");
  await expect(page.getByTestId("ai-triage-model")).toContainText("AI-generated (");
  await expect(page.getByTestId("ai-triage-model")).toContainText(SEEDED_MODEL_LABEL);

  // must-not-fire: the AI's 5 is not the committee's score. The human
  // scorecard block on the same page carries no AI attribution at all.
  const scorecards = page.getByTestId("review-scorecards");
  await expect(scorecards).toBeVisible();
  await expect(scorecards).not.toContainText("AI-generated");
});

test("a submission with no opinion shows an intentional state, never a blank card", async ({
  page,
}) => {
  await openAbstract(page, UNTRIAGED);

  const card = page.getByTestId("ai-triage-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText(ADVISORY);
  await expect(page.getByTestId("ai-triage-result")).toHaveCount(0);

  // Exactly ONE of the two intentional states.
  const unavailable = await page.getByTestId("ai-triage-unavailable").count();
  const runnable = await page.getByTestId("ai-triage-run").count();
  expect(unavailable + runnable).toBe(1);

  await page.goto("/admin/submissions?tab=pending");
  if (unavailable === 1) {
    await expect(page.getByTestId("bulk-ai-triage-unavailable")).toBeVisible();
    await expect(page.getByTestId("bulk-ai-triage")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("bulk-ai-triage")).toBeVisible();
    await expect(page.getByTestId("bulk-ai-triage-unavailable")).toHaveCount(0);
  }
});

test("the un-triaged abstract really is un-triaged, and the triaged one really is", async ({
  page,
}) => {
  // The control for the test above: if BOTH abstracts rendered a result, or
  // neither did, the "intentional state" assertion would be measuring nothing.
  await openAbstract(page, TRIAGED);
  await expect(page.getByTestId("ai-triage-result")).toHaveCount(1);

  await openAbstract(page, UNTRIAGED);
  await expect(page.getByTestId("ai-triage-result")).toHaveCount(0);
});

test("dismissing a seeded opinion removes it and leaves the abstract alone", async ({ page }) => {
  await openAbstract(page, TRIAGED);
  const statusBefore = await page.getByTestId("detail-status").innerText();
  await expect(page.getByTestId("ai-triage-result")).toHaveCount(1);

  await page.getByTestId("ai-triage-dismiss").click();

  await expect(page.getByTestId("ai-triage-result")).toHaveCount(0);
  await expect(page.getByTestId("ai-triage-card")).toBeVisible();

  /*
   * must-not-fire: dismissing an advisory opinion is not a decision.
   *
   * `innerText` on BOTH sides, not `toHaveText`. The status cell is a
   * `<details>` popover, so `toHaveText` reads the collapsed menu's options too
   * ("PendingStatusAcceptedAccept Queue…") and never matches the visible label
   * captured before the click.
   */
  expect(await page.getByTestId("detail-status").innerText()).toBe(statusBefore);
  expect(statusBefore.trim()).toBe("Pending"); // control: it was a real value
});
