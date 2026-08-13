/**
 * The org-level contact directory, end to end against the seeded demo.
 *
 * The claim under test is the one the whole area rests on: `people` is global,
 * `event_people` is the association, and the directory must therefore show a
 * returning speaker ONCE with an Events count of 2 rather than once per event.
 * Every assertion below has its complement — a single-event contact that must
 * NOT survive the `On 2+ events` filter, and a name that must NOT appear twice.
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * Seeded cross-event contacts (scripts/seed.mjs, CROSS_EVENT_SPEAKERS). These
 * three are on BOTH the Frontier AI Summit and Frontier AI Summit Europe. Jamie Whitlock is
 * deliberately NOT used here: the seed also ships a same-name/different-email
 * near-duplicate of him to populate the merge panel, so a row filter on that
 * name legitimately matches twice.
 */
const RETURNING = "David Kim";
const RETURNING_WITH_NOTE = "Sophie Laurent";
/** On the Frontier AI Summit only — the must-not-fire for every "returning" claim. */
const SINGLE_EVENT = "Yuki Tanaka";
const SECOND_EVENT = "Frontier AI Summit Europe 2026";

/*
 * `ws9-`, not `crm-`, and the prefix is load-bearing. Playwright here runs
 * `workers: 1` in filename order, so the alphabetically first spec pays for the
 * dev server's cold compile. As `crm-contacts.spec.ts` this file sorted ahead of
 * `embed-area` and inherited that cost: the demo sign-in button is a form that
 * needs hydration, and the very first click landed before the bundle did, so
 * the page sat on /demo through a 30s wait while the two tests below it passed
 * the identical helper seconds later. Warmth, not behaviour -- but the fix is to
 * stop being first rather than to widen a timeout until the flake hides.
 */
async function openContacts(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
  await page.getByTestId("admin-nav-group-people").locator("summary").click();
  await page.locator("header nav").getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/contacts$/);
}

const row = (page: Page, name: string) =>
  page.getByTestId("contact-directory").getByRole("row").filter({ hasText: name });

/*
 * The Events column by position, not by `toContainText("2")` on the whole row:
 * the row also carries an email, a company, a title and a notes count, any of
 * which can contain the digit. Columns are checkbox, name, email, company,
 * title, events, notes.
 */
const eventsCell = (page: Page, name: string) => row(page, name).locator("td").nth(5);

test("the directory spans events, dedupes by email, and filters on real criteria", async ({
  page,
}) => {
  await openContacts(page);

  // Reachable from admin chrome with no event context, and it lists people from
  // BOTH seeded events in one table.
  // `exact`, because "Email selected contacts" is also a heading on this page.
  await expect(page.getByRole("heading", { name: "Contacts", exact: true })).toBeVisible();
  await expect(row(page, RETURNING)).toHaveCount(1);
  await expect(row(page, SINGLE_EVENT)).toHaveCount(1);
  // Ines is on the SECOND event only and would be invisible on /admin/speakers
  // while the Frontier AI Summit is selected.
  await expect(row(page, "Ines Duarte")).toHaveCount(1);

  // MUST FIRE: two memberships, one row.
  await expect(eventsCell(page, RETURNING)).toHaveText("2");

  /* ── multi-criteria filtering, not the search box ──────────────────── */

  const filters = page.getByTestId("contact-filters");
  await filters.getByLabel("Event").selectOption("multi");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(row(page, RETURNING)).toHaveCount(1);
  // MUST NOT FIRE: a one-event contact is excluded by the same control.
  await expect(row(page, SINGLE_EVENT)).toHaveCount(0);

  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await filters.getByLabel("Notes").selectOption("with");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(row(page, RETURNING_WITH_NOTE)).toHaveCount(1);
  await expect(row(page, SINGLE_EVENT)).toHaveCount(0);
});

