/**
 * The normaliser, wired up — on both admin surfaces that render speaker links.
 *
 * `app/lib/social-href.test.ts` proves the function. This proves the two call
 * sites actually call it, which is the half that a unit test cannot reach: the
 * bug was never in a helper, it was `href={href}` written twice, in
 * `admin.speaker.tsx` and `admin.submission.tsx`, against a free-text JSON
 * column that mostly contains `@handle`.
 *
 * Both surfaces are exercised from REAL loader data with the links column set
 * to the four shapes an organizer types, because "extract a shared helper" is
 * satisfied by a helper that one of the two pages forgets to import.
 *
 * The load-bearing negative is `href="@handle"` never appearing in the markup:
 * that exact string is the defect, and it is the one assertion that cannot be
 * satisfied by a helper that returns something plausible but wrong.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { people } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { SpeakerView, loader as speakerLoader } from "./admin.speaker";
import {
  SubmissionDetailView,
  loader as submissionLoader,
  submissionLoaderPayload,
} from "./admin.submission";

/** One of each shape the helper has to tell apart. */
const LINKS = {
  X: "@conor",
  Site: "example.com/talks",
  LinkedIn: "https://linkedin.com/in/conorbronsdon",
  Note: "ask me for it",
};

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
  // Every person, so whichever one is a participant on the seeded abstract is
  // covered without the test having to know the fixture's participant wiring.
  await ctx.db.update(people).set({ links: LINKS });
});
afterEach(() => ctx.close());

async function speakerHtml(): Promise<string> {
  const id = fixture.speakerIds[0];
  const request = await signedInGet(`https://x.test/admin/speakers/${id}`, fixture.adminId);
  const data = await speakerLoader({ request, params: { id }, context: {} } as never);
  return renderToStaticMarkup(<SpeakerView {...data} />);
}

async function submissionHtml(): Promise<string> {
  const id = fixture.abstractIds[0];
  const request = await signedInGet(`https://x.test/admin/submissions/${id}`, fixture.adminId);
  const data = submissionLoaderPayload(
    await submissionLoader({ request, params: { id }, context: {} } as never),
  );
  return renderToStaticMarkup(<SubmissionDetailView {...data} />);
}

const SURFACES: [string, () => Promise<string>][] = [
  ["the speaker profile", speakerHtml],
  ["the abstract detail", submissionHtml],
];

for (const [name, render] of SURFACES) {
  describe(`${name} renders speaker links`, () => {
    /* ───────────────────────── must-fire: each shape resolves ── */

    it("sends an @handle to an absolute profile URL", async () => {
      expect(await render()).toContain('href="https://x.com/conor"');
    });

    it("upgrades a bare domain to https", async () => {
      expect(await render()).toContain('href="https://example.com/talks"');
    });

    it("passes a real URL through untouched", async () => {
      expect(await render()).toContain('href="https://linkedin.com/in/conorbronsdon"');
    });

    /* ─────────── must-not-fire: the defect string, and the null branch ── */

    it("never emits the raw handle as an href", async () => {
      // THE regression. `href="@conor"` is a relative URL: the browser
      // resolved it against the current admin path and the click landed on a
      // not-found page inside the workspace.
      expect(await render()).not.toContain('href="@conor"');
    });

    it("never emits a scheme-less domain as an href", async () => {
      expect(await render()).not.toContain('href="example.com/talks"');
    });

    it("renders an unrecognised value as text, with no anchor at all", async () => {
      const html = await render();
      // The label still shows, so the operator can see what was entered...
      expect(html).toContain("Note");
      // ...but nothing links to it, under any normalisation.
      expect(html).not.toContain('href="ask me for it"');
      expect(html).not.toContain('href="https://ask me for it"');
      expect(html).not.toContain("https://ask");
    });

    it("still shows every label it was given", async () => {
      // Must-still-fire: a normaliser that dropped the rows it could not parse
      // would pass every negative above by rendering nothing.
      const html = await render();
      for (const label of Object.keys(LINKS)) {
        expect(html, `${label} vanished from ${name}`).toContain(label);
      }
    });
  });
}
