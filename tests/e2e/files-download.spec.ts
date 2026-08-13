/**
 * The bulk download, driven through the browser against a real dev server.
 *
 * This file exists because the unit suite could not see the bug it catches.
 * All four `bulk download (CNT-14)` cases in `app/routes/admin.files.test.tsx`
 * call `action()` directly and read the `Response` it returns, so they were
 * green while the button on `/admin/files` returned a 500 HTML error page and
 * no ZIP at all. A raw `Response` returned from a UI route's action never
 * reaches the browser: `react-router/dist/development/lib/server-runtime/
 * server.js:117` only takes the resource-route path when the LEAF module has no
 * `default` export, so a document POST to a route with a component goes through
 * `handleDocumentRequest` → `submit()` → `convertDataStrategyResultToDataResult`
 * (`router.js:2505`), which reads the body with `response.text()` and hands the
 * decoded bytes back as `actionData`. The archive is destroyed on the way out
 * and the component then throws on `"ok" in actionData`.
 *
 * So the assertions here are the ones only a real request can make: the status,
 * the content type the browser receives, and whether the bytes parse as an
 * archive holding the files that were ticked. `page.request` carries the same
 * session cookie as the page, so the route's own `requireAdmin` runs for real.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

async function enterOrganizerWorkspace(page: Page) {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter organizer workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/**
 * Minimal central-directory reader: entry names and their stored bytes.
 *
 * Reading the CENTRAL directory rather than scanning for local headers is
 * deliberate — an archive whose central directory disagrees with its local
 * headers is the exact corruption a truncated or re-encoded body produces, and
 * every real unzip tool reads the central directory first.
 */
function readZip(buffer: Buffer): { names: string[]; text: string } {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record: not a ZIP");

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`central directory record ${i} has a bad signature`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { names, text: buffer.toString("latin1") };
}

test("Generate download returns a real ZIP of the ticked files, not an error page", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);
  await page.goto("/admin/files");

  // Tick two DIFFERENT deliverables. One would pass against an implementation
  // that ignored the selection and shipped the whole event.
  await page.getByRole("checkbox", { name: "Select talk-outline.md" }).check();
  await page.getByRole("checkbox", { name: "Select run-of-show.txt" }).check();

  /*
   * Both halves are asserted, and they check different things.
   *
   * `waitForResponse` sees the HTTP reply — the status and the headers, which
   * are what went wrong before (500, `text/html`). `waitForEvent("download")`
   * sees what CHROME DID with it: a browser only raises this event when the
   * response is a file it is saving, so a page that happened to return
   * `content-type: application/zip` on a rendered document would satisfy the
   * headers and never fire the download. Reading the bytes from the saved file
   * is also the only way to get them; `response.body()` is unavailable once the
   * navigation is discarded, which is exactly what a real download does.
   */
  const [response, saved] = await Promise.all([
    page.waitForResponse((request) => request.request().method() === "POST"),
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Generate download" }).click(),
  ]);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/zip");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(saved.suggestedFilename()).toBe("callboard-files.zip");

  const savedPath = await saved.path();
  const archive = readZip(readFileSync(savedPath));
  expect(archive.names.sort()).toEqual(["run-of-show.txt", "talk-outline.md"]);
  // Stored (method 0), so the source bytes sit in the archive verbatim. The
  // deck's LATEST version is what the library offers, so v2's text — not v1's —
  // is what must be inside.
  expect(archive.text).toContain("v2, with demo timings");
  expect(archive.text).not.toContain("outline (draft)");
  expect(archive.text).toContain("HDMI, no adapter needed");
});

test("MUST NOT FIRE: ticking nothing explains itself instead of shipping an empty archive", async ({
  page,
}) => {
  await enterOrganizerWorkspace(page);
  await page.goto("/admin/files");

  await page.getByRole("button", { name: "Generate download" }).click();

  // Back on the library with a message — not a downloaded zero-entry ZIP.
  await expect(page).toHaveURL(/\/admin\/files\?/);
  await expect(page.getByText("Select at least one file")).toBeVisible();
});

test("MUST NOT FIRE: a signed-in speaker cannot reach the download endpoint", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Enter speaker portal", exact: true }).click();
  await expect(page).toHaveURL(/\/portal/);

  const response = await page.request.post("/admin/files/download", {
    form: { uploadIds: "anything" },
  });
  expect(response.status()).toBe(403);
});