test("a contact profile shows cross-event history and keeps an internal note", async ({
  page,
}) => {
  await openContacts(page);
  await page.getByRole("link", { name: RETURNING, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/contacts\/[^/]+$/);

  const history = page.getByTestId("contact-event-history");
  await expect(history).toContainText("Frontier AI Summit 2026");
  await expect(history).toContainText(SECOND_EVENT);

  const notes = page.getByTestId("contact-notes");
  const body = "E2E-NOTE-01 hold the Thursday keynote slot.";
  await notes.getByLabel("Add a note").fill(body);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status")).toContainText("Note added");

  // Persistent, not just echoed back by the action.
  await page.reload();
  await expect(page.getByTestId("contact-notes")).toContainText(body);
  await expect(page.getByTestId("contact-notes")).toContainText("Ada Organiser");
});

test("a contact is pushed into another event from the directory, reusing the profile", async ({
  page,
}) => {
  await openContacts(page);

  // Precondition: this contact is on exactly one event today.
  await expect(eventsCell(page, SINGLE_EVENT)).toHaveText("1");

  await row(page, SINGLE_EVENT).getByRole("checkbox").check();
  await page.getByTestId("contact-directory").getByLabel("Add to event").selectOption({
    label: SECOND_EVENT,
  });
  await page
    .getByTestId("contact-directory")
    .getByRole("button", { name: "Add to event" })
    .click();

  const status = page.getByRole("status");
  await expect(status).toContainText(SECOND_EVENT);
  // The rubric line is the REUSE, and the UI has to say so.
  await expect(status).toContainText("no duplicate contacts were created");

  // MUST FIRE: the count moved, and the person is still ONE row.
  await expect(row(page, SINGLE_EVENT)).toHaveCount(1);
  await expect(eventsCell(page, SINGLE_EVENT)).toHaveText("2");
});

test("selected contacts are emailed from the directory with merge fields resolved", async ({
  page,
}) => {
  await openContacts(page);

  const directory = page.getByTestId("contact-directory");
  await row(page, RETURNING_WITH_NOTE).getByRole("checkbox").check();

  const compose = page.getByTestId("contact-compose");
  await compose.getByLabel("Merge-field context").selectOption({ label: SECOND_EVENT });
  await compose.getByLabel("Subject").fill("Speaking at {{event.name}}?");
  await compose.getByLabel("Body").fill("Hi {{speaker.first_name}}, we are planning the next slate.");

  /*
   * The whole panel lives inside the directory's form, beside the "Add to
   * event" control. That control must NOT be `required`: a required field is
   * validated for every submit button in its form, so it would silently block
   * this send in a real browser while every server-side test stayed green.
   * Sending without touching it is the regression test for that.
   */
  await directory.getByRole("button", { name: "Send email" }).click();
  await expect(page.getByRole("status")).toContainText("Sent 1 of 1.");
});

/**
 * CRM-09 — a filtered view saved as a named, reusable segment.
 *
 * Driven entirely through the UI, and the assertion is the RESULT SET the chip
 * produces, not the href it carries: a chip that navigated to the right URL
 * while the directory ignored the filters would pass a link check and fail a
 * user.
 *
 * The must-not-fire is STRUCTURAL — the replayed table is strictly smaller than
 * the directory, and every surviving row really is on 2+ events — rather than
 * "Yuki Tanaka is absent". `workers: 1` and no reset between tests means the
 * spec above this one has already pushed Yuki onto a second event by the time
 * this runs, so a named must-not-fire here would be asserting the order the
 * file happens to be in.
 */
test("a filtered directory is saved as a named segment, replayed, and deleted", async ({
  page,
}) => {
  await openContacts(page);
  const segments = page.getByTestId("contact-segments");
  const bodyRows = page.getByTestId("contact-directory").locator("tbody tr");
  const NAME = "Returning speakers";

  // Nothing saved, and saving is refused until there is something to save.
  await expect(segments).toContainText("No saved segments yet");
  await expect(segments.getByRole("button", { name: "Save as segment" })).toBeDisabled();

  const unfiltered = await bodyRows.count();
  expect(unfiltered).toBeGreaterThan(0);

  // Filter, then save THAT view.
  const filters = page.getByTestId("contact-filters");
  await filters.getByLabel("Event").selectOption("multi");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(row(page, RETURNING)).toHaveCount(1);

  await segments.getByLabel("Segment name").fill(NAME);
  await segments.getByRole("button", { name: "Save as segment" }).click();
  await expect(page.getByRole("status")).toContainText(NAME);

  // Leave the filtered view entirely; the whole directory is back.
  await page.goto("/admin/contacts");
  await expect(bodyRows).toHaveCount(unfiltered);

  // MUST FIRE: one click re-applies the saved filters to the TABLE.
  await page.getByTestId("contact-segments").getByRole("link", { name: NAME }).click();
  await expect(page).toHaveURL(/\/admin\/contacts\?event=multi$/);
  await expect(row(page, RETURNING)).toHaveCount(1);
  await expect(eventsCell(page, RETURNING)).toHaveText("2");

  // MUST NOT FIRE: the chip filtered rather than merely navigating. Fewer rows
  // than the directory, and not one of them is a single-event contact.
  const replayed = await bodyRows.count();
  expect(replayed).toBeGreaterThan(0);
  expect(replayed).toBeLessThan(unfiltered);
  const eventCounts = await bodyRows.locator("td:nth-child(6)").allTextContents();
  expect(eventCounts).toHaveLength(replayed);
  for (const value of eventCounts) {
    expect(Number(value)).toBeGreaterThanOrEqual(2);
  }

  // And it is removable.
  await page
    .getByTestId("contact-segments")
    .getByRole("button", { name: `Delete segment ${NAME}` })
    .click();
  await expect(page.getByRole("status")).toContainText(NAME);
  await expect(page.getByTestId("contact-segments")).toContainText("No saved segments yet");
  await expect(
    page.getByTestId("contact-segments").getByRole("link", { name: NAME }),
  ).toHaveCount(0);
});
