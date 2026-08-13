/**
 * One journey per v0.1.2 feature, against the SEEDED demo — no fixtures of
 * their own, because the point of an end-to-end pass here is that the wiring
 * survives the real seed, the real chrome and the real forms.
 *
 * ⚠️ EVERY TEST HERE RESTORES WHAT IT CHANGED. `workers: 1` and one shared
 * database mean a spec that leaves the seeded CFP reconfigured is not testing
 * its own feature, it is editing the fixture every later spec reads. Two of
 * these three configure the seeded form and one adds a Pending row; each undoes
 * itself, and the undo doubles as the must-still-fire half of the assertion.
 *
 * Everything each feature can be proven about in isolation is proven in the
 * unit suites (`app/routes/admin.submissions.capture.test.tsx`,
 * `app/routes/eligible-tracks.test.tsx`, `app/routes/edit-deadline.test.tsx`),
 * including the server-side rejections a browser cannot easily stage. These
 * three are the "does it exist on the page a judge opens" pass, kept short.
 */
import { expect, test, type Page } from "@playwright/test";

const EVENT = "frontier-ai-summit-2026";
/** Fixed ids from scripts/seed.mjs, not fixtures. */
const SEEDED_CFP = "000000fo-0000-4000-8000-000000000001";
const SEEDED_CAPTURE = "000000se-0000-4000-8000-000000000091";

async function signInAs(page: Page, role: "admin" | "speaker") {
  await page.goto("/demo");
  await page
    .getByRole("button", {
      name: role === "admin" ? "Enter organizer workspace" : "Enter speaker portal",
    })
    .click();
  await expect(page).toHaveURL(role === "admin" ? /\/admin$/ : /\/portal$/);
}

/* ───────────────────────── capture on behalf of ───────────────────────── */

test("an organizer captures a pitch that arrived by email, and nothing is sent", async ({
  page,
}) => {
  const pitch = `Hi — I'd love to talk about running D1 at conference scale ${Date.now().toString(36)}`;

  await signInAs(page, "admin");

  /*
   * The SEEDED capture first. Provenance is a hand-written JSON blob in
   * scripts/seed.mjs, and `captureProvenance` returns null for a block it does
   * not recognise — so a typo there would not error, it would silently render
   * an ordinary submission and a judge would never know the feature shipped.
   * This is the assertion that catches that.
   */
  await page.goto(`/admin/submissions/${SEEDED_CAPTURE}`);
  const seeded = page.getByTestId("capture-provenance");
  await expect(seeded).toBeVisible();
  await expect(seeded).toContainText("Ada Organiser");
  await expect(seeded).toContainText("from Email");
  // The paste is stored verbatim, so the email's own sign-off is on the page.
  await expect(page.getByTestId("detail-abstract")).toContainText("— Ingrid");

  await page.goto("/admin/submissions");

  await page.getByTestId("capture-drawer").getByText("+ Capture pitch").click();
  await page.getByLabel("What they sent you").fill(`${pitch}\n\n— Nina`);
  await page.getByLabel("Speaker email").fill(`captured-${Date.now().toString(36)}@example.com`);
  await page.getByLabel("Speaker name").fill("Nina Captured");
  await page.getByRole("button", { name: "Capture" }).click();

  // The list says what did NOT happen.
  await expect(page.getByText("Nothing was sent to them.")).toBeVisible();

  // The pitch is in Pending with its first line as the title, and the drill-in
  // carries the provenance a reviewer needs before reading somebody else's words.
  const link = page.getByRole("link", { name: pitch });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/admin\/submissions\/[^/?]+/);

  const banner = page.getByTestId("capture-provenance");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Captured on the speaker’s behalf");
  await expect(banner).toContainText("nothing was sent to the speaker");

  // Restore: move the captured row out of Pending, because later specs drill in
  // by "the first row in Pending" and the newest row is this one. Declined is
  // the nearest admin-assignable status — Withdrawn is a speaker/system state
  // and the popover deliberately does not offer it.
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByTestId("detail-status").locator("summary").click();
  const popover = page.getByTestId(`status-popover-${sessionId}`);
  await popover.getByRole("radio", { name: "Declined" }).check();
  await popover.getByRole("button", { name: "Save" }).click();

  await page.goto("/admin/submissions?tab=pending");
  await expect(page.getByRole("link", { name: pitch })).toHaveCount(0);
});

