import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buttonClass } from "~/components/portal-ui";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture } from "~/test/fixtures";

import Demo, { action, loader } from "./auth.demo";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type LoaderData = Awaited<ReturnType<typeof loader>>;

const LIVE_DEMO_ENV = {
  DEPLOYMENT_PROFILE: "demo",
  DEMO_MODE: "1",
  DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
};

const loaderArgs = {
  request: new Request("https://demo.example.test/demo"),
  params: {},
  context: {},
} as unknown as LoaderArgs;

function actionArgs(role: string) {
  const body = new FormData();
  body.set("role", role);
  return {
    request: new Request("https://demo.example.test/demo", {
      method: "POST",
      body,
    }),
    params: {},
    context: {},
  } as unknown as ActionArgs;
}

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = installTestDb(LIVE_DEMO_ENV);
  await seedDemoFixture(ctx.db);
});

afterEach(() => ctx.close());

describe("demo access boundary", () => {
  it("MUST FIRE: a live disposable demo renders both seeded role entries", async () => {
    const data = await loader(loaderArgs);
    expect(data.accounts.map((account) => account.role)).toEqual([
      "admin",
      "speaker",
    ]);
  });

  it("MUST NOT FIRE: production cannot render the judge sign-in", async () => {
    ctx.close();
    ctx = installTestDb({
      DEPLOYMENT_PROFILE: "production",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });

    try {
      await loader(loaderArgs);
      throw new Error("expected loader to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(404);
    }
  });

  it("MUST NOT FIRE: production cannot mint a demo session by POST", async () => {
    ctx.close();
    ctx = installTestDb({
      DEPLOYMENT_PROFILE: "production",
      DEMO_MODE: "1",
      DEMO_EXPIRES_AT: "2099-08-12T05:00:00.000Z",
    });

    try {
      await action(actionArgs("admin"));
      throw new Error("expected action to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(404);
    }
  });

  it("rejects an unknown role without minting a session", async () => {
    await expect(action(actionArgs("reviewer"))).resolves.toEqual({
      error: "Unknown demo role.",
    });
  });

  it.each([
    ["admin", "/admin"],
    ["speaker", "/portal"],
  ])(
    "replaces the current demo session with the %s account",
    async (role, landing) => {
      try {
        await action(actionArgs(role));
        throw new Error("expected redirect");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        const response = error as Response;
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe(landing);
        expect(response.headers.get("Set-Cookie")).toContain("cb_session=");
        expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
        expect(response.headers.get("Set-Cookie")).toContain("SameSite=Lax");
        expect(response.headers.get("Set-Cookie")).toContain("Secure");
      }
    },
  );
});

describe("cold-judge rendering", () => {
  async function markupFor(data: LoaderData, error?: string) {
    const Stub = createRoutesStub([
      {
        path: "/demo",
        Component: () =>
          Demo({
            loaderData: data,
            actionData: error ? { error } : undefined,
          } as unknown as Parameters<typeof Demo>[0]),
      },
    ]);
    return renderToStaticMarkup(<Stub initialEntries={["/demo"]} />);
  }

  it("renders two clear role choices and exactly six walkthrough stops", async () => {
    const markup = await markupFor(await loader(loaderArgs));
    expect(markup).toContain("Enter organizer workspace");
    expect(markup).toContain("Enter speaker portal");
    expect(markup).toContain("Return to");
    expect(markup.match(/data-demo-step=/g)).toHaveLength(6);
    expect(markup).toContain("Preview the public schedule");
  });

  it("keeps role actions mobile-first and labels each landmark", async () => {
    const markup = await markupFor(await loader(loaderArgs));
    expect(markup).toContain('aria-labelledby="choose-demo-role"');
    expect(markup).toContain('aria-labelledby="judge-walkthrough"');
    expect(
      markup.match(/aria-describedby="(admin|speaker)-demo-description"/g),
    ).toHaveLength(2);
    /*
     * The two role CTAs are the shared primary button, full-width, and there
     * are exactly two of them. Asserted against `buttonClass` itself rather
     * than a copied literal: a hand-rolled fill that merely LOOKS blue no
     * longer satisfies this, which is the regression it is here to catch.
     */
    const primaryFullWidth = `${buttonClass("primary")} mt-3 w-full`;
    expect(markup.split(primaryFullWidth).length - 1).toBe(2);
    expect(markup).toContain("grid gap-4 md:grid-cols-2");
    expect(markup).toContain("grid gap-3 sm:grid-cols-2 lg:grid-cols-3");
  });

  it("renders action errors as an accessible alert", async () => {
    const markup = await markupFor(
      await loader(loaderArgs),
      "Demo accounts are not available on this deployment.",
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Demo accounts are not available");
  });
});
