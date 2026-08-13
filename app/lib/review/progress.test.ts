import { describe, expect, it } from "vitest";

import { buildRoundProgress } from "./progress";

const members = [
  { teamId: "team-a", personId: "alex", name: "Alex", email: "alex@example.com" },
  { teamId: "team-b", personId: "alex", name: "Alex", email: "alex@example.com" },
  { teamId: "team-a", personId: "bea", name: "Bea", email: "bea@example.com" },
];

describe("buildRoundProgress", () => {
  it("must fire: shows each reviewer's unique assigned and completed work", () => {
    const progress = buildRoundProgress({
      roundId: "round-a",
      members,
      assignments: [
        { roundId: "round-a", teamId: "team-a", sessionId: "session-1" },
        { roundId: "round-a", teamId: "team-b", sessionId: "session-1" },
        { roundId: "round-a", teamId: "team-a", sessionId: "session-2" },
        { roundId: "round-a", teamId: "team-empty", sessionId: "session-3" },
      ],
      submittedReviews: [
        { roundId: "round-a", sessionId: "session-1", reviewerId: "alex" },
        { roundId: "round-a", sessionId: "session-1", reviewerId: "bea" },
      ],
      teamNames: new Map([
        ["team-a", "AI"],
        ["team-b", "Data"],
        ["team-empty", "Workshops"],
      ]),
    });

    expect(progress).toMatchObject({
      expectedReviews: 4,
      completedReviews: 2,
      remainingReviews: 2,
      completedReviewers: 0,
      reviewerCount: 2,
      unstaffedAssignments: 1,
    });
    expect(progress.reviewers).toEqual([
      {
        personId: "alex",
        name: "Alex",
        email: "alex@example.com",
        teamNames: ["AI", "Data"],
        assigned: 2,
        completed: 1,
        remaining: 1,
      },
      {
        personId: "bea",
        name: "Bea",
        email: "bea@example.com",
        teamNames: ["AI"],
        assigned: 2,
        completed: 1,
        remaining: 1,
      },
    ]);
  });

  it("must not fire: ignores other rounds, unassigned reviews, and duplicate team coverage", () => {
    const progress = buildRoundProgress({
      roundId: "round-a",
      members,
      assignments: [
        { roundId: "round-a", teamId: "team-a", sessionId: "session-1" },
        { roundId: "round-a", teamId: "team-b", sessionId: "session-1" },
        { roundId: "round-b", teamId: "team-a", sessionId: "session-2" },
      ],
      submittedReviews: [
        { roundId: "round-b", sessionId: "session-1", reviewerId: "alex" },
        { roundId: "round-a", sessionId: "unassigned", reviewerId: "alex" },
      ],
      teamNames: new Map([
        ["team-a", "AI"],
        ["team-b", "Data"],
      ]),
    });

    expect(progress.expectedReviews).toBe(2);
    expect(progress.completedReviews).toBe(0);
    expect(progress.reviewers.map(({ personId, assigned }) => ({ personId, assigned }))).toEqual([
      { personId: "alex", assigned: 1 },
      { personId: "bea", assigned: 1 },
    ]);
  });
});