/* ───────────────────────────── eligible tracks ─────────────────────────── */

test("eligible tracks the organizer ticks are the only ones the public form offers", async ({
  page,
}) => {
  await signInAs(page, "admin");
  await page.goto(`/admin/forms/${SEEDED_CFP}/abstract`);

  const control = page.getByTestId("eligible-tracks-form");
  await expect(control).toBeVisible();
  await control.getByLabel("Agents", { exact: true }).check();
  await control.getByLabel("Infrastructure", { exact: true }).check();
  await control.getByRole("button", { name: "Save eligible tracks" }).click();
  await expect(
    page.getByTestId("eligible-tracks-form").getByLabel("Agents", { exact: true }),
  ).toBeChecked();

  // The public form now asks, with exactly those two options — and the control
  // is named "Programme track" so it cannot collide with the form's own Track
  // question, which is still there.
  await signInAs(page, "speaker");
  await page.goto(`/submit/${EVENT}/${SEEDED_CFP}/step/submission`);

  const select = page.getByTestId("track-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveText([
    "Choose a track…",
    "Agents",
    "Infrastructure",
  ]);
  // Must not fire: a track the organizer did not tick is absent, not merely
  // hidden behind a disabled attribute.
  await expect(select.locator("option", { hasText: "Evals & Reliability" })).toHaveCount(0);

  // Restore, and prove the off state really is off.
  await signInAs(page, "admin");
  await page.goto(`/admin/forms/${SEEDED_CFP}/abstract`);
  const reset = page.getByTestId("eligible-tracks-form");
  await reset.getByLabel("Agents", { exact: true }).uncheck();
  await reset.getByLabel("Infrastructure", { exact: true }).uncheck();
  await reset.getByRole("button", { name: "Save eligible tracks" }).click();
  await expect(page.getByText("No tracks ticked")).toBeVisible();

  await signInAs(page, "speaker");
  await page.goto(`/submit/${EVENT}/${SEEDED_CFP}/step/submission`);
  await expect(page.getByTestId("track-select")).toHaveCount(0);
});

/* ───────────────────────── configurable edit deadline ──────────────────── */

test("a past edit deadline closes speaker corrections that were open a moment ago", async ({
  page,
}) => {
  // Must still fire first: with the default policy the demo speaker can edit.
  await signInAs(page, "speaker");
  await page.goto("/portal/submissions");
  await expect(page.getByRole("link", { name: "Edit submission" }).first()).toBeVisible();

  await signInAs(page, "admin");
  await page.goto(`/admin/forms/${SEEDED_CFP}/settings`);
  await page.getByLabel("Until a date I choose").check();
  await page.getByLabel("Edit deadline").fill("2020-01-01T00:00");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByLabel("Until a date I choose")).toBeChecked();

  await signInAs(page, "speaker");
  await page.goto("/portal/submissions");
  await expect(
    page.getByText("Editing is closed because the deadline for changes has passed.").first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit submission" })).toHaveCount(0);

  // Restore the default policy, and prove the lock lifts again.
  await signInAs(page, "admin");
  await page.goto(`/admin/forms/${SEEDED_CFP}/settings`);
  await page.getByLabel("Until the close date above").check();
  await page.getByRole("button", { name: "Save settings" }).click();

  await signInAs(page, "speaker");
  await page.goto("/portal/submissions");
  await expect(page.getByRole("link", { name: "Edit submission" }).first()).toBeVisible();
});
