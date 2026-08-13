/**
 * Bug (demo review, Conor): "Save draft" on the Participant step of the public
 * CFP wizard read as dead — clicking it produced no visible change, unlike
 * Back/Next which both navigate.
 *
 * The action always worked: `intent === "save_draft"` persists the draft and
 * returns `savedDraft: true` (public.submit.step.tsx action, participant
 * branch). The Submission step renders that flag as a green confirmation
 * (public.submit.step.tsx:776); `ParticipantStep` never read it at all, so a
 * successful save and a silently-swallowed click were pixel-identical. That is
 * the whole bug — not a disabled control, not a missing form association, not
 * a z-index/pointer-events issue (all reproduced against the running dev
 * server and ruled out; the POST always returned 200 and the draft always
 * persisted across a reload).
 *
 * This file pins two things a future edit could break silently:
 *   1. the button stays an enabled submit physically inside the participant
 *      <form> (not `disabled`, not a `form="…"` button living outside it);
 *   2. a save_draft response actually renders a confirmation, mirroring the
 *      Submission step.
 *
 * tests/e2e/public-submit.spec.ts's golden-path test clicks the real button
 * end-to-end; this file is the fast, no-browser pin for `npm run test`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDraft, loadSubmitContext } from "~/lib/public-submit/draft.server";
import { signedInGet } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, EVENT_SLUG, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import PublicSubmitStep, { loader } from "./public.submit.step";

const ROUTE_PATH = "/submit/:eventSlug/:formId/step/:step";
const STEP_URL = `/submit/${EVENT_SLUG}/${CFP_FORM_ID}/step/participant`;

type LoaderArgs = Parameters<typeof loader>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;
type ComponentProps = Parameters<typeof PublicSubmitStep>[0];
type ActionData = ComponentProps["actionData"];

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/**
 * Signs in and seeds an empty draft directly through the same server helpers
 * the action uses — `resolveStep` only allows `/step/participant` once a draft
 * exists, and driving there via the wizard's own validation would mean
 * duplicating the whole field registry instead of testing this step.
 */
async function loadParticipantStep(): Promise<LoaderData> {
  const url = `https://x.test/submit/${EVENT_SLUG}/${CFP_FORM_ID}/step/participant`;
  const request = await signedInGet(url, fixture.adminId);
  const context = await loadSubmitContext({
    request,
    eventSlug: EVENT_SLUG,
    formId: CFP_FORM_ID,
  });
  if (!context.person) throw new Error("signedInGet did not resolve a person");
  await ensureDraft({
    event: context.event,
    form: context.form,
    def: context.def,
    person: context.person,
  });

  return loader({
    request,
    params: { eventSlug: EVENT_SLUG, formId: CFP_FORM_ID, step: "participant" },
    context: {},
  } as unknown as LoaderArgs) as Promise<LoaderData>;
}

function renderParticipantStep(loaderData: LoaderData, actionData?: ActionData): string {
  const props = { loaderData, actionData } as unknown as ComponentProps;
  // `<Form>` calls `useSubmit()`, which needs a real data router, not just
  // history context — same stub portal.profile.headshot-refresh.test.tsx uses
  // for the same reason. A plain `<MemoryRouter>` throws before render.
  const Stub = createRoutesStub([
    {
      path: ROUTE_PATH,
      Component: () => PublicSubmitStep(props),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={[STEP_URL]} />);
}

/** Slice out the `<form data-testid="participant-form">…</form>` markup. */
function participantFormMarkup(html: string): string {
  const start = html.indexOf('data-testid="participant-form"');
  expect(start, "participant-form did not render").toBeGreaterThan(-1);
  const end = html.indexOf("</form>", start);
  expect(end, "participant-form never closed").toBeGreaterThan(-1);
  return html.slice(start, end);
}

describe("CFP wizard: Participant-step Save draft", () => {
  it("must fire: the button is an enabled submit, physically inside the participant form", async () => {
    const loaderData = await loadParticipantStep();
    const form = participantFormMarkup(renderParticipantStep(loaderData));

    const button = form.match(/<button[^>]*data-testid="save-draft"[^>]*>/)?.[0];
    expect(button, "save-draft button did not render inside <form data-testid=participant-form>").toBeDefined();
    expect(button).toContain('type="submit"');
    expect(button).toContain('name="intent"');
    expect(button).toContain('value="save_draft"');
    expect(button).not.toContain("disabled");
  });

  it("must NOT fire: no confirmation renders before any draft has been saved", async () => {
    const loaderData = await loadParticipantStep();
    const html = renderParticipantStep(loaderData);
    expect(html).not.toContain('data-testid="draft-saved"');
  });

  it("must fire: a save_draft response renders the same confirmation the Submission step has", async () => {
    const loaderData = await loadParticipantStep();
    const actionData = {
      errors: {},
      message: null,
      magicLink: null,
      magicLinkReveal: null,
      savedDraft: true,
    } as ActionData;

    const html = renderParticipantStep(loaderData, actionData);
    expect(html).toContain('data-testid="draft-saved"');
    expect(html).toContain("Draft saved. This page’s link brings you straight back to it.");
  });
});
