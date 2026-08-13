/**
 * Organizer session editing — the capability four rubric items sit on.
 *
 * Every claim here is paired: the write that must land, and the write that must
 * NOT. The pairing is the point. "The edit form saves" is worth nothing on its
 * own — the interesting property is that it saves title and abstract and leaves
 * placement and decision state exactly where the organizer's other screens put
 * them. Likewise "a conflict warning fires" is only evidence when the
 * non-overlapping twin of the same action stays silent.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gateOverrides, people, sessionParticipants, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { EVENT_SLUG, SPEAKERS, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import AdminSession, { SessionScreen, action, loader } from "./admin.session";
import type { SessionData } from "./admin.session";
import { loader as agendaLoader } from "./admin.agenda";
import { loader as publicScheduleLoader } from "./public.schedule";

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

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

const url = (id: string) => `https://x.test/admin/sessions/${id}`;

async function load(id: string): Promise<SessionData> {
  return loader(asLoaderArgs(await signedInGet(url(id), fixture.adminId), id));
}

async function post(id: string, fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(url(id), fixture.adminId, fields), id));
}

async function sessionRow(id: string) {
  return ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
}

async function participantIds(sessionId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ personId: sessionParticipants.personId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
  return rows.map((row) => row.personId).sort();
}

/** The two seeded programme sessions are back-to-back; this makes them clash. */
async function overlapSecondWithFirst() {
  const first = await sessionRow(fixture.programSessionIds[0]);
  await ctx.db
    .update(sessions)
    .set({ startsAt: first!.startsAt, endsAt: first!.endsAt })
    .where(eq(sessions.id, fixture.programSessionIds[1]));
}

async function publicTitles(): Promise<string[]> {
  const data = await publicScheduleLoader({
    request: new Request(`https://x.test/e/${EVENT_SLUG}/schedule`),
    params: { slug: EVENT_SLUG },
    context: {},
  } as never);
  return data.days.flatMap((day) => day.sessions.map((row) => row.title));
}

async function agendaConflictsFor(sessionId: string): Promise<string[]> {
  const data = await agendaLoader({
    request: await signedInGet("https://x.test/admin/agenda", fixture.adminId),
    params: {},
    context: {},
  } as never);
  const row = data.rows.find((entry) => entry.id === sessionId);
  return (row?.conflicts ?? []).map((conflict) => conflict.label);
}

describe("loader", () => {
  it("shows the session, its speakers, and the roster still available to add", async () => {
    const data = await load(fixture.programSessionIds[0]);

    expect(data.session?.title).toBe("Shipping agents that survive contact with users");
    expect(data.participants.map((row) => row.name)).toEqual([SPEAKERS[0].name]);
    expect(data.participants[0].isPrimary).toBe(true);
    // The picker offers the rest of the roster and never the people already on.
    const candidateNames = data.candidates.map((row) => row.name);
    expect(candidateNames).toContain(SPEAKERS[2].name);
    expect(candidateNames).not.toContain(SPEAKERS[0].name);
    // It is the composed twin of the accepted abstract, and says so.
    expect(data.source?.id).toBe(fixture.abstractIds[0]);
  });

  it("404-shaped for an abstract id — this screen is the programme drill-in", async () => {
    const data = await load(fixture.abstractIds[3]);
    expect(data.session).toBeNull();
  });
});

