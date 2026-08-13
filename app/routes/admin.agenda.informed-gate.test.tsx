/**
 * The publish gate: a session whose speaker has not been told is NOT published.
 *
 * Read half of the marker written in `app/lib/review/decision-notify.server.ts`
 * (proved in `app/lib/review/decision-notify.informed.test.ts`).
 *
 * The three carve-outs each get a must-fire AND a must-not-fire case, because a
 * gate that never holds anything and a gate that holds everything both pass a
 * test that only checks "publish-all returned a redirect":
 *   1. uninformed + has an originating abstract  -> HELD
 *   2. informed                                   -> publishes exactly as today
 *   3. no originating abstract (organizer-created)-> publishes; there is no
 *      letter to send, so holding it would be a block with no unblock action
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateOverrides, sessionParticipants, sessions } from "~/db/schema";
import { MemoryMailer } from "~/lib/mail/mailer";
import { commitQueues } from "~/lib/review/commit.server";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { AgendaScreen, action, loader } from "./admin.agenda";
import type { AgendaData } from "./admin.agenda";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request) =>
  ({ request, params: {}, context: {} }) as unknown as ActionArgs;

const BASE = "https://x.test/admin/agenda";
const ORIGIN = "https://callboard.test";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(url = BASE): Promise<AgendaData> {
  return loader(asLoaderArgs(await signedInGet(url, fixture.adminId)));
}

async function post(fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(BASE, fixture.adminId, fields)));
}

let counter = 0;

/**
 * A scheduled, unpublished programme session.
 *
 * `withAbstract` controls the carve-out under test: when true an abstract row is
 * pointed at it through `composed_into_session_id`, which is what makes it a
 * decision-derived session with a decision letter that could have been sent.
 */
async function addProgrammeSession(options: {
  title: string;
  informed: boolean;
  withAbstract: boolean;
}): Promise<string> {
  counter += 1;
  const id = `gate-sess-${counter}`;
  const startsAt = new Date(Date.now() + 86_400_000 + counter * 3_600_000);
  await ctx.db.insert(sessions).values({
    id,
    eventId: fixture.eventId,
    friendlyId: `GATE-${counter}`,
    title: options.title,
    status: "accepted",
    isAbstract: false,
    roomId: fixture.roomIds[0],
    trackId: fixture.trackIds[0],
    formatId: fixture.formatIds[0],
    startsAt,
    endsAt: new Date(startsAt.getTime() + 1_800_000),
    isPublic: false,
    speakerInformedAt: options.informed ? new Date() : null,
  });
  await ctx.db.insert(sessionParticipants).values({
    sessionId: id,
    personId: fixture.speakerIds[0],
    role: "speaker",
    isPrimary: true,
    order: 0,
  });

  if (options.withAbstract) {
    const abstractId = `gate-abs-${counter}`;
    await ctx.db.insert(sessions).values({
      id: abstractId,
      eventId: fixture.eventId,
      friendlyId: `GATE-ABS-${counter}`,
      title: options.title,
      status: "accepted",
      isAbstract: true,
      composedIntoSessionId: id,
    });
    await ctx.db.insert(sessionParticipants).values({
      sessionId: abstractId,
      personId: fixture.speakerIds[0],
      role: "speaker",
      isPrimary: true,
      order: 0,
    });
  }
  return id;
}

const rowFor = async (id: string) =>
  ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });

/** Unpublish the seeded programme sessions so publish-all has a known pending set. */
async function unpublishSeeded() {
  for (const id of fixture.programSessionIds) {
    await ctx.db
      .update(sessions)
      .set({ isPublic: false, publishedAt: null })
      .where(eq(sessions.id, id));
  }
}

