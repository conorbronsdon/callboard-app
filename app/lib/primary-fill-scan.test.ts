/**
 * One primary button colour, as a check that can fail.
 *
 * Rung 3.1 and 3.C converted fifteen hand-rolled black primary fills across
 * fourteen files to `buttonClass()`. Nothing enforced the result, so #91 —
 * which merged after #88 — reintroduced one on the new-event screen and every
 * gate stayed green on a regression you can see from across the room. In dark
 * mode the raw fill inverts to near-white, making a secondary action the
 * brightest object on the page next to a blue `Switch event`.
 *
 * This is the rung-3 brief's D2 detector, moved from a command somebody has to
 * remember to run into the suite that runs on every commit. Same regex, and
 * the controls that make it trustworthy run first: it must FIND a planted fill
 * and must IGNORE the `dark:` and `hover:…/50` variants that are legitimate
 * surface colours everywhere in the product.
 *
 * A hit here is not "reformat the class". It means an element grew its own
 * primary colour instead of asking `buttonClass()` for one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `bg-gray-900` as a whole utility — start of line, or bounded by a quote,
 * space or backtick. `dark:bg-gray-900` and `hover:bg-gray-900/50` are
 * deliberately NOT matched: the first is the standard dark surface and the
 * second is a hover tint, neither of which is a primary fill.
 */
const RAW_PRIMARY_FILL = /(^|[" `])bg-gray-900[ "`]/;

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTsx(full);
    else if (entry.endsWith(".tsx")) yield full;
  }
}

function hits(): string[] {
  const found: string[] = [];
  for (const file of walkTsx(APP_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (RAW_PRIMARY_FILL.test(line)) {
        found.push(`${relative(APP_DIR, file).replace(/\\/g, "/")}:${index + 1}`);
      }
    });
  }
  return found.sort();
}

describe("the detector is worth trusting before we trust it", () => {
  it("MUST FIRE: it finds a real black fill", () => {
    expect(RAW_PRIMARY_FILL.test('c className="rounded bg-gray-900 px-3"')).toBe(true);
    expect(RAW_PRIMARY_FILL.test("const BUTTON = `bg-gray-900 px-3 py-1.5`;")).toBe(true);
  });

  it("MUST NOT FIRE: dark surfaces and hover tints are not primary fills", () => {
    expect(RAW_PRIMARY_FILL.test('a className="dark:bg-gray-900"')).toBe(false);
    expect(RAW_PRIMARY_FILL.test('b className="hover:bg-gray-900/50"')).toBe(false);
    expect(RAW_PRIMARY_FILL.test('d className="dark:bg-gray-900/60 sm:p-5"')).toBe(false);
  });

  it("NEGATIVE CONTROL: the walker really reads the app", () => {
    // Without this, a walker that found no files would make the assertion
    // below pass forever.
    const files = [...walkTsx(APP_DIR)];
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("portal-ui.tsx"))).toBe(true);
    // And the corpus really does contain the strings we are choosing to ignore.
    const anyDarkSurface = files.some((file) =>
      readFileSync(file, "utf8").includes("dark:bg-gray-900"),
    );
    expect(anyDarkSurface).toBe(true);
  });
});

describe("the product ships one primary button colour", () => {
  it("no component rolls its own black primary fill", () => {
    // Red on the pre-fix tree: the `Create event` button in
    // `app/routes/admin.events.new.tsx` (`:219` at 3801d8b).
    expect(hits()).toEqual([]);
  });
});
