/**
 * The abstract drill-in: loader shaping, the status action (must-fire AND
 * must-not-fire), prev/next inside a tab filter, the render at seeded and zero
 * state, and the query budget that keeps it off the N+1 path.
 *
 * The render assertions run the REAL default export through
 * `renderToStaticMarkup` — the page is deliberately router-free, so this is a
 * page render, not a snapshot of loader data.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminSubmissionDetail, {
  type SubmissionLoaderData,
  SubmissionDetailView,
  action,
  detailUrl,
  loader,
  safeReturnTo,
  submissionLoaderPayload,
} from "./admin.submission";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];
type LoaderData = SubmissionLoaderData;

const asLoaderArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request, id: string) =>
  ({ request, params: { id }, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

async function load(id: string, query = ""): Promise<LoaderData> {
  const request = await signedInGet(`https://x.test/admin/submissions/${id}${query}`, fixture.adminId);
  // The not-found branch now carries a 404 via `data()`; the status itself is
  // asserted in admin.submission.notfound.test.tsx, so this helper yields the
  // payload either way and the existing assertions keep their meaning.
  return submissionLoaderPayload(await loader(asLoaderArgs(request, id)));
}

async function post(id: string, fields: Record<string, string>) {
  const request = await signedInPost(
    `https://x.test/admin/submissions/${id}`,
    fixture.adminId,
    fields,
  );
  return action(asActionArgs(request, id));
}

describe("loader", () => {
  it("returns every section the page renders, from seeded data", async () => {
    const data = await load(fixture.abstractIds[0]);

    expect(data.detail?.title).toBe("Shipping agents that survive contact with users");
    expect(data.detail?.friendlyId).toBe("ABS-1");
    expect(data.detail?.status).toBe("accepted");
    expect(data.detail?.trackName).toBe("Agents");
    expect(data.detail?.formatName).toBe("Talk");
    expect(data.detail?.formName).toBe("Call for Proposals 2026");
    expect(data.detail?.abstract).toContain("Seeded abstract body");
    expect(data.detail?.submittedAt).toBeTruthy();
    expect(data.detail?.composedIntoSessionId).toBe(fixture.programSessionIds[0]);
  });

  it("resolves speakers with their bios, roles and links", async () => {
    const data = await load(fixture.abstractIds[0]);

    expect(data.speakers).toHaveLength(2);
    expect(data.speakers[0]).toMatchObject({
      name: "Sam Speaker",
      role: "speaker",
      isPrimary: true,
      title: "Demo Speaker",
    });
    expect(data.speakers[0].bio).toContain("Sam Speaker works on");
    expect(data.speakers[0].links).toEqual([["website", "https://example.com/sam"]]);

    // The co-speaker, deliberately bio-less, so the empty state is reachable.
    expect(data.speakers[1]).toMatchObject({ role: "co_speaker", isPrimary: false, bio: null });
  });

  it("labels answers through the form's field registry", async () => {
    const data = await load(fixture.abstractIds[0]);
    const byKey = Object.fromEntries(data.answers.map((answer) => [answer.key, answer]));

    // Registry label, not the raw key.
    expect(byKey.track).toMatchObject({ label: "Track", value: "Agents", offSchema: false });
    expect(byKey.format).toMatchObject({ label: "Format", value: "Talk" });
    expect(byKey.takeaways?.value).toContain("apply on Monday");

    // must-not-fire: the two chrome fields are rendered by the page header and
    // the abstract block, so they must NOT be repeated in the answers list.
    expect(byKey.title).toBeUndefined();
    expect(byKey.abstract).toBeUndefined();

    // An answer the form no longer asks for is still shown, and flagged.
    expect(byKey.legacy_note).toMatchObject({ offSchema: true, label: "legacy_note" });
  });

  it("omits answers with no value rather than rendering empty rows", async () => {
    const data = await load(fixture.abstractIds[0]);
    // The form asks for these; this submission answered neither.
    expect(data.answers.map((answer) => answer.key)).not.toContain("video_url");
    expect(data.answers.map((answer) => answer.key)).not.toContain("benchmark_url");
    expect(data.answers.every((answer) => answer.value.trim().length > 0)).toBe(true);
  });

  it("walks prev/next inside the requested tab, in the table's order", async () => {
    // Pending holds abstracts 3 and 4; the table sorts by createdAt DESC, so
    // index 4 comes first and index 3 second.
    const first = await load(fixture.abstractIds[4], "?tab=pending");
    expect(first.position).toEqual({ index: 1, total: 2 });
    expect(first.prev).toBeNull();
    expect(first.next?.id).toBe(fixture.abstractIds[3]);

    const second = await load(fixture.abstractIds[3], "?tab=pending");
    expect(second.position).toEqual({ index: 2, total: 2 });
    expect(second.prev?.id).toBe(fixture.abstractIds[4]);
    expect(second.next).toBeNull();
  });

  it("narrows prev/next to the track filter — must fire and must not fire", async () => {
    const evals = fixture.trackIds[1];
    const filtered = await load(fixture.abstractIds[4], `?tab=pending&track=${evals}`);

    // must fire: only one pending abstract is on that track, so there is nowhere to go.
    expect(filtered.position).toEqual({ index: 1, total: 1 });
    expect(filtered.next).toBeNull();

    // must NOT fire: without the filter the same row has a neighbour.
    const unfiltered = await load(fixture.abstractIds[4], "?tab=pending");
    expect(unfiltered.next?.id).toBe(fixture.abstractIds[3]);
  });

  it("falls back to the row's own status when no tab is given", async () => {
    const data = await load(fixture.abstractIds[7]); // withdrawn
    expect(data.tab).toBe("withdrawn");
    expect(data.position).toEqual({ index: 1, total: 1 });
  });

  it("returns the not-found shape for a program session, another id, or junk", async () => {
    // A program session is not an abstract and has no drill-in.
    expect((await load(fixture.programSessionIds[0])).detail).toBeNull();
    expect((await load("no-such-id")).detail).toBeNull();
  });
});

describe("query budget", () => {
  /**
   * The done-when is "no N+1". The way that fails is silently — a page that
   * loops over speakers issuing one query each still renders correctly, just
   * slowly. So count the statements the loader actually prepares, and prove the
   * count does not move when the row gains another speaker.
   */
  async function countQueries(run: () => Promise<unknown>): Promise<number> {
    const original = ctx.sqlite.prepare.bind(ctx.sqlite);
    let count = 0;
    (ctx.sqlite as unknown as { prepare: typeof original }).prepare = (sql: string) => {
      count += 1;
      return original(sql);
    };
    try {
      await run();
    } finally {
      (ctx.sqlite as unknown as { prepare: typeof original }).prepare = original;
    }
    return count;
  }

  it("issues a bounded number of statements that does not grow with speakers", async () => {
    const target = fixture.abstractIds[0]; // already has 2 speakers
    const before = await countQueries(() => load(target));

    // Add two more participants to the SAME row.
    await ctx.db.insert(await import("~/db/schema").then((m) => m.sessionParticipants)).values([
      {
        sessionId: target,
        personId: fixture.speakerIds[4],
        role: "co_speaker" as const,
        isPrimary: false,
        order: 2,
      },
      {
        sessionId: target,
        personId: fixture.speakerIds[5],
        role: "panelist" as const,
        isPrimary: false,
        order: 3,
      },
    ]);

    const after = await countQueries(() => load(target));
    const data = await load(target);

    expect(data.speakers).toHaveLength(4); // the data really did grow…
    expect(after).toBe(before); // …and the query count did not.
    /*
     * Auth + event + the two batched rounds, the event roster the add-speaker
     * picker reads, ONE constant read for the AI triage row (ABS-14, from main),
     * and ONE for the change-history panel (this lane). Each of the last three
     * is a single statement whatever the roster/abstract/history size, which is
     * why `after === before` above is the assertion that matters — this ceiling
     * is a smoke alarm, not the property.
     *
     * Raise it only alongside a NAMED new statement; a bump without one is the
     * drift it exists to catch. The merge of the AI-triage lane (12) and this
     * lane's revision-history read lands at 13 — MEASURED, not guessed.
     */
    expect(after).toBeLessThanOrEqual(13);
  });

  it("renders inside the 300ms budget on the seeded volume", async () => {
    const started = performance.now();
    await load(fixture.abstractIds[0]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(300);
  });
});

