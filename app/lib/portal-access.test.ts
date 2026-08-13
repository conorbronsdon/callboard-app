/**
 * Cross-account (IDOR) tests. Every case is written twice: speaker B is
 * refused, and speaker A is still allowed. A rule that only ever fires is
 * indistinguishable from `() => false`, which would break the product while
 * looking secure.
 */
import { describe, expect, it } from "vitest";

import {
  canAccessTask,
  canDeleteUpload,
  canEditProfile,
  canReadUpload,
  type Viewer,
} from "./portal-access";

const EVENT = "event-1";
const OTHER_EVENT = "event-2";

const speakerA: Viewer = { id: "person-a", role: "speaker" };
const speakerB: Viewer = { id: "person-b", role: "speaker" };
const admin: Viewer = { id: "person-admin", role: "admin" };

const taskOfA = { personId: "person-a", eventId: EVENT };
const headshotOfA = { ownerType: "person" as const, ownerId: "person-a", uploadedById: "person-a" };
const deckOnSession = {
  ownerType: "session" as const,
  ownerId: "session-1",
  uploadedById: "person-a",
};

describe("canAccessTask", () => {
  /* must fire */
  it("refuses speaker B access to speaker A's task", () => {
    expect(canAccessTask(taskOfA, speakerB, EVENT)).toBe(false);
  });

  it("refuses a task from a different event even to its owner", () => {
    expect(canAccessTask(taskOfA, speakerA, OTHER_EVENT)).toBe(false);
  });

  it("refuses a cross-event task to an admin too", () => {
    expect(canAccessTask(taskOfA, admin, OTHER_EVENT)).toBe(false);
  });

  /* must NOT fire */
  it("allows speaker A their own task", () => {
    expect(canAccessTask(taskOfA, speakerA, EVENT)).toBe(true);
  });

  it("allows an admin any task inside the event", () => {
    expect(canAccessTask(taskOfA, admin, EVENT)).toBe(true);
  });
});

describe("canReadUpload", () => {
  /* must fire */
  it("refuses speaker B speaker A's headshot", () => {
    expect(canReadUpload(headshotOfA, speakerB)).toBe(false);
  });

  it("refuses a session-attached file to an unrelated speaker", () => {
    expect(canReadUpload(deckOnSession, speakerB)).toBe(false);
  });

  it("does not treat a null uploader as a match for a viewer", () => {
    expect(
      canReadUpload({ ownerType: "session", ownerId: "s", uploadedById: null }, speakerB),
    ).toBe(false);
  });

  /* must NOT fire */
  it("allows the owner to read their own headshot", () => {
    expect(canReadUpload(headshotOfA, speakerA)).toBe(true);
  });

  it("allows the uploader to read a file they attached to a session", () => {
    expect(canReadUpload(deckOnSession, speakerA)).toBe(true);
  });

  it("allows an admin to read anything", () => {
    expect(canReadUpload(headshotOfA, admin)).toBe(true);
    expect(canReadUpload(deckOnSession, admin)).toBe(true);
  });
});

describe("canDeleteUpload", () => {
  /* must fire — delete is stricter than read */
  it("refuses speaker B", () => {
    expect(canDeleteUpload(headshotOfA, speakerB)).toBe(false);
  });

  it("refuses a co-speaker who merely uploaded a session file", () => {
    expect(canReadUpload(deckOnSession, speakerA)).toBe(true); // can read…
    expect(canDeleteUpload(deckOnSession, speakerA)).toBe(false); // …but not delete
  });

  /* must NOT fire */
  it("allows the person the file is attached to", () => {
    expect(canDeleteUpload(headshotOfA, speakerA)).toBe(true);
  });

  it("allows an admin", () => {
    expect(canDeleteUpload(deckOnSession, admin)).toBe(true);
  });
});

describe("canEditProfile", () => {
  it("refuses speaker B editing speaker A", () => {
    expect(canEditProfile("person-a", speakerB)).toBe(false);
  });

  it("refuses even an admin editing directly — admins go through impersonation", () => {
    expect(canEditProfile("person-a", admin)).toBe(false);
  });

  it("allows a speaker editing themselves", () => {
    expect(canEditProfile("person-a", speakerA)).toBe(true);
  });
});
