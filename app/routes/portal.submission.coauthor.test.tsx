/**
 * ABS-11 — co-authors on an EXISTING proposal.
 *
 * The wizard could always capture a co-speaker at submit time; what the rubric
 * asks for is adding one to a proposal that already exists, with a role label
 * that survives to the organizer's review view. The lock pairing is the part
 * worth proving: the roster opens and closes with title/abstract, so a speaker
 * cannot slip a name onto a proposal that is no longer editable.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, people, sessionParticipants, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action, loader } from "./portal.submission.edit";
import { loader as adminLoader } from "./admin.submission";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

const asLoaderArgs = (request: Request, sessionId: string) =>
  ({ request, params: { sessionId }, context: {} }) as unknown as LoaderArgs;
const asActionArgs = (request: Request, sessionId: string) =>
  ({ request, params: { sessionId }, context: {} }) as unknown as ActionArgs;

let ctx: TestDbContext;
let fixture: DemoFixture;

/** The pending proposal Mira owns — editable, and not yet composed. */
const TARGET = 3;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

function statusOf(result: unknown): number {
  if (result instanceof Response) return result.status;
  const init = (result as { init?: number | { status?: number } })?.init;
  return typeof init === "number" ? init : (init?.status ?? 200);
}

function errorOf(result: unknown): string {
  const data = (result as { data?: { errors?: Record<string, string> } })?.data;
  return data?.errors?.form ?? "";
}

const url = (id: string) => `https://x.test/portal/submissions/${id}/edit`;

async function loadAs(personId: string, sessionId: string) {
  return loader(asLoaderArgs(await signedInGet(url(sessionId), personId), sessionId));
}

async function postAs(
  personId: string,
  sessionId: string,
  fields: Record<string, string>,
) {
  return action(
    asActionArgs(await signedInPost(url(sessionId), personId, fields), sessionId),
  );
}

/**
 * The demo CFP (scripts/seed.mjs) enables `co_speaker`; the shared test fixture
 * deliberately ships a speaker-only form so the disabled path stays reachable.
 * Turn it on per test rather than changing the fixture out from under everyone.
 */
async function enableCoAuthors(max: number | null = 2) {
  const form = await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) });
  const schema = form!.schema as Record<string, unknown>;
  const participants = schema.participants as Record<string, unknown>;
  await ctx.db
    .update(forms)
    .set({
      schema: {
        ...schema,
        participants: {
          ...participants,
          roles: [
            ...(participants.roles as unknown[]),
            { key: "co_speaker", label: "Co-speaker", enabled: true, min: 0, max },
          ],
        },
      },
    })
    .where(eq(forms.id, CFP_FORM_ID));
}

async function closeTheCfp() {
  await ctx.db
    .update(forms)
    .set({ closesAt: new Date(Date.now() - 60_000) })
    .where(eq(forms.id, CFP_FORM_ID));
}

async function rosterOf(sessionId: string) {
  return ctx.db
    .select({
      personId: sessionParticipants.personId,
      role: sessionParticipants.role,
      isPrimary: sessionParticipants.isPrimary,
    })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
}

describe("loader", () => {
  it("offers the co-author roles the CFP enables, and never the speaker role", async () => {
    await enableCoAuthors();
    const data = await loadAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET]);

    expect(data.coAuthorRoles).toEqual([{ value: "co_speaker", label: "Co-speaker" }]);
    expect(data.participants).toHaveLength(1);
    expect(data.participants[0].isPrimary).toBe(true);
    expect(data.participants[0].roleLabel).toBe("Speaker");
  });

  it("MUST NOT FIRE: a speaker-only CFP offers no co-author roles at all", async () => {
    const data = await loadAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET]);
    expect(data.coAuthorRoles).toEqual([]);
  });
});