describe("action: set-status", () => {
  it("must fire: saving moves the row and returns to the detail page", async () => {
    const target = fixture.abstractIds[3]; // pending

    const response = (await post(target, {
      intent: "set-status",
      sessionId: target,
      status: "accept_queue",
      tab: "pending",
    })) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(detailUrl(target, "pending", null));

    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
    expect(row?.status).toBe("accept_queue");
  });

  it("honours a same-origin returnTo but never an off-site one", async () => {
    const target = fixture.abstractIds[3];

    const ok = (await post(target, {
      intent: "set-status",
      sessionId: target,
      status: "accepted",
      tab: "pending",
      returnTo: "/admin/submissions?tab=pending",
    })) as Response;
    expect(ok.headers.get("location")).toBe("/admin/submissions?tab=pending");

    const evil = (await post(target, {
      intent: "set-status",
      sessionId: target,
      status: "pending",
      tab: "pending",
      returnTo: "https://evil.example/steal",
    })) as Response;
    expect(evil.headers.get("location")).toBe(detailUrl(target, "pending", null));
  });

  it("must NOT fire: withdrawn, draft and junk are not admin-assignable", async () => {
    const target = fixture.abstractIds[3];
    for (const status of ["withdrawn", "draft", "bogus"]) {
      expect(await post(target, { intent: "set-status", sessionId: target, status })).toMatchObject({
        ok: false,
      });
      const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, target) });
      expect(row?.status).toBe("pending");
    }
  });

  it("must NOT fire: a body naming a different row than the URL is refused", async () => {
    const shown = fixture.abstractIds[3];
    const other = fixture.abstractIds[4];

    const result = await post(shown, {
      intent: "set-status",
      sessionId: other, // ← not the row in the path
      status: "declined",
      tab: "pending",
    });

    expect(result).toMatchObject({ ok: false });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, other) });
    expect(row?.status).toBe("pending");
  });

  it("must NOT fire: a program session cannot be restatused here", async () => {
    const program = fixture.programSessionIds[0];
    const result = await post(program, {
      intent: "set-status",
      sessionId: program,
      status: "declined",
    });

    expect(result).toMatchObject({ ok: false });
    const row = await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, program) });
    expect(row?.status).toBe("accepted");
  });

  it("rejects an unknown intent", async () => {
    expect(await post(fixture.abstractIds[3], { intent: "delete-everything" })).toMatchObject({
      ok: false,
    });
  });

  it("composes the programme session and tasks when the detail radio accepts", async () => {
    const target = fixture.abstractIds[3];
    const response = (await post(target, {
      intent: "set-status",
      sessionId: target,
      status: "accepted",
      tab: "pending",
    })) as Response;

    expect(response.status).toBe(302);
    const abstract = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, target),
    });
    expect(abstract?.status).toBe("accepted");
    expect(abstract?.composedIntoSessionId).toBeTruthy();

    const programme = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, abstract!.composedIntoSessionId!),
    });
    expect(programme).toMatchObject({
      title: abstract!.title,
      isAbstract: false,
      status: "accepted",
    });
    const { tasks } = await import("~/db/schema");
    const createdTasks = await ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.sessionId, programme!.id));
    expect(createdTasks.map((task) => task.title).sort()).toEqual([
      "Complete your bio",
      "Confirm your slot",
      "Submit your slides",
      "Upload a headshot",
    ]);
  });
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths and rejects everything else", () => {
    expect(safeReturnTo("/admin/submissions?tab=pending", "/fallback")).toBe(
      "/admin/submissions?tab=pending",
    );
    // must not fire: absolute, protocol-relative, and non-string inputs
    expect(safeReturnTo("https://evil.example", "/fallback")).toBe("/fallback");
    expect(safeReturnTo("//evil.example", "/fallback")).toBe("/fallback");
    expect(safeReturnTo(undefined, "/fallback")).toBe("/fallback");
  });
});

