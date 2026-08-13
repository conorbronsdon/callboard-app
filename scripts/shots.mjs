#!/usr/bin/env node
/**
 * Screenshot harness for the rung-4 visual pass. NOT release evidence and NOT
 * wired into any gate — it drives Playwright's browser directly against an
 * already-running dev server so a human (or an agent) can look at renders.
 *
 * Usage: node scripts/shots.mjs <out-dir> [--port 5194]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const outDir = process.argv[2] ?? "shots/before";
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? process.argv[portArg + 1] : "5194";
const BASE = `http://localhost:${PORT}`;
const SLUG = "frontier-ai-summit-2026";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "375", width: 375, height: 812 },
];
const SCHEMES = ["light", "dark"];

mkdirSync(outDir, { recursive: true });

async function shoot(page, path, name) {
  const url = path.startsWith("http") ? path : BASE + path;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(250);

  /*
   * A run that photographs Vite's error overlay is worse than no run: the PNGs
   * are the right size, the right count and the right names, and every one of
   * them is a stack trace. A whole "after" set was captured that way from a
   * transform error the dev server had cached mid-edit. The overlay is a
   * closed shadow root, so its presence is checked by element, not by text.
   */
  const overlay = await page.locator("vite-error-overlay").count();
  if (overlay > 0) {
    throw new Error(
      `${name}: Vite error overlay is on screen. Restart the dev server and re-run — these shots are not renders.`,
    );
  }

  await page.screenshot({ path: join(outDir, name + ".png"), fullPage: true });
  return page.url();
}

async function signIn(context, role) {
  const page = await context.newPage();
  await page.goto(BASE + "/demo", { waitUntil: "networkidle" });
  const label = role === "admin" ? "Enter organizer workspace" : "Enter speaker portal";
  const landing = role === "admin" ? "/admin" : "/portal";
  // Await the POST's redirect explicitly. Awaiting `click()` alone races the
  // navigation, and closing the page mid-flight aborts the sign-in silently —
  // which is how the first run captured /login under four different names.
  await Promise.all([
    page.waitForURL((u) => u.pathname.startsWith(landing), { waitUntil: "networkidle" }),
    page.getByRole("button", { name: label }).click(),
  ]);
  await page.close();

  const probe = await context.newPage();
  await probe.goto(BASE + landing, { waitUntil: "networkidle" });
  const reached = new URL(probe.url()).pathname;
  await probe.close();
  if (!reached.startsWith(landing)) {
    throw new Error(`${role} sign-in did not stick: ${landing} redirected to ${reached}`);
  }
}

async function firstHref(context, listPath, pattern) {
  const page = await context.newPage();
  await page.goto(BASE + listPath, { waitUntil: "networkidle" });
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  await page.close();
  return hrefs.find((h) => h && pattern.test(h)) ?? null;
}

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    const tag = `${vp.name}-${scheme}`;
    const ctxOpts = {
      viewport: { width: vp.width, height: vp.height },
      colorScheme: scheme,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    };

    /* ── anonymous: the public surfaces + /demo ── */
    const anon = await browser.newContext(ctxOpts);
    const anonPage = await anon.newPage();
    await shoot(anonPage, "/demo", `${tag}__demo`);
    await shoot(anonPage, "/", `${tag}__public-home`);
    await shoot(anonPage, `/e/${SLUG}`, `${tag}__public-event`);
    await shoot(anonPage, `/e/${SLUG}/schedule`, `${tag}__public-schedule`);
    await shoot(anonPage, `/e/${SLUG}/speakers`, `${tag}__public-speakers`);
    const speakerHref = await firstHref(anon, `/e/${SLUG}/speakers`, /\/speakers\/[0-9a-f]/);
    if (speakerHref) await shoot(anonPage, speakerHref, `${tag}__public-speaker`);
    await anon.close();

    /* ── organizer ── */
    const admin = await browser.newContext(ctxOpts);
    await signIn(admin, "admin");
    const adminPage = await admin.newPage();
    await shoot(adminPage, "/admin", `${tag}__admin-dashboard`);
    await shoot(adminPage, "/admin/submissions", `${tag}__admin-submissions`);
    const subHref = await firstHref(admin, "/admin/submissions", /\/admin\/submissions\/[0-9a-f]/);
    if (subHref) await shoot(adminPage, subHref, `${tag}__admin-submission-detail`);
    await shoot(adminPage, "/admin/reviews", `${tag}__admin-reviews`);
    await shoot(adminPage, "/admin/agenda", `${tag}__admin-agenda`);
    await shoot(adminPage, "/admin/contacts", `${tag}__admin-contacts`);
    await shoot(adminPage, "/admin/speakers", `${tag}__admin-speakers`);
    await admin.close();

    /* ── speaker portal ── */
    const speaker = await browser.newContext(ctxOpts);
    await signIn(speaker, "speaker");
    const speakerPage = await speaker.newPage();
    await shoot(speakerPage, "/portal", `${tag}__portal-home`);
    const taskHref = await firstHref(speaker, "/portal/tasks", /\/portal\/tasks\/[0-9a-f]/);
    if (taskHref) await shoot(speakerPage, taskHref, `${tag}__portal-task`);
    await speaker.close();

    console.log(`[shots] ${tag} done`);
  }
}

await browser.close();
console.log(`[shots] wrote to ${outDir}`);