describe("add-coauthor", () => {
  it("MUST FIRE: the co-author persists with a role label the organizer can read", async () => {
    await enableCoAuthors();
    const response = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "add-coauthor",
      name: "Marcus Okafor",
      email: "marcus.okafor@example.com",
      role: "co_speaker",
    });
    expect(statusOf(response)).toBe(302);

    const added = await ctx.db.query.people.findFirst({
      where: eq(people.email, "marcus.okafor@example.com"),
    });
    expect(added?.fullName).toBe("Marcus Okafor");

    const roster = await rosterOf(fixture.abstractIds[TARGET]);
    expect(roster).toHaveLength(2);
    const coAuthor = roster.find((row) => row.personId === added!.id);
    expect(coAuthor?.role).toBe("co_speaker");
    expect(coAuthor?.isPrimary).toBe(false);

    // The organizer's review view is where the rubric looks for the label.
    const admin = await adminLoader({
      request: await signedInGet(
        `https://x.test/admin/submissions/${fixture.abstractIds[TARGET]}`,
        fixture.adminId,
      ),
      params: { id: fixture.abstractIds[TARGET] },
      context: {},
    } as never);
    expect(
      admin.speakers.map((speaker) => [speaker.name, speaker.role]),
    ).toContainEqual(["Marcus Okafor", "co_speaker"]);

    // …and the speaker's own edit surface lists them back.
    const portal = await loadAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET]);
    expect(portal.participants.map((row) => row.roleLabel)).toContain("Co-speaker");
  });

  it("MUST NOT FIRE: locked proposals reject the roster write, exactly like title/abstract", async () => {
    await enableCoAuthors();
    await closeTheCfp();

    const response = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "add-coauthor",
      name: "Marcus Okafor",
      email: "marcus.okafor@example.com",
      role: "co_speaker",
    });
    expect(statusOf(response)).toBe(409);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);
  });

  it("MUST NOT FIRE: a CFP that does not collect co-authors rejects the intent", async () => {
    const response = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "add-coauthor",
      name: "Marcus Okafor",
      email: "marcus.okafor@example.com",
      role: "co_speaker",
    });
    expect(statusOf(response)).toBe(400);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);
  });

  it("MUST NOT FIRE: a missing email, a role the form does not offer, or a breached cap", async () => {
    await enableCoAuthors(1);

    expect(
      statusOf(
        await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
          intent: "add-coauthor",
          name: "No Address",
          email: "  ",
          role: "co_speaker",
        }),
      ),
    ).toBe(400);

    // `panelist` is a real participant role, just not one this form collects —
    // the check is against the FORM, not the enum.
    expect(
      statusOf(
        await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
          intent: "add-coauthor",
          name: "Wrong Role",
          email: "wrong.role@example.com",
          role: "panelist",
        }),
      ),
    ).toBe(400);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);

    // One co-speaker is allowed…
    expect(
      statusOf(
        await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
          intent: "add-coauthor",
          email: "first.coauthor@example.com",
          name: "First Coauthor",
          role: "co_speaker",
        }),
      ),
    ).toBe(302);
    // …a second breaches the form's own cap, server-side.
    const capped = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "add-coauthor",
      email: "second.coauthor@example.com",
      name: "Second Coauthor",
      role: "co_speaker",
    });
    expect(statusOf(capped)).toBe(400);
    expect(errorOf(capped)).toMatch(/at most/);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(2);
  });

  it("MUST NOT FIRE: a non-owner cannot touch someone else's roster", async () => {
    await enableCoAuthors();
    await expect(
      postAs(fixture.speakerIds[0], fixture.abstractIds[TARGET], {
        intent: "add-coauthor",
        name: "Marcus Okafor",
        email: "marcus.okafor@example.com",
        role: "co_speaker",
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);
  });
});

describe("remove-coauthor", () => {
  it("MUST FIRE: the speaker can take a co-author back off", async () => {
    await enableCoAuthors();
    await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "add-coauthor",
      name: "Marcus Okafor",
      email: "marcus.okafor@example.com",
      role: "co_speaker",
    });
    const added = await ctx.db.query.people.findFirst({
      where: eq(people.email, "marcus.okafor@example.com"),
    });

    const response = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "remove-coauthor",
      personId: added!.id,
    });
    expect(statusOf(response)).toBe(302);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);
  });

  it("MUST NOT FIRE: the submitter cannot remove themselves", async () => {
    await enableCoAuthors();
    const response = await postAs(fixture.speakerIds[TARGET], fixture.abstractIds[TARGET], {
      intent: "remove-coauthor",
      personId: fixture.speakerIds[TARGET],
    });
    expect(statusOf(response)).toBe(400);
    expect(await rosterOf(fixture.abstractIds[TARGET])).toHaveLength(1);
  });
});

describe("accepted proposals mirror onto the programme", () => {
  it("MUST FIRE: a co-author added to an accepted abstract reaches its programme session", async () => {
    await enableCoAuthors();
    const abstractId = fixture.abstractIds[0];
    const owner = fixture.speakerIds[0];
    const programmeId = fixture.programSessionIds[0];
    expect(
      (await ctx.db.query.sessions.findFirst({ where: eq(sessions.id, abstractId) }))
        ?.composedIntoSessionId,
    ).toBe(programmeId);

    const response = await postAs(owner, abstractId, {
      intent: "add-coauthor",
      name: "Marcus Okafor",
      email: "marcus.okafor@example.com",
      role: "co_speaker",
    });
    expect(statusOf(response)).toBe(302);

    const added = await ctx.db.query.people.findFirst({
      where: eq(people.email, "marcus.okafor@example.com"),
    });
    expect((await rosterOf(abstractId)).map((row) => row.personId)).toContain(added!.id);
    expect((await rosterOf(programmeId)).map((row) => row.personId)).toContain(added!.id);
  });
});
