/**
 * Configurable post-submit edit deadlines (issue #1).
 *
 * The feature is a CONFIGURATION of the existing CFP-close edit lock, not a
 * second lock beside it, so the test that matters most is the must-still-fire
 * one: with no policy saved, the close-date lock a Codex lane shipped must
 * behave exactly as it did. Everything else here is the new modes, each proven
 * in both directions — an edit that goes through before the deadline and the
 * same edit refused after it, because a rule that only ever refuses is
 * indistinguishable from a broken page.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forms, sessions } from "~/db/schema";
import {
  parseEditDeadline,
  parseFormSettings,
  type EditDeadlinePolicy,
} from "~/lib/form-schema";
import { speakerEditLockReason } from "~/lib/portal/submission-edit";
import { signedInGet, signedInPost } from "~/test/auth";
import { installTestDb, type TestDbContext } from "~/test/db";
import { CFP_FORM_ID, seedDemoFixture, type DemoFixture } from "~/test/fixtures";

import { action as builderAction } from "./admin.forms.edit";
import { action, loader } from "./portal.submission.edit";

let ctx: TestDbContext;
let fixture: DemoFixture;

beforeEach(async () => {
  ctx = installTestDb();
  fixture = await seedDemoFixture(ctx.db);
});
afterEach(() => ctx.close());

/* ------------------------------------------------------------------- pure */

const DEADLINE = 2_000;

describe("speakerEditLockReason — deadline policies", () => {
  const pending = { status: "pending" as const, closesAt: 1_000 };

  it("without a policy, behaves exactly as the CFP-close lock did", () => {
    expect(speakerEditLockReason({ ...pending, now: 999 })).toBeNull();
    expect(speakerEditLockReason({ ...pending, now: 1_001 })).toBe("past_close_date");
    // Accepted corrections still ignore the CFP deadline.
    expect(
      speakerEditLockReason({ status: "accepted", closesAt: 1_000, now: 10_000 }),
    ).toBeNull();
  });

  it("`cfp_close` written explicitly is the same rule", () => {
    const policy: EditDeadlinePolicy = { mode: "cfp_close", at: null };
    expect(speakerEditLockReason({ ...pending, now: 1_001, policy })).toBe("past_close_date");
    expect(speakerEditLockReason({ ...pending, now: 999, policy })).toBeNull();
  });

  it("`custom` replaces the CFP date, for pending and accepted alike", () => {
    const policy: EditDeadlinePolicy = { mode: "custom", at: DEADLINE };

    // Before the operator's deadline: open, even though the CFP closed at 1_000.
    expect(speakerEditLockReason({ ...pending, now: 1_500, policy })).toBeNull();
    // After it: locked, and named as the edit deadline rather than the CFP one.
    expect(speakerEditLockReason({ ...pending, now: 2_001, policy })).toBe(
      "past_edit_deadline",
    );
    expect(
      speakerEditLockReason({ status: "accepted", closesAt: 1_000, now: 2_001, policy }),
    ).toBe("past_edit_deadline");
    expect(
      speakerEditLockReason({ status: "accepted", closesAt: 1_000, now: 1_999, policy }),
    ).toBeNull();
  });

  it("`open` removes the date gate but not the status gate", () => {
    const policy: EditDeadlinePolicy = { mode: "open", at: null };
    expect(speakerEditLockReason({ ...pending, now: 10_000, policy })).toBeNull();
    // Must still fire: status always wins.
    expect(
      speakerEditLockReason({ status: "declined", closesAt: null, now: 0, policy }),
    ).toBe("review_advanced");
    expect(
      speakerEditLockReason({ status: "accept_queue", closesAt: null, now: 0, policy }),
    ).toBe("review_advanced");
  });
});

describe("parseEditDeadline", () => {
  it("defaults to the close-date rule for anything unrecognised", () => {
    expect(parseEditDeadline(undefined)).toEqual({ mode: "cfp_close", at: null });
    expect(parseEditDeadline({ mode: "whenever" })).toEqual({ mode: "cfp_close", at: null });
    expect(parseFormSettings({}).editDeadline).toEqual({ mode: "cfp_close", at: null });
  });

  it("fails SAFE: a custom policy with no date does not become `open`", () => {
    // The dangerous direction is reopening edits on a form somebody was in the
    // middle of closing, so a half-saved custom policy falls back to the close
    // date rather than to "no deadline".
    expect(parseEditDeadline({ mode: "custom", at: null })).toEqual({
      mode: "cfp_close",
      at: null,
    });
    expect(parseEditDeadline({ mode: "custom", at: "soon" })).toEqual({
      mode: "cfp_close",
      at: null,
    });
    // …and a well-formed one survives, so the fallback is not swallowing everything.
    expect(parseEditDeadline({ mode: "custom", at: DEADLINE })).toEqual({
      mode: "custom",
      at: DEADLINE,
    });
    expect(parseEditDeadline({ mode: "open", at: 5 })).toEqual({ mode: "open", at: null });
  });
});

/* --------------------------------------------------------- the real route */