describe("publish-all holds uninformed sessions", () => {
  it("MUST FIRE: publishes the informed subset and holds the uninformed one by name", async () => {
    const held = await addProgrammeSession({
      title: "Held talk: shipping agents safely",
      informed: false,
      withAbstract: true,
    });
    const publishable = await addProgrammeSession({
      title: "Ready talk: eval harnesses",
      informed: true,
      withAbstract: true,
    });

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = response.headers.get("location") ?? "";

    // The informed one went out; the uninformed one did not.
    expect((await rowFor(publishable))?.isPublic).toBe(true);
    expect((await rowFor(publishable))?.publishedAt).toBeInstanceOf(Date);
    expect((await rowFor(held))?.isPublic).toBe(false);
    expect((await rowFor(held))?.publishedAt).toBeNull();

    // The banner must report the hold, not silently drop it.
    expect(location).toContain("held=1");

    const data = await load(`${BASE}?${location.split("?")[1] ?? ""}`);
    expect(data.heldForUninformed.map((row) => row.title)).toContain(
      "Held talk: shipping agents safely",
    );

    // And the operator can SEE the name and the unblock action on the page.
    const markup = renderToStaticMarkup(<AgendaScreen {...data} />);
    expect(markup).toContain("Held talk: shipping agents safely");
    expect(markup).toContain("Send decision letters now");
  });

  it("MUST NOT FIRE: with nothing uninformed, publish-all behaves exactly as before", async () => {
    await unpublishSeeded();
    const publishable = await addProgrammeSession({
      title: "Ready talk: retrieval tuning",
      informed: true,
      withAbstract: true,
    });

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = response.headers.get("location") ?? "";

    expect(location).toContain("held=0");
    expect((await rowFor(publishable))?.isPublic).toBe(true);
    for (const id of fixture.programSessionIds) {
      expect((await rowFor(id))?.isPublic).toBe(true);
    }
  });

  it("MUST NOT FIRE: an organizer-created session with no originating abstract publishes freely", async () => {
    // No abstract points at it, so no decision letter exists to send. Holding it
    // would be an unclearable block.
    const standalone = await addProgrammeSession({
      title: "Sponsor keynote: Vectorly",
      informed: false,
      withAbstract: false,
    });

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    expect((await rowFor(standalone))?.isPublic).toBe(true);
    expect(response.headers.get("location") ?? "").toContain("held=0");
  });
});

describe("set-published refuses an uninformed session unless overridden", () => {
  it("MUST FIRE: publishing one uninformed session is refused and the row does not move", async () => {
    const held = await addProgrammeSession({
      title: "Held talk: platform teams",
      informed: false,
      withAbstract: true,
    });

    const result = (await post({
      intent: "set-published",
      sessionId: held,
      published: "1",
      view: "list",
    })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("hasn't been told");

    const row = await rowFor(held);
    expect(row?.isPublic).toBe(false);
    expect(row?.publishedAt).toBeNull();
  });

  it("MUST NOT FIRE: an explicit override publishes the same session", async () => {
    const held = await addProgrammeSession({
      title: "Held talk: platform teams",
      informed: false,
      withAbstract: true,
    });

    const response = await post({
      intent: "set-published",
      sessionId: held,
      published: "1",
      override: "1",
      reason: "Speaker confirmed by phone.",
      view: "list",
    });
    expect(response).toBeInstanceOf(Response);

    const row = await rowFor(held);
    expect(row?.isPublic).toBe(true);
    expect(row?.publishedAt).toBeInstanceOf(Date);
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "publish_override",
        reason: "Speaker confirmed by phone.",
        sessionId: held,
        overriddenByName: expect.any(String),
      },
    ]);
  });

  it("MUST FIRE: publish override without a reason is refused and writes nothing", async () => {
    const held = await addProgrammeSession({
      title: "Override needs an explanation",
      informed: false,
      withAbstract: true,
    });
    const result = (await post({
      intent: "set-published",
      sessionId: held,
      published: "1",
      override: "1",
      reason: "   ",
      view: "list",
    })) as { ok: false; error: string };

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    expect((await rowFor(held))?.isPublic).toBe(false);
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
  });

  it("MUST NOT FIRE: an informed session publishes without any override", async () => {
    const ready = await addProgrammeSession({
      title: "Ready talk: incident review",
      informed: true,
      withAbstract: true,
    });

    await post({ intent: "set-published", sessionId: ready, published: "1", view: "list" });
    expect((await rowFor(ready))?.isPublic).toBe(true);
  });

  it("MUST NOT FIRE: the gate never blocks UNpublishing", async () => {
    const held = await addProgrammeSession({
      title: "Held talk: rollbacks",
      informed: false,
      withAbstract: true,
    });
    await ctx.db
      .update(sessions)
      .set({ isPublic: true, publishedAt: new Date() })
      .where(eq(sessions.id, held));

    await post({ intent: "set-published", sessionId: held, published: "0", view: "list" });
    expect((await rowFor(held))?.isPublic).toBe(false);
  });
});

