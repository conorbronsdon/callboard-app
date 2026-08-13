/**
 * CFP-05 (w3) — the submission confirmation the submitter never got to read.
 *
 * The route was built, wired and reachable: `public.submit.step.tsx` redirects
 * to `/submit/:slug/:formId/success?s=<id>` on a successful submit, and the page
 * renders the form's configured success message. What the eval saw instead was
 * `/portal`, because the interstitial removed ITSELF after two seconds while the
 * organizer-facing checkbox that arms it promises, in so many words, "Ten
 * seconds after the confirmation page" (admin.forms.edit.tsx). A confirmation
 * that is gone before it can be read is not a confirmation, and an organizer who
 * writes a success message is entitled to have it shown for the time the setting
 * says it will be.
 *
 * The second half is the direction nobody asks for. The page is a receipt, so it
 * must not print one on demand: it used to render "Thank you for your
 * submission" for ANY visitor who opened the URL, and `?s=` was read straight
 * off the query string and looked up by event alone — so it would also print
 * somebody else's title and friendly id to anyone who named their session. A
 * receipt for a submission that did not happen, addressed to a person who did
 * not make it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, sessions } from "~/db/schema";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import {
  CFP_FORM_ID,
  EVENT_SLUG,
  seedDemoFixture,
  type DemoFixture,
} from "~/test/fixtures";

import SubmitSuccess, { REDIRECT_SECONDS, loader, meta } from "./public.submit.success";

let ctx: TestDbContext;
let fixture: DemoFixture;

const MESSAGE = "Thanks! The programme committee meets on the 3rd of every month.";

beforeEach(async () => {
  ctx = installTestDb({ APP_URL: "https://callboard.test" });
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

type LoaderArgs = Parameters<typeof loader>[0];

const successArgs = (request: Request) =>
  ({
    request,
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID },
    context: {},
  }) as unknown as LoaderArgs;

/** Put a distinctive success message on the CFP form, plus the redirect toggle. */
async function configureForm(autoRedirect: boolean) {
  const form = await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) });
  const settings = { ...((form!.settings ?? {}) as Record<string, unknown>) };
  settings.successMessage = MESSAGE;
  settings.autoRedirectToPortal = autoRedirect;
  await ctx.db
    .update(forms)
    .set({ settings, thankYouBody: null })
    .where(eq(forms.id, CFP_FORM_ID));
}

/** The URL the wizard redirects a real submitter to. */
function successUrl(sessionId: string | null) {
  const base = `https://callboard.test/submit/${EVENT_SLUG}/${CFP_FORM_ID}/success`;
  return sessionId === null ? base : `${base}?s=${sessionId}`;
}

/** A submission that genuinely belongs to this speaker, in a submitted state. */
async function ownSubmission() {
  const id = fixture.abstractIds[0];
  await ctx.db.update(sessions).set({ status: "pending" }).where(eq(sessions.id, id));
  return id;
}

function render(loaderData: unknown): string {
  const props = { loaderData } as unknown as Parameters<typeof SubmitSuccess>[0];
  return renderToStaticMarkup(
    <MemoryRouter>
      <SubmitSuccess {...props} />
    </MemoryRouter>,
  );
}

describe("the confirmation actually confirms", () => {
  it("must fire: the configured success message is what the submitter reads", async () => {
    await configureForm(true);
    const sessionId = await ownSubmission();
    const request = await signedInGet(successUrl(sessionId), fixture.speakerIds[0]);

    const data = await loader(successArgs(request));
    expect(data.form.successMessage).toBe(MESSAGE);

    // Rendered, not merely returned — the message is the whole point of the page.
    const html = render(data);
    expect(html).toContain("The programme committee meets on the 3rd");
    expect(html).toContain("Continue to portal");
  });

  it("must fire: the submission the receipt names is the one that was submitted", async () => {
    await configureForm(true);
    const sessionId = await ownSubmission();
    const request = await signedInGet(successUrl(sessionId), fixture.speakerIds[0]);

    const data = await loader(successArgs(request));
    expect(data.submission).not.toBeNull();
    expect(data.submission?.title).toBeTruthy();
    expect(render(data)).toContain(data.submission!.title);
  });

  it("must fire: the auto-redirect waits the ten seconds the setting advertises", async () => {
    // The organizer-facing copy is "Ten seconds after the confirmation page".
    // Two was a private product opinion that made the page unreadable.
    expect(REDIRECT_SECONDS).toBe(10);

    await configureForm(true);
    const sessionId = await ownSubmission();
    const request = await signedInGet(successUrl(sessionId), fixture.speakerIds[0]);
    const data = await loader(successArgs(request));

    expect(data.autoRedirect).toBe(true);
    // The no-JavaScript path has to agree with the hydrated one.
    const tags = meta({ loaderData: data } as never) as Array<Record<string, string>>;
    expect(tags).toContainEqual({ httpEquiv: "refresh", content: "10;url=/portal" });
    expect(render(data)).toContain("10 seconds");
  });

  it("must NOT fire: with the toggle off, nothing redirects and no countdown is promised", async () => {
    await configureForm(false);
    const sessionId = await ownSubmission();
    const request = await signedInGet(successUrl(sessionId), fixture.speakerIds[0]);
    const data = await loader(successArgs(request));

    expect(data.autoRedirect).toBe(false);
    const tags = meta({ loaderData: data } as never) as Array<Record<string, string>>;
    expect(tags.some((tag) => tag.httpEquiv === "refresh")).toBe(false);
    expect(render(data)).not.toContain("10 seconds");
  });
});

describe("the page will not print a receipt that was never earned", () => {
  it("must NOT fire: a direct GET with no submission does not fabricate a confirmation", async () => {
    await configureForm(true);
    const request = await signedInGet(successUrl(null), fixture.speakerIds[0]);
    await expect(loader(successArgs(request))).rejects.toMatchObject({ status: 302 });
  });

  it("must NOT fire: a signed-out stranger cannot open a confirmation at all", async () => {
    await configureForm(true);
    const sessionId = await ownSubmission();
    const request = new Request(successUrl(sessionId));
    await expect(loader(successArgs(request))).rejects.toMatchObject({ status: 302 });
  });

  it("must NOT fire: naming someone else's submission does not leak its title", async () => {
    // The old lookup filtered on the EVENT only, so any id in the event printed
    // its friendly id and title to whoever asked.
    await configureForm(true);
    const sessionId = await ownSubmission();
    const request = await signedInGet(successUrl(sessionId), fixture.speakerIds[2]);
    await expect(loader(successArgs(request))).rejects.toMatchObject({ status: 302 });
  });

  it("must NOT fire: an unsubmitted DRAFT is not a submission", async () => {
    await configureForm(true);
    const id = fixture.abstractIds[0];
    await ctx.db.update(sessions).set({ status: "draft" }).where(eq(sessions.id, id));
    const request = await signedInGet(successUrl(id), fixture.speakerIds[0]);
    await expect(loader(successArgs(request))).rejects.toMatchObject({ status: 302 });
  });
});
