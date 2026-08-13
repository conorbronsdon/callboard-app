/**
 * One eyebrow, one field class, one primary blue — as checks that can fail.
 *
 * `primary-fill-scan.test.ts` is the precedent and the reason this file exists:
 * rung 3 converted fifteen hand-rolled black primaries to `buttonClass()`,
 * nothing enforced the result, and #91 put one straight back. The same shape of
 * drift had already happened three more times without anybody naming it:
 *
 *  - The `text-eyebrow` size token was painted with `text-gray-500 uppercase`
 *    by hand in fifteen places, and six of them omitted the dark variant.
 *    `text-gray-500` on `dark:bg-gray-900` measures 3.67:1, under AA for the
 *    11px an eyebrow is always used at. A shared string is the only way that
 *    half gets fixed once.
 *  - Two routes carried a private `FIELD_CLASS` that had drifted from the
 *    shared `inputClass` in three ways at once (no focus ring, different
 *    radius, `dark:bg-gray-900` where the card behind it is also gray-900).
 *  - Four buttons carried their own blue fill, and TWO of them were a
 *    different blue (`bg-blue-700`) from `buttonClass("primary")`'s
 *    `bg-blue-600` — on public pages a visitor reaches from the same nav.
 *
 * The controls that make these trustworthy run FIRST and are not decoration:
 * each detector must FIRE on a planted violation and must NOT fire on the
 * legitimate variants that exist in the tree today, and every carve-out is
 * pinned by a must-still-fire case beside its must-not-fire one.
 *
 * A hit here is not "reformat the class". It means an element grew its own copy
 * of a token instead of importing the one the product ships.
 *
 * ── Why the allowances are COUNTS, not `path:line` strings ──
 * The first version of this file pinned every outstanding field-class site to
 * `path:LINE`. Rebasing this branch onto four merged lanes moved twenty of the
 * twenty-one line numbers and turned the suite red with ZERO new violations —
 * a check that fails on other people's blank lines trains its reader to edit
 * the expectation without looking. Counts per file survive line moves and still
 * fail the moment a file grows another copy.
 *
 * What counts do NOT catch, said out loud: deleting one copy and planting
 * another somewhere else in the SAME already-allowed file. That is the price of
 * not pinning lines. It is the right trade — the line-pinned version broke on a
 * rebase that changed nothing, while a same-file swap is not a drift mode
 * anybody here has produced.
 *
 * When one of these fails, the count tells you which file; open it and grep for
 * `uppercase` / `border-gray-300` / `bg-blue-` to find the site.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where each token is allowed to be spelled out, because it is defined there. */
const EYEBROW_HOME = "components/shell.tsx";
const FIELD_HOME = "components/portal-ui.tsx";
const PRIMARY_HOME = "components/portal-ui.tsx";

/** This file plants violations in its own source on purpose. */
const SELF = "lib/design-tokens-scan.test.ts";

/**
 * A hand-rolled GRAY eyebrow: a micro-size, uppercase label painted with the
 * standard muted foreground. Matching only the `text-eyebrow` spelling was the
 * bug in the first version of this detector, and the measurement is worse than
 * it sounds: of the sixteen hand-rolled eyebrows left in the tree, SIXTEEN
 * spell the size `text-xs` and ZERO spell it `text-eyebrow`. The narrow
 * detector found none of them, so a planted
 * `text-xs font-semibold tracking-wide text-gray-500 uppercase` sailed past a
 * test named "no component rolls its own gray eyebrow". Weight is deliberately
 * NOT part of the match: `font-medium`, `font-semibold` and no weight at all
 * are all the same mistake.
 *
 * Two families are deliberately NOT matched, each for a measured reason:
 *
 *  - The tone override on the /demo hero band (`text-eyebrow … text-blue-100`).
 *    It sits on a blue-600 fill where the shared gray would be invisible, and a
 *    caller cannot override a colour by appending one — Tailwind resolves
 *    conflicting utilities by stylesheet order, not class order.
 *  - `text-gray-600` labels on tinted bands (portal home's "Next up" strip,
 *    `admin.viewas`'s table heads). Converting those to the token's gray-500
 *    would take them BELOW AA: computing the built stylesheet's own oklch
 *    values through the WCAG luminance formula, gray-500 measures 4.44:1 on
 *    `bg-blue-50` and 4.40:1 on `bg-rose-50`, against gray-600's 6.94:1 and
 *    6.87:1. A detector that forces a contrast regression is worse than none.
 */
