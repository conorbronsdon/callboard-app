export type ReviewProgressMember = {
  teamId: string;
  personId: string;
  name: string | null;
  email: string;
};

export type ReviewProgressAssignment = {
  roundId: string;
  teamId: string;
  sessionId: string;
};

export type SubmittedReview = {
  roundId: string;
  sessionId: string;
  reviewerId: string;
};

export type ReviewerProgress = {
  personId: string;
  name: string | null;
  email: string;
  teamNames: string[];
  assigned: number;
  completed: number;
  remaining: number;
};

export type RoundProgress = {
  expectedReviews: number;
  completedReviews: number;
  remainingReviews: number;
  completedReviewers: number;
  reviewerCount: number;
  unstaffedAssignments: number;
  reviewers: ReviewerProgress[];
  /**
   * Which abstracts each reviewer still owes, so the reminder email can NAME
   * them. It rides on the round rather than on `ReviewerProgress` because the
   * per-reviewer shape is asserted with a strict `toEqual` elsewhere, and a
   * reminder detail is not something the progress table renders.
   */
  remainingSessionIdsByReviewer: Map<string, string[]>;
};

/**
 * Derive organizer-facing progress from team assignments. A reviewer who is on
 * two teams assigned to the same abstract still owes only one review.
 *
 * `excludedReviews` are recusals: work the reviewer has declared they cannot do.
 * They leave the reviewer's denominator entirely rather than counting as
 * completed — calling a recusal "done" would let a round report 100% while an
 * abstract nobody reviewed sits in it.
 */
export function buildRoundProgress({
  roundId,
  members,
  assignments,
  submittedReviews,
  excludedReviews = [],
  teamNames,
}: {
  roundId: string;
  members: ReviewProgressMember[];
  assignments: ReviewProgressAssignment[];
  submittedReviews: SubmittedReview[];
  excludedReviews?: SubmittedReview[];
  teamNames: Map<string, string>;
}): RoundProgress {
  const roundAssignments = assignments.filter((assignment) => assignment.roundId === roundId);
  const membersByTeam = new Map<string, ReviewProgressMember[]>();
  for (const member of members) {
    const teamMembers = membersByTeam.get(member.teamId) ?? [];
    teamMembers.push(member);
    membersByTeam.set(member.teamId, teamMembers);
  }

  const assignedSessionsByReviewer = new Map<string, Set<string>>();
  const reviewerDetails = new Map<string, ReviewProgressMember>();
  const reviewerTeams = new Map<string, Set<string>>();
  let unstaffedAssignments = 0;

  for (const assignment of roundAssignments) {
    const teamMembers = membersByTeam.get(assignment.teamId) ?? [];
    if (teamMembers.length === 0) unstaffedAssignments += 1;
    for (const member of teamMembers) {
      reviewerDetails.set(member.personId, member);
      const sessions = assignedSessionsByReviewer.get(member.personId) ?? new Set<string>();
      sessions.add(assignment.sessionId);
      assignedSessionsByReviewer.set(member.personId, sessions);
      const teams = reviewerTeams.get(member.personId) ?? new Set<string>();
      teams.add(teamNames.get(member.teamId) ?? "Unnamed team");
      reviewerTeams.set(member.personId, teams);
    }
  }

  const submitted = new Set(
    submittedReviews
      .filter((review) => review.roundId === roundId)
      .map((review) => `${review.reviewerId}:${review.sessionId}`),
  );
  const excluded = new Set(
    excludedReviews
      .filter((review) => review.roundId === roundId)
      .map((review) => `${review.reviewerId}:${review.sessionId}`),
  );

  const remainingSessionIdsByReviewer = new Map<string, string[]>();
  const reviewers = Array.from(assignedSessionsByReviewer, ([personId, sessionIds]) => {
    const person = reviewerDetails.get(personId)!;
    const activeSessionIds = Array.from(sessionIds).filter(
      (sessionId) => !excluded.has(`${personId}:${sessionId}`),
    );
    const remainingSessionIds = activeSessionIds
      .filter((sessionId) => !submitted.has(`${personId}:${sessionId}`))
      .sort((a, b) => a.localeCompare(b));
    remainingSessionIdsByReviewer.set(personId, remainingSessionIds);
    const completed = activeSessionIds.length - remainingSessionIds.length;
    return {
      personId,
      name: person.name,
      email: person.email,
      teamNames: Array.from(reviewerTeams.get(personId) ?? []).sort((a, b) => a.localeCompare(b)),
      assigned: activeSessionIds.length,
      completed,
      remaining: activeSessionIds.length - completed,
    };
  }).sort(
    (a, b) =>
      b.remaining - a.remaining ||
      a.completed / a.assigned - b.completed / b.assigned ||
      (a.name ?? a.email).localeCompare(b.name ?? b.email),
  );

  const expectedReviews = reviewers.reduce((total, reviewer) => total + reviewer.assigned, 0);
  const completedReviews = reviewers.reduce((total, reviewer) => total + reviewer.completed, 0);

  return {
    expectedReviews,
    completedReviews,
    remainingReviews: expectedReviews - completedReviews,
    completedReviewers: reviewers.filter((reviewer) => reviewer.remaining === 0).length,
    reviewerCount: reviewers.length,
    unstaffedAssignments,
    reviewers,
    remainingSessionIdsByReviewer,
  };
}