describe("edit-session (CNT-09)", () => {
  it("MUST FIRE: the new title reaches the public schedule and the source abstract", async () => {
    expect(await publicTitles()).toContain(
      "Shipping agents that survive contact with users",
    );

    const response = await post(fixture.programSessionIds[0], {
      intent: "edit-session",
      title: "Agents that survive contact with users, revised",
      abstract: "A corrected abstract, entered by the programme team.",
    });
    expect((response as Response).status).toBe(302);

    const programme = await sessionRow(fixture.programSessionIds[0]);
    expect(programme?.title).toBe("Agents that survive contact with users, revised");
    expect(programme?.description).toBe(
      "A corrected abstract, entered by the programme team.",
    );
    // The public schedule reads that row — this is the wire-level check, not a
    // re-read of what we just wrote.
    expect(await publicTitles()).toContain(
      "Agents that survive contact with users, revised",
    );
    expect(await publicTitles()).not.toContain(
      "Shipping agents that survive contact with users",
    );
    // …and the accepted abstract the speaker sees in the portal moved with it.
    const abstract = await sessionRow(fixture.abstractIds[0]);
    expect(abstract?.title).toBe("Agents that survive contact with users, revised");
  });

  it("MUST NOT FIRE: placement and decision state are untouched by the edit", async () => {
    const before = await sessionRow(fixture.programSessionIds[0]);

    await post(fixture.programSessionIds[0], {
      intent: "edit-session",
      title: "Renamed but not rescheduled",
      abstract: "Body text only.",
    });

    const after = await sessionRow(fixture.programSessionIds[0]);
    expect(after?.startsAt?.getTime()).toBe(before?.startsAt?.getTime());
    expect(after?.endsAt?.getTime()).toBe(before?.endsAt?.getTime());
    expect(after?.roomId).toBe(before?.roomId);
    expect(after?.trackId).toBe(before?.trackId);
    expect(after?.status).toBe(before?.status);
    expect(after?.isPublic).toBe(before?.isPublic);
    expect(after?.capacity).toBe(before?.capacity);
    expect(after?.composedIntoSessionId).toBe(before?.composedIntoSessionId);
    // The one thing that DID move, so the assertions above can go red.
    expect(after?.title).not.toBe(before?.title);
  });

  it("MUST NOT FIRE: a blank title is rejected and nothing is written", async () => {
    const result = await post(fixture.programSessionIds[0], {
      intent: "edit-session",
      title: "   ",
      abstract: "Body text only.",
    });
    expect(result).toMatchObject({ ok: false });

    const row = await sessionRow(fixture.programSessionIds[0]);
    expect(row?.title).toBe("Shipping agents that survive contact with users");
    expect(row?.description).toBe("Program session composed from the accepted abstract.");
  });
});