const MICRO_SIZE = /(^|[" `])text-(eyebrow|xs|\[1[01]px\])[ "`]/;
const UPPERCASE = /(^|[" `])uppercase[ "`]/;
const MUTED_FOREGROUND = /(^|[" `])text-gray-500[ "`]/;
const HAND_ROLLED_EYEBROW = (line: string) =>
  MICRO_SIZE.test(line) && UPPERCASE.test(line) && MUTED_FOREGROUND.test(line);

/** A private copy of the shared field class: a full-width bordered input well. */
const HAND_ROLLED_FIELD = (line: string) =>
  /(^|[" `])w-full rounded(-lg)? border border-gray-300[^"`]*px-3 py-2/.test(line);

/**
 * A hand-rolled blue button fill. Bounded utilities, so the variants that are
 * legitimate everywhere in the product are not matched: `hover:bg-blue-700` is
 * the shared helper's own hover, `dark:bg-blue-600` is a dark-mode surface, and
 * `file:bg-blue-600` styles the `::file-selector-button` pseudo-element, which
 * cannot be handed a class string at all.
 */
const BLUE_FILL = /(^|[" `])bg-blue-(500|600|700)[ "`]/;
const WHITE_TEXT = /(^|[" `])text-white[ "`]/;
const HAND_ROLLED_PRIMARY = (line: string) => BLUE_FILL.test(line) && WHITE_TEXT.test(line);

/* ------------------------------------------------------------- the corpus */

type Corpus = Record<string, string[]>;
/** Relative path → number of matching lines. Files with none are omitted. */
type Counts = Record<string, number>;

function* walkSource(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkSource(full);
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) yield full;
  }
}

function readAppCorpus(home: string): Corpus {
  const corpus: Corpus = {};
  for (const file of walkSource(APP_DIR)) {
    const rel = relative(APP_DIR, file).replace(/\\/g, "/");
    if (rel === home || rel === SELF) continue;
    corpus[rel] = readFileSync(file, "utf8").split("\n");
  }
  return corpus;
}

function countsIn(corpus: Corpus, match: (line: string) => boolean): Counts {
  const counts: Counts = {};
  for (const [rel, lines] of Object.entries(corpus)) {
    const n = lines.filter(match).length;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

/* --------------------------------------------------- controls on detectors */

describe("the detectors are worth trusting before we trust them", () => {
  it("MUST FIRE: a hand-rolled gray eyebrow is found, in every spelling", () => {
    expect(
      HAND_ROLLED_EYEBROW('<p className="text-eyebrow font-semibold text-gray-500 uppercase">'),
    ).toBe(true);
    expect(
      HAND_ROLLED_EYEBROW(
        '<thead className="text-eyebrow font-semibold text-gray-500 uppercase dark:text-gray-400">',
      ),
    ).toBe(true);
    // The regression that named this file: `text-xs`, not `text-eyebrow`.
    expect(
      HAND_ROLLED_EYEBROW(
        '<p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Status</p>',
      ),
    ).toBe(true);
    // Weight is not part of the match, and neither is class order.
    expect(
      HAND_ROLLED_EYEBROW('<dt className="text-xs font-medium tracking-wide text-gray-500 uppercase">'),
    ).toBe(true);
    expect(HAND_ROLLED_EYEBROW('<p className="text-xs uppercase tracking-wide text-gray-500">')).toBe(
      true,
    );
    expect(HAND_ROLLED_EYEBROW('<span className="text-[11px] text-gray-500 uppercase">')).toBe(true);
  });

  it("MUST NOT FIRE: the shared class, the blue band, and the gray-600 tinted-band label", () => {
    expect(HAND_ROLLED_EYEBROW("<p className={eyebrowClass}>Public events</p>")).toBe(false);
    expect(HAND_ROLLED_EYEBROW("<p className={`mb-2 ${eyebrowClass}`}>{lane}</p>")).toBe(false);
    expect(HAND_ROLLED_EYEBROW("<h3 className={`${eyebrowClass} tracking-wide`}>Abstract</h3>")).toBe(
      false,
    );
    expect(
      HAND_ROLLED_EYEBROW('<p className="text-eyebrow font-semibold text-blue-100 uppercase">'),
    ).toBe(false);
    expect(
      HAND_ROLLED_EYEBROW('<p className="text-xs font-medium tracking-wide text-gray-600 uppercase">'),
    ).toBe(false);
    // Not every micro gray text is an eyebrow. A caption is not a label.
    expect(HAND_ROLLED_EYEBROW('<p className="mt-4 text-xs text-gray-500">Seeded as {email}</p>')).toBe(
      false,
    );
  });

  it("MUST STILL FIRE: the same lines the two carve-outs excuse, minus the excuse", () => {
    // The blue band is excused for its COLOUR. In gray it is a violation.
    expect(
      HAND_ROLLED_EYEBROW('<p className="text-eyebrow font-semibold text-gray-500 uppercase">'),
    ).toBe(true);
    // The tinted-band label is excused for gray-600. In gray-500 it is a
    // violation — which is the whole point: it must not drift into the token.
    expect(
      HAND_ROLLED_EYEBROW('<p className="text-xs font-medium tracking-wide text-gray-500 uppercase">'),
    ).toBe(true);
  });

  it("MUST FIRE: a private copy of the field class is found", () => {
    expect(
      HAND_ROLLED_FIELD(
        'const FIELD_CLASS = "w-full rounded border border-gray-300 px-3 py-2 dark:bg-gray-900";',
      ),
    ).toBe(true);
    expect(
      HAND_ROLLED_FIELD(
        '  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"',
      ),
    ).toBe(true);
  });

  it("MUST NOT FIRE: the shared class, and surfaces that are not form fields", () => {
    expect(HAND_ROLLED_FIELD("<input className={inputClass} />")).toBe(false);
    expect(HAND_ROLLED_FIELD("className={`${SNIPPET_CLASS} min-h-24 flex-1 font-mono text-xs`}")).toBe(
      false,
    );
    // A card is bordered and padded too. It must not be mistaken for a field.
    expect(
      HAND_ROLLED_FIELD('<div className="rounded-xl border border-gray-200 bg-white p-5">'),
    ).toBe(false);
    expect(
      HAND_ROLLED_FIELD('<section className="w-full rounded-2xl border border-gray-200 p-6">'),
    ).toBe(false);
  });

  it("MUST FIRE: a hand-rolled blue primary is found, in both blues", () => {
    expect(
      HAND_ROLLED_PRIMARY(
        '<button className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">',
      ),
    ).toBe(true);
    expect(
      HAND_ROLLED_PRIMARY(
        'const PILL = "rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700";',
      ),
    ).toBe(true);
  });

  it("MUST NOT FIRE: hover, dark and file-picker blues are not primary fills", () => {
    expect(HAND_ROLLED_PRIMARY('<a className="rounded text-white hover:bg-blue-700">')).toBe(false);
    expect(HAND_ROLLED_PRIMARY('<a className="dark:bg-blue-600 text-white">')).toBe(false);
    expect(
      HAND_ROLLED_PRIMARY(
        '<input className="file:rounded-lg file:bg-blue-600 file:px-3 file:text-white" />',
      ),
    ).toBe(false);
    // A tinted badge is not a fill.
    expect(HAND_ROLLED_PRIMARY('<span className="bg-blue-100 text-blue-800 ring-1">')).toBe(false);
  });

  it("MUST STILL FIRE: the file-picker line without its `file:` prefixes", () => {
    // Otherwise the carve-out could be swallowing real buttons.
    expect(
      HAND_ROLLED_PRIMARY('<input className="rounded-lg bg-blue-600 px-3 text-white" />'),
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: the walker really reads the app, and the tokens exist", () => {
    // Without this, a walker that found no files would make every assertion
    // below pass forever.
    const files = [...walkSource(APP_DIR)];
    expect(files.length).toBeGreaterThan(80);

    const shell = readFileSync(join(APP_DIR, EYEBROW_HOME), "utf8");
    expect(shell).toContain("export const eyebrowClass");
    // The home file really does contain the string the scan excludes it for —
    // so the exclusion is hiding a definition, not a violation.
    expect(
      HAND_ROLLED_EYEBROW(shell.split("\n").find((l) => l.includes("text-eyebrow font")) ?? ""),
    ).toBe(true);

    const portalUi = readFileSync(join(APP_DIR, FIELD_HOME), "utf8");
    expect(portalUi).toContain("export const inputClass");
    expect(portalUi).toContain("export const buttonClass");
    expect(
      HAND_ROLLED_PRIMARY(portalUi.split("\n").find((l) => l.includes("bg-blue-600 text-white")) ?? ""),
    ).toBe(true);
  });
});

/* ----------------------------------------- controls on the counting itself */

describe("the allowance counts survive a line move and still fail on a new copy", () => {
  /** A miniature corpus, so these controls do not depend on the real tree. */
  const SAMPLE: Corpus = {
    "routes/one.tsx": [
      '<p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">A</p>',
      "  <span>body</span>",
      '<p className="text-eyebrow font-semibold text-gray-500 uppercase">B</p>',
    ],
    "routes/two.tsx": ["<p className={eyebrowClass}>C</p>"],
  };

  it("counts the miniature corpus the way we think it does", () => {
    expect(countsIn(SAMPLE, HAND_ROLLED_EYEBROW)).toEqual({ "routes/one.tsx": 2 });
  });

  it("MUST NOT FIRE: inserting blank lines moves no count", () => {
    // This is the exact failure that made line-pinned allowances untrustworthy.
    const shifted: Corpus = {
      ...SAMPLE,
      "routes/one.tsx": ["", "", ...SAMPLE["routes/one.tsx"], ""],
    };
    expect(countsIn(shifted, HAND_ROLLED_EYEBROW)).toEqual(countsIn(SAMPLE, HAND_ROLLED_EYEBROW));
  });

  it("MUST FIRE: another copy in an already-allowed file raises that file's count", () => {
    const grown: Corpus = {
      ...SAMPLE,
      "routes/one.tsx": [
        ...SAMPLE["routes/one.tsx"],
        '<dt className="text-xs text-gray-500 uppercase">D</dt>',
      ],
    };
    expect(countsIn(grown, HAND_ROLLED_EYEBROW)).toEqual({ "routes/one.tsx": 3 });
  });

  it("MUST FIRE: a copy in a file with no allowance appears as a new key", () => {
    const spread: Corpus = {
      ...SAMPLE,
      "routes/three.tsx": ['<span className="text-xs text-gray-500 uppercase">E</span>'],
    };
    expect(countsIn(spread, HAND_ROLLED_EYEBROW)).toEqual({
      "routes/one.tsx": 2,
      "routes/three.tsx": 1,
    });
  });

  it("MUST FIRE: fixing a copy without trimming the allowance is also a failure", () => {
    // Shrink-only, enforced in both directions: the count is an equality, so a
    // fix that leaves a stale number behind fails until somebody edits it down.
    const fixed: Corpus = { ...SAMPLE, "routes/one.tsx": [SAMPLE["routes/one.tsx"][1]] };
    expect(countsIn(fixed, HAND_ROLLED_EYEBROW)).not.toEqual({ "routes/one.tsx": 2 });
    expect(countsIn(fixed, HAND_ROLLED_EYEBROW)).toEqual({});
  });
});

/* ------------------------------------------------------------ the product */

describe("the product ships one eyebrow, one field class and one primary blue", () => {
  /**
   * Hand-rolled gray eyebrows still in the tree, per file. Every one is on an
   * ORGANIZER surface — the judge-facing routes (`/demo`, public home, public
   * schedule, portal home, the public submit wizard, the speaker portal) carry
   * zero, which is this lane's scope. Converting the organizer chrome is a
   * lane of its own; this list is what stops it growing meanwhile.
   *
   * Shrink these numbers — never raise one, never add a key — and delete the
   * whole allowance when it empties.
   */
  const EYEBROW_ALLOWANCE: Counts = {
    "components/admin-status.tsx": 1,
    "components/form-builder.tsx": 3,
    "routes/admin.agenda.tsx": 2,
    "routes/admin.resources.tsx": 1,
    "routes/admin.speaker.tsx": 3,
    /*
     * `routes/admin.submission.tsx` used to sit here at 2 and is now GONE, not
     * shrunk to 1: rung 4 converted all four of that page's section labels.
     * They were the same label in two sizes — `text-sm` over Form answers and
     * Speaker, `text-xs` over the metadata terms — which is the drift this
     * allowance exists to drain, and the screenshot pass is where it became
     * visible as two heading scales inside one card stack.
     */
    "routes/admin.tasks.tsx": 2,
    "routes/admin.templates.tsx": 2,
  };

  /**
   * Private copies of the shared field class, per file. One of these is a
   * NAMED exception rather than an oversight: `SNIPPET_CLASS` in
   * `admin.embeds.tsx` is a read-only mono code well, and `inputClass` carries
   * `text-sm`, which would beat an appended `text-xs` because Tailwind
   * resolves conflicting utilities by stylesheet order, not class order.
   * Everything else is a genuine copy awaiting a lane of its own.
   *
   * Same rule: shrink only.
   */
  const FIELD_ALLOWANCE: Counts = {
    "components/form-builder.tsx": 1,
    "components/submit/fields.tsx": 1,
    "routes/admin.embeds.tsx": 1,
    "routes/admin.resources.tsx": 1,
    "routes/admin.settings.tsx": 1,
    "routes/admin.speaker.tsx": 4,
    "routes/admin.speakers.tsx": 1,
    "routes/admin.submissions.tsx": 1,
    "routes/auth.login.tsx": 1,
    "routes/portal.submission.edit.tsx": 1,
    "routes/public.speakers.tsx": 1,
    "routes/public.submit.step.tsx": 7,
  };

  it("hand-rolled gray eyebrows stay inside the shrink-only allowance", () => {
    expect(countsIn(readAppCorpus(EYEBROW_HOME), HAND_ROLLED_EYEBROW)).toEqual(EYEBROW_ALLOWANCE);
  });

  it("private copies of the field class stay inside the shrink-only allowance", () => {
    expect(countsIn(readAppCorpus(FIELD_HOME), HAND_ROLLED_FIELD)).toEqual(FIELD_ALLOWANCE);
  });

  it("no component rolls its own blue primary — the allowance here is empty", () => {
    // No allowance list on purpose. All four that existed are converted:
    // `submit/stepper.tsx` and `public.submit.success.tsx` (blue-600 by luck),
    // `public.speakers.tsx` and `review.index.tsx` (blue-700 — a SECOND blue).
    expect(countsIn(readAppCorpus(PRIMARY_HOME), HAND_ROLLED_PRIMARY)).toEqual({});
  });
});