const VALID_ABSTRACT =
  "A practical account of building reliable agent systems, including failure analysis, " +
  "evaluation design, operational trade-offs, deployment lessons, and concrete techniques " +
  "that attendees can apply to production systems immediately after the conference.";

async function setFormPolicy(policy: EditDeadlinePolicy | null, closesAt: Date | null) {
  const row = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
  const settings = parseFormSettings(row.settings);
  await ctx.db
    .update(forms)
    .set({
      closesAt,
      settings: {
        ...settings,
        ...(policy ? { editDeadline: policy } : {}),
      } as Record<string, unknown>,
    })
    .where(eq(forms.id, CFP_FORM_ID));
}

const statusOf = (result: unknown): number => {
  if (result instanceof Response) return result.status;
  const init = (result as { init?: number | { status?: number } })?.init;
  return typeof init === "number" ? init : (init?.status ?? 200);
};

/** The pending proposal owned by speaker 3 in the fixture. */
const TARGET = () => ({ id: fixture.abstractIds[3], owner: fixture.speakerIds[3] });

async function editAttempt() {
  const { id, owner } = TARGET();
  const loaded = await loader({
    request: await signedInGet(`https://x.test/portal/submissions/${id}/edit`, owner),
    params: { sessionId: id },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);

  const result = await action({
    request: await signedInPost(`https://x.test/portal/submissions/${id}/edit`, owner, {
      expectedUpdatedAt: String(loaded.submission.updatedAt),
      title: "A corrected production-ready title",
      abstract: VALID_ABSTRACT,
      videoUrl: "",
    }),
    params: { sessionId: id },
    context: {},
  } as unknown as Parameters<typeof action>[0]);

  return { loaded, result, status: statusOf(result) };
}

const PAST = new Date(Date.now() - 86_400_000);
const FUTURE = new Date(Date.now() + 86_400_000);

describe("portal edit route honours the configured deadline", () => {
  it("must still fire: the CFP-close lock works with no policy saved", async () => {
    await setFormPolicy(null, PAST);
    const { loaded, status } = await editAttempt();

    expect(loaded.submission.editable).toBe(false);
    expect(loaded.submission.lockReason).toBe("past_close_date");
    expect(status).toBe(409);

    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, TARGET().id),
    });
    expect(after!.title).not.toBe("A corrected production-ready title");
  });

  it("a custom deadline in the future reopens edits the CFP close had shut", async () => {
    await setFormPolicy({ mode: "custom", at: FUTURE.getTime() }, PAST);
    const { loaded, status } = await editAttempt();

    expect(loaded.submission.editable).toBe(true);
    expect(loaded.submission.lockReason).toBeNull();
    expect(status).toBe(302);

    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, TARGET().id),
    });
    expect(after!.title).toBe("A corrected production-ready title");
  });

  it("a custom deadline in the past blocks an edit the CFP close would have allowed", async () => {
    await setFormPolicy({ mode: "custom", at: PAST.getTime() }, FUTURE);
    const { loaded, status } = await editAttempt();

    expect(loaded.submission.lockReason).toBe("past_edit_deadline");
    expect(status).toBe(409);

    const after = await ctx.db.query.sessions.findFirst({
      where: eq(sessions.id, TARGET().id),
    });
    expect(after!.title).not.toBe("A corrected production-ready title");
  });

  it("`open` lets a correction through after the CFP has closed", async () => {
    await setFormPolicy({ mode: "open", at: null }, PAST);
    const { status } = await editAttempt();
    expect(status).toBe(302);
  });
});

/* -------------------------------------------------------- builder control */

describe("the builder saves the policy", () => {
  async function saveSettings(fields: Record<string, string>) {
    const url = `https://x.test/admin/forms/${CFP_FORM_ID}/settings`;
    const request = await signedInPost(url, fixture.adminId, {
      intent: "save-settings",
      step: "settings",
      ...fields,
    });
    return builderAction({
      request,
      params: { formId: CFP_FORM_ID, step: "settings" },
      context: {},
    } as unknown as Parameters<typeof builderAction>[0]);
  }

  const stored = async () => {
    const row = (await ctx.db.query.forms.findFirst({ where: eq(forms.id, CFP_FORM_ID) }))!;
    return parseFormSettings(row.settings).editDeadline;
  };

  it("round-trips each mode", async () => {
    await saveSettings({ editDeadlineMode: "open" });
    expect(await stored()).toEqual({ mode: "open", at: null });

    await saveSettings({ editDeadlineMode: "custom", editDeadlineAt: "2026-09-15T23:59" });
    const custom = await stored();
    expect(custom.mode).toBe("custom");
    expect(custom.at).toBeGreaterThan(0);

    await saveSettings({ editDeadlineMode: "cfp_close" });
    expect(await stored()).toEqual({ mode: "cfp_close", at: null });
  });

  it("refuses a custom policy with no date, and changes nothing — must not fire", async () => {
    await saveSettings({ editDeadlineMode: "open" });
    const before = await stored();

    const result = await saveSettings({ editDeadlineMode: "custom", editDeadlineAt: "" });
    expect((result as { data?: { ok?: boolean } }).data?.ok).toBe(false);
    expect(await stored()).toEqual(before);
  });
});