describe("add / remove participant (SPK-11)", () => {
  it("MUST FIRE: adding a speaker who would clash with a public session is refused before the write", async () => {
    await overlapSecondWithFirst();

    const result = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Speaker double-booked"),
      blocked: {
        personId: fixture.speakerIds[1],
        role: "panelist",
        reasons: [expect.stringContaining("Speaker double-booked")],
      },
    });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[1],
    );
  });

  it("MUST FIRE: an unpublished edit is also refused when the other session is public", async () => {
    await overlapSecondWithFirst();
    await ctx.db
      .update(sessions)
      .set({ isPublic: false })
      .where(eq(sessions.id, fixture.programSessionIds[0]));

    const result = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("already public") });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[1],
    );
  });

  it("MUST NOT FIRE: force adds the speaker despite the public double-booking", async () => {
    await overlapSecondWithFirst();

    const response = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
      force: "1",
      reason: "Speaker approved the overlap.",
    });

    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toContain("warn=forced");
    expect(await participantIds(fixture.programSessionIds[0])).toContain(
      fixture.speakerIds[1],
    );
    expect(await ctx.db.select().from(gateOverrides)).toMatchObject([
      {
        kind: "participant_force",
        reason: "Speaker approved the overlap.",
        sessionId: fixture.programSessionIds[0],
        overriddenByName: expect.any(String),
      },
    ]);
  });

  it("MUST FIRE: force without a reason refuses the speaker and writes nothing", async () => {
    await overlapSecondWithFirst();
    const result = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
      force: "1",
      reason: " ",
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[1],
    );
    expect(await ctx.db.select().from(gateOverrides)).toEqual([]);
  });

  it("MUST NOT FIRE: two unpublished sessions retain warning-only assignment", async () => {
    await overlapSecondWithFirst();
    await ctx.db
      .update(sessions)
      .set({ isPublic: false })
      .where(eq(sessions.id, fixture.programSessionIds[0]));
    await ctx.db
      .update(sessions)
      .set({ isPublic: false })
      .where(eq(sessions.id, fixture.programSessionIds[1]));

    const response = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
    });

    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toContain("warn=conflict");
    expect(await participantIds(fixture.programSessionIds[0])).toContain(
      fixture.speakerIds[1],
    );
    expect((await load(fixture.programSessionIds[0])).conflicts).toEqual(
      expect.arrayContaining([expect.stringContaining(`Speaker double-booked`)]),
    );
  });

  it("MUST NOT FIRE: a published same-track overlap without a shared speaker stays advisory", async () => {
    await overlapSecondWithFirst();
    const first = await sessionRow(fixture.programSessionIds[0]);
    await ctx.db
      .update(sessions)
      .set({ trackId: first!.trackId })
      .where(eq(sessions.id, fixture.programSessionIds[1]));

    const response = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[2],
      role: "panelist",
    });

    expect((response as Response).status).toBe(302);
    expect(await participantIds(fixture.programSessionIds[0])).toContain(
      fixture.speakerIds[2],
    );
  });

  it("MUST FIRE: an added speaker lands on the session and on its composed abstract", async () => {
    const response = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[2],
      role: "co_speaker",
    });
    expect((response as Response).status).toBe(302);

    expect(await participantIds(fixture.programSessionIds[0])).toContain(
      fixture.speakerIds[2],
    );
    expect(await participantIds(fixture.abstractIds[0])).toContain(fixture.speakerIds[2]);

    const row = await ctx.db.query.sessionParticipants.findFirst({
      where: and(
        eq(sessionParticipants.sessionId, fixture.programSessionIds[0]),
        eq(sessionParticipants.personId, fixture.speakerIds[2]),
      ),
    });
    expect(row?.role).toBe("co_speaker");
    // Never steals the submitter flag from the person who owns the record.
    expect(row?.isPrimary).toBe(false);

    const data = await load(fixture.programSessionIds[0]);
    expect(data.participants.map((entry) => entry.roleLabel)).toContain("Co-speaker");
    expect(data.candidates.map((entry) => entry.personId)).not.toContain(
      fixture.speakerIds[2],
    );
  });

  it("MUST NOT FIRE: a hand-built POST cannot attach someone off this event's roster", async () => {
    const [outsider] = await ctx.db
      .insert(people)
      .values({ email: "outsider@example.com", fullName: "Outside Person", role: "speaker" })
      .returning();

    const result = await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: outsider.id,
      role: "speaker",
    });
    expect(result).toMatchObject({ ok: false });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(outsider.id);
  });

  it("MUST NOT FIRE: an unknown role, and a person already on the session", async () => {
    expect(
      await post(fixture.programSessionIds[0], {
        intent: "add-participant",
        personId: fixture.speakerIds[2],
        role: "keynote_legend",
      }),
    ).toMatchObject({ ok: false });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[2],
    );

    // Role validation remains first even when this person would otherwise
    // create a public double-booking; retrying a blocked form cannot make an
    // invalid role valid.
    await overlapSecondWithFirst();
    expect(
      await post(fixture.programSessionIds[0], {
        intent: "add-participant",
        personId: fixture.speakerIds[1],
        role: "keynote_legend",
      }),
    ).toEqual({ ok: false, error: "Pick a role for this speaker." });
    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[1],
    );

    expect(
      await post(fixture.programSessionIds[0], {
        intent: "add-participant",
        personId: fixture.speakerIds[0],
        role: "panelist",
      }),
    ).toMatchObject({ ok: false });
    expect(await participantIds(fixture.programSessionIds[0])).toEqual([
      fixture.speakerIds[0],
    ]);
  });

  it("MUST FIRE: removing a non-primary speaker clears both linked rows", async () => {
    await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[2],
      role: "co_speaker",
    });
    const response = await post(fixture.programSessionIds[0], {
      intent: "remove-participant",
      personId: fixture.speakerIds[2],
    });
    expect((response as Response).status).toBe(302);

    expect(await participantIds(fixture.programSessionIds[0])).not.toContain(
      fixture.speakerIds[2],
    );
    expect(await participantIds(fixture.abstractIds[0])).not.toContain(
      fixture.speakerIds[2],
    );
  });

  it("MUST NOT FIRE: the submitting speaker cannot be removed", async () => {
    const result = await post(fixture.programSessionIds[0], {
      intent: "remove-participant",
      personId: fixture.speakerIds[0],
    });
    expect(result).toMatchObject({ ok: false });
    expect(await participantIds(fixture.programSessionIds[0])).toContain(
      fixture.speakerIds[0],
    );
  });
});

