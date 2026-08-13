/**
 * CNT-06 on EVERY upload control, from rendered markup (public wizard, portal
 * profile, portal task flow).
 *
 * The lane claims the constraint is stated at every upload control and is
 * generated from the rule that enforces it. That was verified on the task flow
 * alone. A cross-family review planted three mutations on the other two
 * surfaces and the whole suite stayed green on all three:
 *
 *  1. the public wizard's file input `accept=` attribute;
 *  2. the portal profile's headshot hint;
 *  3. the portal profile's slides hint.
 *
 * `files-library.test.ts` pins the GENERATOR (the stated cap is the enforced
 * cap) and greps the three source files for a hard-coded "up to N MB". Neither
 * check can see a control that renders no constraint at all, or one that states
 * a DIFFERENT purpose's rules — every string still comes from the generator.
 *
 * ── What makes these discriminating ──
 * `headshot` and the document family have genuinely different accept lists
 * ("JPEG, PNG, WebP or AVIF" vs "PDF, PPT/PPTX, an image, or plain text"), so
 * every must-fire here sits beside a must-not-fire asserting the surface does
 * NOT state the other family's rules. A control that lost its sentence fails
 * the first; a control wired to the wrong purpose fails the second.
 *
 * ── Red-proofs (run against this file, not assumed) ──
 * Each mutation was applied to the source, this spec run, and the source
 * restored. Failure counts out of 11:
 *
 *  - wizard `accept` → `ACCEPT_ATTRIBUTE.headshot` .................. 1 fails
 *  - wizard constraint → hand-typed "PDF or PPTX, up to 25 MB." ..... 3 fail
 *  - profile headshot hint → hand-typed "Images only." ............. 2 fail
 *  - profile slides hint → `uploadConstraintText("headshot")` ....... 1 fails
 *  - task hint → hard-wired `uploadConstraintText("document")` ...... 1 fails
 *  - task hint → dropped entirely (`""`) ........................... 3 fail
 *
 * Every one of those six was GREEN before this file existed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FieldInput } from "~/components/submit/fields";
import type { FormFieldRef } from "~/lib/form-schema";
import type { PortalQuestion } from "~/lib/portal-form";
import {
  ACCEPT_ATTRIBUTE,
  HUMAN_ACCEPT,
  MAX_UPLOAD_MB,
  PUBLIC_SUBMIT_FILE_PURPOSE,
  uploadConstraintText,
  validateUpload,
} from "~/lib/portal-uploads";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import PortalProfile, { loader as profileLoader } from "./portal.profile";
import { QuestionField } from "./portal.task";

const HEADSHOT_COPY = uploadConstraintText("headshot");
const SLIDES_COPY = uploadConstraintText("slides");
const DOCUMENT_COPY = uploadConstraintText("document");
const WIZARD_COPY = uploadConstraintText(PUBLIC_SUBMIT_FILE_PURPOSE);

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/**
 * The sentences have to be distinguishable for any of the assertions below to
 * discriminate. If the accept lists were ever unified this test would start
 * passing for the wrong reason, so the premise is asserted, not assumed.
 */
describe("the constraint sentences are actually distinguishable", () => {
  it("headshot copy and document copy differ in both directions", () => {
    expect(HEADSHOT_COPY).not.toBe(DOCUMENT_COPY);
    expect(HEADSHOT_COPY).toContain("JPEG");
    expect(HEADSHOT_COPY).not.toContain("PDF");
    expect(DOCUMENT_COPY).toContain("PDF");
    expect(ACCEPT_ATTRIBUTE.headshot).not.toBe(ACCEPT_ATTRIBUTE.document);
    // …and the headshot list is a strict SUBSET, which is why every accept
    // assertion below matches the whole attribute value rather than a substring.
    expect(ACCEPT_ATTRIBUTE.document.includes(ACCEPT_ATTRIBUTE.headshot)).toBe(true);
  });
});

/* ------------------------------------------- surface 1: the public wizard */

function fileField(over: Partial<FormFieldRef> = {}): FormFieldRef {
  return {
    fieldId: "fld-deck",
    key: "deck",
    label: "Slide deck",
    type: "file",
    scope: "session",
    order: 0,
    required: false,
    ...over,
  } as FormFieldRef;
}

