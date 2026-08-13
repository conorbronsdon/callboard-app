/**
 * Conor's live-demo report (demo.callboardhq.com, speaker one-click mode):
 * "when I upload a headshot it doesn't actually replace the speaker's image."
 *
 * Reproduced against a REAL browser tab because the defect is a DOM one, not
 * a data one: `people.headshot_key` repoints correctly on every replace
 * (`storeUpload`), so a fresh navigation always shows the current photo — the
 * unit suite that calls loaders directly (`app/routes/portal.profile.
 * headshot-refresh.test.tsx`) proves the served bytes are right. What that
 * suite CANNOT see is that the rendered `<img src>` for both the portal
 * profile avatar and the persistent nav-bar avatar was the SAME STRING before
 * and after a replace (`/portal/headshot/:personId` names WHO, never WHICH
 * photo), so React's reconciler never touched the attribute and a browser
 * that had already painted the old photo never re-requested it — independent
 * of any Cache-Control header. Only a live Chromium tab, driven through the
 * same client-side action + revalidate the product actually uses, can show
 * that a second network request never happened.
 *
 * `portalHeadshotHref` (`app/lib/portal-uploads.ts`) fixes it by putting the
 * CURRENT upload's id in the query string, mirroring how the public speaker
 * photo route already versions its URL by path segment (`public-
 * speakers.server.ts`).
 *
 * Covers all three DECISIONS #57/#66 surfaces named in the bug report:
 *   · the portal profile page (the speaker's own view) — MUST refresh,
 *   · the persistent portal nav-bar avatar — MUST refresh (same defect,
 *     same fix, different route: `portal.layout.tsx`),
 *   · the admin speaker record — MUST refresh, and its own upload path MUST
 *     NOT be mistaken for the speaker's consent (the public gate must still
 *     hold on a fresh admin-uploaded photo — DECISIONS #66).
 */
import { expect, test, type Page } from "@playwright/test";

const EVENT = "frontier-ai-summit-2026";
/** Seeded WITH a headshot and WITHOUT consent — scripts/seed.mjs. Fixed id, not a fixture. */
const RINA_ID = "000000pe-0000-4000-8000-000000000011";

async function signInAs(page: Page, role: "admin" | "speaker") {
  await page.goto("/demo");
  await page
    .getByRole("button", { name: role === "admin" ? "Enter organizer workspace" : "Enter speaker portal" })
    .click();
  await expect(page).toHaveURL(role === "admin" ? /\/admin$/ : /\/portal$/);
}

/** A real PNG signature (`upload-signatures.ts` sniffs it) with a distinguishing tail byte. */
function pngBuffer(tag: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag]);
}

async function uploadHeadshotBytes(page: Page, fileInputSelector: string, tag: number) {
  await page.locator(fileInputSelector).setInputFiles({
    name: `face-${tag}.png`,
    mimeType: "image/png",
    buffer: pngBuffer(tag),
  });
}

/** Confirms the URL the browser is NOW pointed at actually serves the given upload's bytes. */
async function expectServesTag(page: Page, src: string, tag: number) {
  const response = await page.request.get(src);
  expect(response.status()).toBe(200);
  const bytes = await response.body();
  expect(bytes.subarray(8, 10)).toEqual(Uint8Array.from([tag, tag]));
}

