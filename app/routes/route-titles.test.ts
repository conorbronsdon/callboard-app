/**
 * Every rendered surface names itself in the browser's title bar.
 *
 * The public and portal families already do this (`public.event.tsx`,
 * `portal.index.tsx`, …): a route exports `meta` and returns
 * `[{ title: "… — callboard" }]`. `/admin/*`, `/review` and `/embed/*` never
 * did — thirty rendered screens shipped with no `<title>` at all, so every
 * organizer tab, bookmark and browser-history entry for the workspace was
 * indistinguishable from every other one.
 *
 * This is a SWEEP, not a handful of pins, because the defect was an omission:
 * pinning four routes would leave the twenty-six that nobody remembered to
 * check exactly as broken as they were. The sweep walks the filesystem for
 * rendered routes in those three families and fails on the one a future lane
 * forgets.
 *
 * Two things make the sweep more than a shape assertion:
 *
 *  - `meta` is CALLED, with `loaderData: undefined` — the state a real request
 *    is in when the loader threw — and the returned title must be a non-empty
 *    string. A `meta` that returns `[{}]`, `[{ title: "" }]`, or that crashes
 *    without loader data, fails here rather than in a browser.
 *  - every leaf title must be DISTINCT from the layout's fallback, so bulk
 *    `meta` that returns the same generic string thirty times does not pass.
 *
 * Exact strings for four representative routes are pinned separately below; the
 * sweep governs coverage, the pins govern wording.
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

/** The admin-shell fallback every leaf must override with something specific. */
const ADMIN_FALLBACK = "callboard admin";

/**
 * Routes that render a page but are not `/admin` leaves, so they carry their
 * own title rather than overriding the admin layout's.
 */
const STANDALONE = new Set(["review.index.tsx"]);

/**
 * `/admin/*` modules with no default export: `admin.event.tsx` and
 * `admin.jobs.run.tsx` are action-only (they redirect), and a resource route
 * returns bytes. Nothing renders, so nothing needs a title. Derived by reading
 * the module rather than hard-coding, so converting one into a real page moves
 * it into the sweep automatically.
 */
function renderedRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => /\.tsx$/.test(name) && !name.includes(".test."))
    .filter(
      (name) =>
        name.startsWith("admin.") || name.startsWith("embed.") || STANDALONE.has(name),
    )
    .sort();
}

type MetaDescriptor = { title?: unknown };

/** Call a route's `meta` the way React Router would with no loader data. */
async function titleOf(file: string): Promise<string | undefined> {
  const mod = (await import(/* @vite-ignore */ `./${file.replace(/\.tsx$/, "")}`)) as {
    default?: unknown;
    meta?: (args: unknown) => MetaDescriptor[];
  };
  if (typeof mod.meta !== "function") return undefined;
  const descriptors = mod.meta({
    loaderData: undefined,
    params: {},
    location: { pathname: "/", search: "", hash: "", state: null, key: "t" },
    matches: [],
  });
  const entry = descriptors.find((d) => typeof d?.title === "string");
  return entry ? (entry.title as string) : undefined;
}

/* ───────────────────────────────── must-fire: nothing renders untitled ── */

describe("every rendered admin, reviewer and embed route sets a title", () => {
  const files = renderedRouteFiles();

  it("finds the routes it claims to police", () => {
    // A sweep whose glob quietly matched nothing would pass every assertion
    // below. Pin the shape of the corpus so an empty walk fails loudly.
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files).toContain("admin.layout.tsx");
    expect(files).toContain("admin.submissions.tsx");
    expect(files).toContain("review.index.tsx");
    expect(files.filter((f) => f.startsWith("embed."))).toHaveLength(4);
  });

  for (const file of renderedRouteFiles()) {
    it(`${file} returns a non-empty title with no loader data`, async () => {
      const mod = (await import(/* @vite-ignore */ `./${file.replace(/\.tsx$/, "")}`)) as {
        default?: unknown;
      };
      // Action-only modules render nothing, so they are exempt by construction.
      if (!mod.default) return;

      const title = await titleOf(file);
      expect(title, `${file} exports no meta title`).toBeTypeOf("string");
      expect(title!.trim(), `${file} title is blank`).not.toBe("");
    });
  }

  it("gives every admin leaf a title distinct from the shell fallback", async () => {
    // The control on the sweep above: thirty routes all returning
    // "callboard admin" would satisfy "non-empty" and still leave the tab strip
    // unreadable, which is the actual defect.
    const layoutTitle = await titleOf("admin.layout.tsx");
    expect(layoutTitle).toBe(ADMIN_FALLBACK);

    const leaves = renderedRouteFiles().filter(
      (file) => file.startsWith("admin.") && file !== "admin.layout.tsx",
    );
    const duplicates: string[] = [];
    for (const file of leaves) {
      const mod = (await import(/* @vite-ignore */ `./${file.replace(/\.tsx$/, "")}`)) as {
        default?: unknown;
      };
      if (!mod.default) continue;
      if ((await titleOf(file)) === layoutTitle) duplicates.push(file);
    }
    expect(duplicates).toEqual([]);
  });
});

/* ──────────────────────────────────────── the wording, on four routes ── */

describe("representative titles read as the screen they name", () => {
  it("pins the abstracts list", async () => {
    expect(await titleOf("admin.submissions.tsx")).toBe("Submissions — callboard admin");
  });

  it("pins the speaker roster", async () => {
    expect(await titleOf("admin.speakers.tsx")).toBe("Speakers — callboard admin");
  });

  it("pins the reviewer workspace, which is not under /admin", async () => {
    expect(await titleOf("review.index.tsx")).toBe("Reviewer workspace — callboard");
  });

  it("names the widget on a chrome-less embed", async () => {
    // No loader data: an embed whose event failed to load still says what it is.
    expect(await titleOf("embed.schedule.tsx")).toBe("Schedule — callboard");
  });
});

/* ───────────────────────── must-fire: a detail route uses its own record ── */

describe("detail routes prefer the record's name over the generic label", () => {
  it("titles an abstract with its title when the loader ran", async () => {
    const mod = (await import("./admin.submission")) as {
      meta: (args: unknown) => MetaDescriptor[];
    };
    const withData = mod.meta({
      loaderData: { detail: { title: "Cost modelling for multi-agent systems" } },
      params: {},
      location: { pathname: "/", search: "", hash: "", state: null, key: "t" },
      matches: [],
    });
    expect(withData.find((d) => typeof d.title === "string")?.title).toBe(
      "Cost modelling for multi-agent systems — callboard admin",
    );
  });

  it("must NOT fire: a missing abstract falls back to the generic label", async () => {
    // The not-found render has `detail: null`. Reading `.title` off it would
    // throw inside `meta`, which React Router surfaces as a broken document.
    expect(await titleOf("admin.submission.tsx")).toBe("Abstract — callboard admin");
  });

  it("names the event on an embed once the loader ran", async () => {
    const mod = (await import("./embed.schedule")) as {
      meta: (args: unknown) => MetaDescriptor[];
    };
    const descriptors = mod.meta({
      loaderData: { event: { name: "Agents Summit" } },
      params: {},
      location: { pathname: "/", search: "", hash: "", state: null, key: "t" },
      matches: [],
    });
    expect(descriptors.find((d) => typeof d.title === "string")?.title).toBe(
      "Schedule — Agents Summit",
    );
  });
});