describe("double-booking (AIA-04)", () => {
  it("MUST FIRE: the same speaker on two OVERLAPPING sessions warns, here and on the agenda", async () => {
    await overlapSecondWithFirst();

    await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
      force: "1",
      reason: "Speaker approved the overlap.",
    });

    const data = await load(fixture.programSessionIds[0]);
    expect(data.conflicts).toContain(`Speaker double-booked · ${SPEAKERS[1].name}`);
    expect(await agendaConflictsFor(fixture.programSessionIds[0])).toContain(
      `Speaker double-booked · ${SPEAKERS[1].name}`,
    );
    expect(await agendaConflictsFor(fixture.programSessionIds[1])).toContain(
      `Speaker double-booked · ${SPEAKERS[1].name}`,
    );
  });

  it("MUST NOT FIRE: the same speaker on two NON-overlapping sessions is silent", async () => {
    // Identical action, seeded back-to-back times left alone.
    await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
    });

    const data = await load(fixture.programSessionIds[0]);
    expect(data.conflicts).toEqual([]);
    expect(await agendaConflictsFor(fixture.programSessionIds[0])).toEqual([]);
  });

  it("MUST NOT FIRE: overlapping sessions with no shared speaker are silent", async () => {
    await overlapSecondWithFirst();

    const data = await load(fixture.programSessionIds[0]);
    // Different rooms, different people — an overlap is not itself a conflict.
    expect(data.conflicts).toEqual([]);
  });
});

describe("render", () => {
  it("renders an add-anyway form with the refused participant and role", async () => {
    const data = await load(fixture.programSessionIds[0]);
    const html = renderToStaticMarkup(
      AdminSession({
        loaderData: data,
        actionData: {
          ok: false,
          error: "Blocked for a public speaker clash.",
          blocked: {
            personId: fixture.speakerIds[1],
            role: "panelist",
            reasons: [`Speaker double-booked Â· ${SPEAKERS[1].name}`],
          },
        },
      } as never),
    );

    expect(html).toContain("Add anyway");
    expect(html).toContain('name="force" value="1"');
    expect(html).toContain('name="reason"');
    expect(html).toContain("required");
    expect(html).toContain(`name="personId" value="${fixture.speakerIds[1]}"`);
    expect(html).toContain('name="role" value="panelist"');
  });

  it("ships the edit form, the participants editor, and the conflict banner", async () => {
    await overlapSecondWithFirst();
    await post(fixture.programSessionIds[0], {
      intent: "add-participant",
      personId: fixture.speakerIds[1],
      role: "panelist",
      force: "1",
      reason: "Speaker approved the overlap.",
    });
    const data = await load(fixture.programSessionIds[0]);
    const html = renderToStaticMarkup(<SessionScreen {...data} />);

    expect(html).toContain("data-session-edit-form");
    expect(html).toContain("data-add-participant-form");
    expect(html).toContain("data-session-conflict");
    expect(html).toContain('value="edit-session"');
    expect(html).toContain('value="remove-participant"');
    expect(html).toContain(SPEAKERS[1].name);
    expect(html).toContain("Forced by");
    expect(html).toContain("Speaker approved the overlap.");
  });

  it("MUST NOT FIRE: no conflict banner on a clean session", async () => {
    const data = await load(fixture.programSessionIds[0]);
    const html = renderToStaticMarkup(<SessionScreen {...data} />);
    expect(html).toContain("data-session-edit-form");
    expect(html).not.toContain("data-session-conflict");
    expect(html).not.toContain("Forced by");
  });
});