test("MUST FIRE: the portal profile avatar and the nav-bar avatar refresh on a replace, with no full page reload", async ({
  page,
}) => {
  await signInAs(page, "speaker");
  await page.goto("/portal/profile");

  const navAvatar = page.locator('header img[src^="/portal/headshot/"]');
  const profileAvatars = page.locator('main img[src^="/portal/headshot/"]');
  // Seeded WITH a headshot already (speaker@callboard.dev) — this is the
  // REPLACE case the live demo actually hit. A first-EVER upload (no src ->
  // a src) was never the bug: React always writes a brand-new attribute for
  // a null -> string change.
  await expect(navAvatar).toHaveCount(1);
  await expect(profileAvatars).toHaveCount(2);

  const beforeNav = (await navAvatar.getAttribute("src")) as string;
  const beforeProfile = (await profileAvatars.first().getAttribute("src")) as string;

  await uploadHeadshotBytes(page, "#headshot", 1);
  await page.getByRole("button", { name: "Upload headshot" }).click();
  await expect(page.getByText("Headshot updated.")).toBeVisible();

  // The bug, stated as an assertion: on the unfixed route both of these were
  // exactly `beforeNav` / `beforeProfile` again — same string, so the browser
  // had nothing to react to and kept showing the OLD photo.
  await expect(navAvatar).not.toHaveAttribute("src", beforeNav);
  await expect(profileAvatars.first()).not.toHaveAttribute("src", beforeProfile);
  await expect(profileAvatars.nth(1)).not.toHaveAttribute("src", beforeProfile);

  const afterFirstNav = (await navAvatar.getAttribute("src")) as string;
  const afterFirstProfile = (await profileAvatars.first().getAttribute("src")) as string;
  // Not just a different string — the STRING the browser now has actually
  // resolves to the bytes that were just uploaded.
  await expectServesTag(page, afterFirstProfile, 1);
  await expectServesTag(page, afterFirstNav, 1);

  // Replace again — proves this isn't a one-time null -> string fluke and
  // matches the report's own verb ("when I upload a headshot").
  await uploadHeadshotBytes(page, "#headshot", 2);
  await page.getByRole("button", { name: "Upload headshot" }).click();
  await expect(page.getByText("Headshot updated.")).toBeVisible();

  await expect(navAvatar).not.toHaveAttribute("src", afterFirstNav);
  await expect(profileAvatars.first()).not.toHaveAttribute("src", afterFirstProfile);

  const secondProfileSrc = (await profileAvatars.first().getAttribute("src")) as string;
  const secondCardSrc = (await profileAvatars.nth(1).getAttribute("src")) as string;
  const secondNavSrc = (await navAvatar.getAttribute("src")) as string;
  await expectServesTag(page, secondProfileSrc, 2);
  // Every avatar on screen agrees — header avatar, card avatar, nav avatar.
  expect(secondCardSrc).toBe(secondProfileSrc);
  expect(secondNavSrc).toBe(secondProfileSrc);
});

test("MUST FIRE: the admin speaker-record avatar refreshes on a replace", async ({ page }) => {
  await signInAs(page, "admin");
  await page.goto(`/admin/speakers/${RINA_ID}`);

  const adminAvatar = page.locator('[data-testid="speaker-headshot"] img[src^="/portal/headshot/"]');
  await expect(adminAvatar).toHaveCount(1); // Rina is seeded WITH a headshot.
  const before = (await adminAvatar.getAttribute("src")) as string;

  await uploadHeadshotBytes(page, "#admin-headshot", 3);
  await page.getByTestId("speaker-headshot-upload").click();
  await expect(page.getByText("Headshot replaced.")).toBeVisible();

  await expect(adminAvatar).not.toHaveAttribute("src", before);
  const after = (await adminAvatar.getAttribute("src")) as string;
  await expectServesTag(page, after, 3);
});

test("MUST NOT FIRE: an admin's fresh upload still renders a monogram, never a photo, on the public page", async ({
  page,
}) => {
  await signInAs(page, "admin");
  await page.goto(`/admin/speakers/${RINA_ID}`);

  // Rina starts with NO consent — confirm the admin's own instrumented state
  // before touching anything, so a failure below can't be blamed on a seed
  // that drifted.
  await expect(page.getByTestId("speaker-photo-visibility")).toHaveText(
    "Private — not shown on any public page.",
  );

  // The exact mechanism this bug lane changed: a brand-new upload, through
  // the admin replace path, under the NEW versioned URL.
  await uploadHeadshotBytes(page, "#admin-headshot", 4);
  await page.getByTestId("speaker-headshot-upload").click();
  await expect(page.getByText("Headshot replaced.")).toBeVisible();

  // Consent is untouched by an organizer's upload (DECISIONS #66) — the admin
  // preview may now update (it is authenticated), but the flag must not move.
  await expect(page.getByTestId("speaker-photo-visibility")).toHaveText(
    "Private — not shown on any public page.",
  );

  // The actual public surface, logged out in every way that matters (this
  // page's admin cookie carries no weight on `/e/...`): still a monogram.
  await page.goto(`/e/${EVENT}/speakers/${RINA_ID}`);
  await expect(page.locator("[data-speaker-detail]")).toBeVisible();
  await expect(page.locator("[data-speaker-detail] img")).toHaveCount(0);
  expect(await page.content()).not.toContain("/speaker-photo/");
});