const wizardMarkup = (field: FormFieldRef) =>
  renderToStaticMarkup(<FieldInput field={field} value={null} required={false} />);

describe("surface 1 — public submission wizard", () => {
  it("MUST FIRE: the field states the generated constraint and filters by the same list", () => {
    const html = wizardMarkup(fileField());

    expect(html).toContain(WIZARD_COPY);
    expect(html).toContain(`up to ${MAX_UPLOAD_MB} MB`);
    expect(html).toContain('type="file"');
    // The picker filters by the SAME list the sentence describes. Matched as a
    // whole attribute value, not a substring: `ACCEPT_ATTRIBUTE.headshot` is a
    // literal SUFFIX of the document family's list (both end in the four image
    // types), so a substring check would call the wrong list a match.
    expect(html).toContain(`accept="${ACCEPT_ATTRIBUTE[PUBLIC_SUBMIT_FILE_PURPOSE]}"`);

    // MUST NOT FIRE: it does not state, or filter by, the headshot rules.
    expect(html).not.toContain(HUMAN_ACCEPT.headshot);
    expect(html).not.toContain(`accept="${ACCEPT_ATTRIBUTE.headshot}"`);
  });

  it("MUST FIRE: an authored hint does not swallow the constraint", () => {
    // The `??` this replaced meant any field whose author wrote a hint lost the
    // sentence entirely, and `helpText: ""` rendered no copy at all.
    const authored = wizardMarkup(fileField({ helpText: "16:9, please." }));
    expect(authored).toContain("16:9, please.");
    expect(authored).toContain(WIZARD_COPY);

    expect(wizardMarkup(fileField({ helpText: "" }))).toContain(WIZARD_COPY);

    // MUST NOT FIRE: a non-file field is untouched, so the append cannot leak
    // the upload sentence onto every control on the form.
    expect(wizardMarkup(fileField({ type: "text" }))).not.toContain(WIZARD_COPY);
  });

  it("MUST FIRE: the stated purpose is the purpose the SERVER stores under", () => {
    /*
     * The field said `document` while `storeSubmissionUpload` wrote `other`.
     * `ACCEPTED_TYPES.document` and `.other` are equal today, so the copy was
     * identical and nothing could see the drift. Both sides now read one
     * exported constant — and this asserts the rules it states are the rules
     * that purpose enforces, so the day the two lists diverge, this fails.
     */
    const html = wizardMarkup(fileField());
    expect(html).toContain(HUMAN_ACCEPT[PUBLIC_SUBMIT_FILE_PURPOSE]);
    expect(
      validateUpload({
        size: 10,
        contentType: "application/pdf",
        purpose: PUBLIC_SUBMIT_FILE_PURPOSE,
        filename: "deck.pdf",
      }),
    ).toBeNull();
    // MUST NOT FIRE: a type the sentence does not name is refused by the same
    // purpose — the copy is not describing a looser rule than the validator.
    expect(
      validateUpload({
        size: 10,
        contentType: "application/x-msdownload",
        purpose: PUBLIC_SUBMIT_FILE_PURPOSE,
        filename: "deck.exe",
      }),
    ).not.toBeNull();
  });
});

/* ------------------------------------------ surface 2: the portal profile */

