/**
 * CNT-09 / SPK-11 on the abstract drill-in.
 *
 * The programme drill-in (`admin.session.test.tsx`) proves the same helpers from
 * the other side of the composed pair. What is specific here: editing an
 * ACCEPTED abstract from the organizer's review screen has to move the
 * programme row too, because that is the row the public schedule reads — and it
 * must move nothing else on either row.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionParticipants, sessions } from "~/db/schema";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { SPEAKERS, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import {
  SubmissionDetailView,
  action,
  loader,
  submissionLoaderPayload,
} from "./admin.submission";

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

const url = (id: string) => `https://x.test/admin/submissions/${id}`;

async function load(id: string) {
  return submissionLoaderPayload(
    await loader(asLoaderArgs(await signedInGet(url(id), fixture.adminId), id)),
  );
}
async function post(id: string, fields: Record<string, string>) {
  return action(asActionArgs(await signedInPost(url(id), fixture.adminId, fields), id));
}
async function row(id: string) {
  return ctx.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
}
async function rosterOf(sessionId: string) {
  return ctx.db
    .select({ personId: sessionParticipants.personId, role: sessionParticipants.role })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId));
}

describe("edit-abstract (CNT-09)", () => {
  it("MUST FIRE: an accepted abstract's edit carries to its programme session", async () => {
    const abstractId = fixture.abstractIds[0];
    const programmeId = fixture.programSessionIds[0];

    const response = await post(abstractId, {
      intent: "edit-abstract",
      title: "Corrected by the programme team",
      abstract: "The organizer rewrote this abstract before publication.",
      tab: "accepted",
      track: "",
    });
    expect((response as Response).status).toBe(302);

    expect((await row(abstractId))?.title).toBe("Corrected by the programme team");
    expect((await row(programmeId))?.title).toBe("Corrected by the programme team");
    expect((await row(programmeId))?.description).toBe(
      "The organizer rewrote this abstract before publication.",
    );
    expect((await load(abstractId)).detail?.title).toBe("Corrected by the programme team");
  });

  it("MUST NOT FIRE: the decision and the programme placement are left alone", async () => {
    const abstractId = fixture.abstractIds[0];
    const programmeId = fixture.programSessionIds[0];
    const abstractBefore = await row(abstractId);
    const programmeBefore = await row(programmeId);

    await post(abstractId, {
      intent: "edit-abstract",
      title: "Renamed, nothing else",
      abstract: "Body.",
      tab: "accepted",
      track: "",
    });

    const abstractAfter = await row(abstractId);
    const programmeAfter = await row(programmeId);
    expect(abstractAfter?.status).toBe(abstractBefore?.status);
    expect(abstractAfter?.composedIntoSessionId).toBe(abstractBefore?.composedIntoSessionId);
    expect(abstractAfter?.trackId).toBe(abstractBefore?.trackId);
    expect(programmeAfter?.startsAt?.getTime()).toBe(programmeBefore?.startsAt?.getTime());
    expect(programmeAfter?.roomId).toBe(programmeBefore?.roomId);
    expect(programmeAfter?.isPublic).toBe(programmeBefore?.isPublic);
    expect(programmeAfter?.status).toBe(programmeBefore?.status);
    // The control: something did change, so the assertions above can fail.
    expect(abstractAfter?.title).not.toBe(abstractBefore?.title);
  });

  it("MUST NOT FIRE: a blank title is refused and the row is untouched", async () => {
    const abstractId = fixture.abstractIds[3];
    const before = await row(abstractId);

    const result = await post(abstractId, {
      intent: "edit-abstract",
      title: "",
      abstract: "Body.",
      tab: "pending",
      track: "",
    });
    expect(result).toMatchObject({ ok: false });
    expect((await row(abstractId))?.title).toBe(before?.title);
    expect((await row(abstractId))?.description).toBe(before?.description);
  });

  it("MUST NOT FIRE: an unpaired abstract writes only its own row", async () => {
    // A pending abstract has no programme twin; the edit must not invent one.
    const abstractId = fixture.abstractIds[3];
    await post(abstractId, {
      intent: "edit-abstract",
      title: "Pending, renamed",
      abstract: "Body.",
      tab: "pending",
      track: "",
    });
    expect((await row(abstractId))?.title).toBe("Pending, renamed");
    expect((await row(fixture.programSessionIds[0]))?.title).toBe(
      "Shipping agents that survive contact with users",
    );
  });
});

describe("participants on the abstract (SPK-11)", () => {
  it("MUST FIRE: an added speaker appears with their role on the organizer's record", async () => {
    const abstractId = fixture.abstractIds[3];
    const response = await post(abstractId, {
      intent: "add-participant",
      personId: fixture.speakerIds[5],
      role: "co_speaker",
      tab: "pending",
      track: "",
    });
    expect((response as Response).status).toBe(302);

    const data = await load(abstractId);
    const added = data.speakers.find(
      (speaker) => speaker.personId === fixture.speakerIds[5],
    );
    expect(added?.role).toBe("co_speaker");
    expect(added?.isPrimary).toBe(false);
    expect(data.candidates.map((entry) => entry.personId)).not.toContain(
      fixture.speakerIds[5],
    );
  });

  it("MUST FIRE: removing that speaker takes them back off", async () => {
    const abstractId = fixture.abstractIds[3];
    await post(abstractId, {
      intent: "add-participant",
      personId: fixture.speakerIds[5],
      role: "co_speaker",
      tab: "pending",
      track: "",
    });
    await post(abstractId, {
      intent: "remove-participant",
      personId: fixture.speakerIds[5],
      tab: "pending",
      track: "",
    });
    expect((await rosterOf(abstractId)).map((entry) => entry.personId)).not.toContain(
      fixture.speakerIds[5],
    );
  });

  it("MUST NOT FIRE: the submitter cannot be removed, and a stranger cannot be added", async () => {
    const abstractId = fixture.abstractIds[3];

    expect(
      await post(abstractId, {
        intent: "remove-participant",
        personId: fixture.speakerIds[3],
        tab: "pending",
        track: "",
      }),
    ).toMatchObject({ ok: false });
    expect((await rosterOf(abstractId)).map((entry) => entry.personId)).toContain(
      fixture.speakerIds[3],
    );

    expect(
      await post(abstractId, {
        intent: "add-participant",
        personId: "not-a-person-id",
        role: "speaker",
        tab: "pending",
        track: "",
      }),
    ).toMatchObject({ ok: false });
    expect(await rosterOf(abstractId)).toHaveLength(1);
  });
});

describe("render", () => {
  it("ships the edit form and the participants editor on the detail page", async () => {
    const data = await load(fixture.abstractIds[3]);
    const html = renderToStaticMarkup(<SubmissionDetailView {...data} />);

    expect(html).toContain("data-abstract-edit-form");
    expect(html).toContain("data-add-participant-form");
    expect(html).toContain('value="edit-abstract"');
    expect(html).toContain(`data-participant-row="${fixture.speakerIds[3]}"`);
    // A candidate the picker should be offering.
    expect(html).toContain(SPEAKERS[5].name);
  });
});