describe("render", () => {
  it("renders every section from seeded data", async () => {
    const data = await load(fixture.abstractIds[0], "?tab=accepted");
    const props = { loaderData: data, actionData: undefined } as unknown as Parameters<
      typeof AdminSubmissionDetail
    >[0];
    const html = renderToStaticMarkup(<AdminSubmissionDetail {...props} />);

    // identity + metadata
    expect(html).toContain("Shipping agents that survive contact with users");
    expect(html).toContain("ABS-1");
    expect(html).toContain("Agents");
    expect(html).toContain("Call for Proposals 2026");
    // the abstract body the table had no room for
    expect(html).toContain("Seeded abstract body");
    // answers, by registry label
    expect(html).toContain("Audience takeaways");
    expect(html).toContain("no longer asked");
    // speakers, their bios, their links, and the link to their profile
    expect(html).toContain("Speakers (2)");
    expect(html).toContain("Sam Speaker");
    expect(html).toContain(`/admin/speakers/${fixture.speakerIds[0]}`);
    expect(html).toContain("https://example.com/sam");
    expect(html).toContain("No bio yet.");
    // the same status popover the table has
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('name="intent" value="set-status"');
  });

  it("renders prev/next as disabled at the ends of a tab", async () => {
    const data = await load(fixture.abstractIds[4], "?tab=pending");
    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);

    expect(html).toContain("1 of 2 in Pending");
    // First row: Prev is inert, Next points at the neighbour.
    expect(html).toMatch(/aria-disabled="true"[^>]*data-testid="detail-prev"/);
    expect(html).toContain(`/admin/submissions/${fixture.abstractIds[3]}?tab=pending`);
  });

  it("renders the not-found state instead of throwing", async () => {
    const data = await load("no-such-id");
    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);
    expect(html).toContain("does not exist in this event");
  });

  it("renders when no event exists at all", () => {
    const html = renderToStaticMarkup(
      <SubmissionDetailView
        event={null}
        detail={null}
        speakers={[]}
        answers={[]}
        tab="pending"
        trackId={null}
        prev={null}
        next={null}
        position={null}
        rounds={[]}
      />,
    );
    expect(html).toContain("does not exist in this event");
  });
});
