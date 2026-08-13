import { describe, expect, it } from "vitest";

import { ADMIN_ASSIGNABLE_STATUSES } from "~/lib/review/pipeline";

import { submissionDropIntent } from "./submissions-board";

describe("submissionDropIntent", () => {
  it.each(ADMIN_ASSIGNABLE_STATUSES)(
    "maps a drop onto the %s column to the existing set-status fields",
    (status) => {
      expect(
        submissionDropIntent("session-123", status, ADMIN_ASSIGNABLE_STATUSES),
      ).toEqual({
        intent: "set-status",
        sessionId: "session-123",
        status,
      });
    },
  );

  it("maps a same-status drop and lets the server decide whether it is a no-op", () => {
    expect(
      submissionDropIntent(
        "session-current",
        "pending",
        ADMIN_ASSIGNABLE_STATUSES,
      ),
    ).toEqual({
      intent: "set-status",
      sessionId: "session-current",
      status: "pending",
    });
  });

  it.each(["draft", "withdrawn", null, undefined, 42, { id: "pending" }])(
    "MUST NOT FIRE: rejects a non-assignable drop target %#",
    (overId) => {
      expect(
        submissionDropIntent("session-123", overId, ADMIN_ASSIGNABLE_STATUSES),
      ).toBeNull();
    },
  );

  it.each(["", "   ", "\t\n"])(
    "MUST NOT FIRE: rejects a blank session id %#",
    (sessionId) => {
      expect(
        submissionDropIntent(sessionId, "pending", ADMIN_ASSIGNABLE_STATUSES),
      ).toBeNull();
    },
  );
});