describe("send decision letters now", () => {
  it("MUST FIRE: sending the letters makes a held session publishable", async () => {
    const held = await addProgrammeSession({
      title: "Held talk: cost controls",
      informed: false,
      withAbstract: true,
    });

    await post({ intent: "publish-all", view: "list" });
    expect((await rowFor(held))?.isPublic).toBe(false);

    await post({ intent: "send-decision-letters", view: "list" });

    // The letter landed, so the marker is set...
    expect((await rowFor(held))?.speakerInformedAt).toBeInstanceOf(Date);

    // ...and the very next publish-all takes it.
    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    expect((await rowFor(held))?.isPublic).toBe(true);
    expect(response.headers.get("location") ?? "").toContain("held=0");
  });

  it("MUST FIRE: retries letters for a freshly committed, still-UNSCHEDULED session", async () => {
    /*
     * The regression this pins: composition leaves a session unscheduled on
     * purpose, so a send action filtered by `startsAt` would silently skip
     * exactly the letters that just failed at commit — making the submissions
     * banner's retry button a no-op.
     */
    const commit = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer: {
        name: "failing",
        observesDelivery: true,
        async send() {
          return { ok: false as const, error: "resend: HTTP 403" };
        },
      },
    });
    expect(commit.notifyFailed).toBeGreaterThan(0);

    const abstract = await rowFor(fixture.abstractIds[2]);
    const composedId = abstract!.composedIntoSessionId!;
    expect((await rowFor(composedId))?.startsAt).toBeNull();
    expect((await rowFor(composedId))?.speakerInformedAt).toBeNull();

    await post({ intent: "send-decision-letters", view: "list" });

    expect((await rowFor(composedId))?.speakerInformedAt).toBeInstanceOf(Date);
  });
});

describe("the demo path keeps zero new friction", () => {
  it("MUST NOT FIRE: commit with a working mailer then publish-all holds nothing", async () => {
    await unpublishSeeded();
    const mailer = new MemoryMailer();
    const commit = await commitQueues(fixture.eventId, {
      origin: ORIGIN,
      db: ctx.db,
      mailer,
    });
    expect(commit.accepted).toBe(1);
    expect(commit.notifyFailed).toBe(0);

    // Composition deliberately leaves the session unscheduled; the agenda places
    // it. Give it a slot so it is eligible for publish-all at all.
    const abstract = await rowFor(fixture.abstractIds[2]);
    const composedId = abstract!.composedIntoSessionId!;
    await ctx.db
      .update(sessions)
      .set({
        startsAt: new Date(Date.now() + 172_800_000),
        endsAt: new Date(Date.now() + 172_800_000 + 1_800_000),
      })
      .where(eq(sessions.id, composedId));

    const response = (await post({ intent: "publish-all", view: "list" })) as Response;
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("held=0");

    // The freshly composed session published in the same click.
    expect((await rowFor(composedId))?.isPublic).toBe(true);
  });
});
