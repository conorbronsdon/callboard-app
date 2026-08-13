#!/usr/bin/env node
/**
 * Layout regression check for the /admin/submissions status editor.
 *
 * Measures how much of the panel survives its ancestors' overflow clips, at
 * 1280 and 375. A unit test can assert the class list; only a real browser can
 * tell you the panel is 224x212 but the operator can see 77x5 of it — which is
 * exactly what an absolutely-positioned panel inside the table's
 * `overflow-x-auto` wrapper produced.
 *
 * Red/green control: revert the panel to `absolute` and the numbers collapse.
 *
 *   npm run dev -- --port 5199 --strictPort
 *   npm run check:popover                    # or: node scripts/check-status-popover.mjs <url> <label>
 *
 * Expected: `visibleAfterClips` equals `panel` at both widths.
 */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:5199";
const LABEL = process.argv[3] ?? "current";

const browser = await chromium.launch();
let failures = 0;

for (const vp of [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(`${BASE}/demo`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Enter as admin/i }).click();
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
  await page.goto(`${BASE}/admin/submissions`, { waitUntil: "networkidle" });

  const summary = page.locator("td details > summary").last();
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await page.waitForTimeout(200);

  // NO scrollIntoViewIfNeeded on the panel: that would scroll the table's own
  // overflow box and hide the very clipping being measured. This is what the
  // operator sees the instant they click the pill.
  const popover = page.locator('form[data-testid^="status-popover-"]').last();

  const result = await popover.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    let top = rect.top;
    let bottom = rect.bottom;
    let left = rect.left;
    let right = rect.right;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") {
        continue;
      }
      const clip = node.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    return {
      panel: { w: Math.round(rect.width), h: Math.round(rect.height) },
      afterAncestorClips: {
        w: Math.round(Math.max(0, right - left)),
        h: Math.round(Math.max(0, bottom - top)),
      },
    };
  });

  // Second question, asked separately: once the operator scrolls to it, is the
  // whole thing on screen? Needing a scroll is fine. Being unreachable is not.
  await popover.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const radios = popover.locator('input[type="radio"]');
  const n = await radios.count();
  const onScreen = [];
  for (let i = 0; i < n; i += 1) {
    const b = await radios.nth(i).boundingBox();
    onScreen.push(
      Boolean(b) &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.x + b.width <= vp.width &&
        b.y + b.height <= vp.height,
    );
  }

  const unclipped =
    result.afterAncestorClips.w === result.panel.w &&
    result.afterAncestorClips.h === result.panel.h;
  const reachable = n === 5 && onScreen.every(Boolean);
  if (!unclipped || !reachable) failures += 1;

  console.log(
    `[${LABEL}] ${vp.width}px  panel=${result.panel.w}x${result.panel.h}  ` +
      `visibleAfterClips=${result.afterAncestorClips.w}x${result.afterAncestorClips.h}  ` +
      `unclipped=${unclipped}  options=${n}  allOptionsOnScreenAfterScroll=${reachable}`,
  );
  await page.close();
}

await browser.close();

if (failures > 0) {
  console.error(`check:popover FAILED at ${failures} viewport(s).`);
  process.exit(1);
}
console.log("check:popover ok — the status editor is whole at 1280px and 375px.");
