#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SEEDED_EVENT = "frontier-ai-summit-2026";
const SEEDED_CFP = "000000fo-0000-4000-8000-000000000001";
const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalUrl() {
  return args.find((arg, index) => {
    if (arg.startsWith("--")) return false;
    return index === 0 || !args[index - 1]?.startsWith("--");
  });
}

const rawBaseUrl = positionalUrl() ?? process.env.CALLBOARD_EVIDENCE_URL ?? "http://localhost:5173";
const baseUrl = new URL(rawBaseUrl);
const allowRemote = args.includes("--allow-remote");
const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);

if (!["http:", "https:"].includes(baseUrl.protocol)) {
  throw new Error("Evidence target must use http:// or https://");
}

if (!isLoopback && !allowRemote) {
  throw new Error(
    "Refusing to capture a remote deployment without --allow-remote. " +
      "Screenshots may expose target data; use only an authorized seeded demo.",
  );
}

const runId = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputDirectory = resolve(
  option("--out") ?? `artifacts/submission-evidence/${runId}`,
);

const manifest = {
  capturedAt: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  warning: "Review every screenshot for private data before sharing.",
  captures: [],
};

function target(pathname) {
  return new URL(pathname, `${baseUrl.origin}/`).href;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
}

async function assertHealthy(page, label, response) {
  if (!response) throw new Error(`${label}: navigation produced no response`);
  if (response.status() >= 400) {
    throw new Error(`${label}: ${response.status()} ${response.statusText()}`);
  }

  const text = (await page.locator("body").innerText()).trim();
  if (text.length < 20) throw new Error(`${label}: page body is unexpectedly empty`);
  if (/internal server error|application error|unexpected error/i.test(text)) {
    throw new Error(`${label}: page contains an error state`);
  }
}

async function capture(page, item) {
  const response = await page.goto(target(item.path), { waitUntil: "domcontentloaded" });
  await settle(page);
  await assertHealthy(page, item.label, response);

  const file = `${String(item.order).padStart(2, "0")}-${item.slug}-${item.viewport}.png`;
  await page.screenshot({ path: resolve(outputDirectory, file), fullPage: true });

  manifest.captures.push({
    order: item.order,
    file,
    label: item.label,
    caption: item.caption,
    path: item.path,
    finalUrl: page.url(),
    title: await page.title(),
    status: response.status(),
    viewport: page.viewportSize(),
  });
}

async function signIn(context, role) {
  const page = await context.newPage();
  const response = await page.goto(target("/demo"), { waitUntil: "domcontentloaded" });
  await settle(page);
  await assertHealthy(page, `Demo sign-in (${role})`, response);
  await page
    .getByRole("button", { name: role === "admin" ? "Enter organizer workspace" : "Enter speaker portal" })
    .click();
  await page.waitForURL(role === "admin" ? "**/admin" : "**/portal");
  await settle(page);
  await page.close();
}