/** The real loader, rendered through the real component. */
async function profileMarkup(personId: string): Promise<string> {
  const request = await signedInGet("https://x.test/portal/profile", personId);
  const data = await profileLoader({
    request,
    params: {},
    context: {},
  } as unknown as Parameters<typeof profileLoader>[0]);

  const Stub = createRoutesStub([
    {
      path: "/portal/profile",
      Component: () =>
        PortalProfile({ loaderData: data } as unknown as Parameters<typeof PortalProfile>[0]),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/portal/profile"]} />);
}

describe("surface 2 — portal profile", () => {
  it("MUST FIRE: the headshot control states the HEADSHOT constraint", async () => {
    const html = await profileMarkup(fixture.speakerIds[0]);

    expect(html).toContain(HEADSHOT_COPY);
    expect(html).toContain(`accept="${ACCEPT_ATTRIBUTE.headshot}"`);

    // MUST NOT FIRE: the headshot control does not offer or promise PDFs. A
    // page that rendered ONE generated sentence for both controls — the natural
    // copy-paste mutation — trips this without tripping the line above.
    const headshotBlock = html.slice(0, html.indexOf("Slides and documents"));
    expect(headshotBlock).toContain(HEADSHOT_COPY);
    expect(headshotBlock).not.toContain(SLIDES_COPY);
    expect(headshotBlock).not.toContain("application/pdf");
  });

  it("MUST FIRE: the documents control states the SLIDES constraint", async () => {
    const html = await profileMarkup(fixture.speakerIds[0]);

    expect(html).toContain(SLIDES_COPY);
    expect(html).toContain(`accept="${ACCEPT_ATTRIBUTE.slides}"`);

    const slidesBlock = html.slice(html.indexOf("Slides and documents"));
    expect(slidesBlock).toContain(SLIDES_COPY);
    expect(slidesBlock).not.toContain(HEADSHOT_COPY);
    // MUST NOT FIRE: it does not restrict the picker to images.
    expect(slidesBlock).not.toContain(`accept="${ACCEPT_ATTRIBUTE.headshot}"`);
  });

  it("MUST NOT FIRE: neither hint hard-codes the cap", async () => {
    const html = await profileMarkup(fixture.speakerIds[0]);
    // Both sentences quote the enforced number, and only the enforced number.
    expect(html).toContain(`up to ${MAX_UPLOAD_MB} MB`);
    const megabytes = [...html.matchAll(/up to (\d+(?:\.\d+)?) ?MB/gi)].map((m) => m[1]);
    expect(megabytes.length).toBeGreaterThanOrEqual(2); // one per control
    expect(new Set(megabytes)).toEqual(new Set([String(MAX_UPLOAD_MB)]));
  });
});

/* ---------------------------------------- surface 3: the portal task flow */

function taskQuestion(over: Partial<PortalQuestion> = {}): PortalQuestion {
  return { key: "deck", label: "Slide deck", type: "file", ...over };
}

const taskMarkup = (question: PortalQuestion) =>
  renderToStaticMarkup(
    <QuestionField
      question={question}
      value={null}
      disabled={false}
      acceptDefault={ACCEPT_ATTRIBUTE.document}
    />,
  );

describe("surface 3 — portal task flow", () => {
  it("MUST FIRE: the question states the constraint for ITS OWN filePurpose", () => {
    const slides = taskMarkup(taskQuestion({ filePurpose: "slides" }));
    expect(slides).toContain(SLIDES_COPY);

    const headshot = taskMarkup(taskQuestion({ filePurpose: "headshot" }));
    expect(headshot).toContain(HEADSHOT_COPY);

    /*
     * The discriminator. A hint hard-wired to one purpose passes "the page
     * contains a generated sentence" for every question on the form; these two
     * assertions are what a hard-wired hint cannot satisfy at once.
     */
    expect(headshot).not.toContain(SLIDES_COPY);
    expect(slides).not.toContain(HEADSHOT_COPY);
  });

  it("MUST FIRE: a question with no filePurpose falls back to document, still generated", () => {
    const html = taskMarkup(taskQuestion());
    expect(html).toContain(DOCUMENT_COPY);
    expect(html).not.toContain(HEADSHOT_COPY);
  });

  it("MUST FIRE: an authored hint does not swallow the constraint", () => {
    const authored = taskMarkup(
      taskQuestion({ filePurpose: "slides", helpText: "One file, final version." }),
    );
    expect(authored).toContain("One file, final version.");
    expect(authored).toContain(SLIDES_COPY);

    expect(taskMarkup(taskQuestion({ filePurpose: "slides", helpText: "" }))).toContain(
      SLIDES_COPY,
    );
  });

  it("MUST NOT FIRE: a non-file question gets no upload constraint at all", () => {
    const html = taskMarkup(taskQuestion({ type: "text", label: "Bio" }));
    expect(html).not.toContain(SLIDES_COPY);
    expect(html).not.toContain(DOCUMENT_COPY);
    expect(html).not.toContain(HEADSHOT_COPY);
  });
});