function galleryHtml() {
  const cards = manifest.captures
    .sort((a, b) => a.order - b.order)
    .map(
      (captureItem) => `
        <article>
          <a href="${escapeHtml(captureItem.file)}">
            <img src="${escapeHtml(captureItem.file)}" alt="${escapeHtml(captureItem.label)}">
          </a>
          <div class="copy">
            <p class="eyebrow">${String(captureItem.order).padStart(2, "0")} · ${escapeHtml(captureItem.viewport)}</p>
            <h2>${escapeHtml(captureItem.label)}</h2>
            <p>${escapeHtml(captureItem.caption)}</p>
            <code>${escapeHtml(captureItem.path)}</code>
          </div>
        </article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Callboard submission evidence</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f4f3ff; color: #17152b; }
    header { max-width: 1500px; margin: auto; padding: 48px 28px 24px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 4rem); letter-spacing: -.04em; }
    header p { max-width: 760px; color: #58546f; font-size: 1.05rem; }
    main { max-width: 1500px; margin: auto; padding: 20px 28px 64px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
    article { overflow: hidden; background: white; border: 1px solid #dedaf7; border-radius: 18px; box-shadow: 0 16px 40px rgba(43, 34, 93, .08); }
    img { display: block; width: 100%; height: auto; background: #fafafa; }
    .copy { padding: 20px; }
    .eyebrow { margin: 0 0 5px; color: #6d43df; font-size: .75rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 0 0 8px; font-size: 1.25rem; }
    .copy p { margin: 0 0 12px; color: #5d5870; line-height: 1.5; }
    code { color: #4e2daf; font-size: .8rem; }
    @media (max-width: 800px) { main { grid-template-columns: 1fr; padding-inline: 16px; } header { padding-inline: 16px; } }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Captured ${escapeHtml(manifest.capturedAt)}</p>
    <h1>Callboard, end to end</h1>
    <p>Real seeded product surfaces, ordered from public intake through organizer operations and speaker follow-through. Appearance supports the story; the release ledger and automated checks prove behavior.</p>
  </header>
  <main>${cards}</main>
</body>
</html>`;
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const publicDesktop = await browser.newContext({ viewport: DESKTOP });
  const publicDesktopPage = await publicDesktop.newPage();
  await capture(publicDesktopPage, {
    order: 1,
    slug: "public-event",
    viewport: "desktop",
    label: "Public event",
    caption: "A branded entry point for speakers and attendees.",
    path: `/e/${SEEDED_EVENT}`,
  });
  await publicDesktop.close();

  const publicMobile = await browser.newContext({ viewport: MOBILE });
  const publicMobilePage = await publicMobile.newPage();
  await capture(publicMobilePage, {
    order: 2,
    slug: "cfp-welcome",
    viewport: "mobile",
    label: "CFP welcome",
    caption: "The mobile-first starting point for a real seeded submission form.",
    path: `/submit/${SEEDED_EVENT}/${SEEDED_CFP}`,
  });
  await publicMobile.close();

  const admin = await browser.newContext({ viewport: DESKTOP });
  await signIn(admin, "admin");
  const adminPage = await admin.newPage();
  const adminCaptures = [
    [3, "command-centre", "Command centre", "Event health, counts, and the organizer's next actions.", "/admin"],
    [4, "form-builder", "Form builder", "CFP configuration, routing, validation, and publishing controls.", "/admin/forms"],
    [5, "review-workbench", "Review workbench", "Seeded proposals in the pending decision pipeline.", "/admin/submissions?tab=pending"],
    [6, "schedule-planner", "Schedule planner", "Room and time placement with dedicated conflict visibility.", "/admin/agenda"],
    [7, "communications", "Communications", "Templates and delivery history for speaker follow-through.", "/admin/comms"],
    [8, "integrations", "Integrations and API", "Portable data paths without putting integrations in the critical path.", "/admin/integrations"],
  ];
  for (const [order, slug, label, caption, path] of adminCaptures) {
    await capture(adminPage, { order, slug, viewport: "desktop", label, caption, path });
  }
  await admin.close();

  const programme = await browser.newContext({ viewport: DESKTOP });
  const programmePage = await programme.newPage();
  await capture(programmePage, {
    order: 9,
    slug: "public-programme",
    viewport: "desktop",
    label: "Public programme",
    caption: "The published schedule turns organizer work into an attendee-facing outcome.",
    path: `/e/${SEEDED_EVENT}/schedule`,
  });
  await programme.close();

  const speaker = await browser.newContext({ viewport: MOBILE });
  await signIn(speaker, "speaker");
  const speakerPage = await speaker.newPage();
  const speakerCaptures = [
    [10, "speaker-portal", "Speaker portal", "Status and one clear next action on a phone-sized screen.", "/portal"],
    [11, "speaker-tasks", "Speaker tasks", "A focused checklist for onboarding and event readiness.", "/portal/tasks"],
    [12, "speaker-resources", "Speaker resources", "Organizer-provided guidance available in the same portal.", "/portal/resources"],
  ];
  for (const [order, slug, label, caption, path] of speakerCaptures) {
    await capture(speakerPage, { order, slug, viewport: "mobile", label, caption, path });
  }
  await speaker.close();

  await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "index.html"), galleryHtml());
  process.stdout.write(`Captured ${manifest.captures.length} evidence images in ${outputDirectory}\n`);
} finally {
  await browser.close();
}
