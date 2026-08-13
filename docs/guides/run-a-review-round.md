# Run a review round

Review rounds let an organizer give a committee a defined rubric, a set of
abstracts, and a review window. Callboard supports as many rounds as the event
needs, while keeping each round's scores, assignments, blinding, and recusals
separate.

## 1. Create the round

Open [Reviews](/admin/reviews) and choose **Create round**. Give the round a clear name and set its opening and closing dates.

There is no two-round limit. Create another round whenever the process needs a new pass, rubric,
committee, or date window. A reviewer in one round is not
automatically a reviewer in the next.

## 2. Build the rubric

Add between one and eight criteria, each one **Number**, **Dropdown**, or **Free text**. A
numeric criterion has an organizer-set minimum, maximum, and weight. A dropdown criterion has
fixed choices; its answers are recorded but are not folded into the numeric average. A free-text
criterion is an optional one-line reviewer comment — its range, weight, and options are ignored,
and like dropdown answers it is recorded per review but never counted toward the aggregate score.

The rubric needs at least one numeric criterion so the round can produce an aggregate score. Use clear labels, and check ranges and weights before assignments begin.

After any reviewer submits a score in the round, its criteria lock. You can no
longer add, remove, rename, or otherwise change them, because existing scores
must keep the rubric under which they were submitted. The round's blinding
setting remains editable after this lock.

## 3. Choose blinding for this round

Turn on **Blind this round for reviewers** when reviewers should not receive the participant's
structured identity fields. Names, email addresses, companies, and titles are excluded from the
reviewer data rather than merely hidden on the page.

The abstract remains exactly as submitted. A person who names themselves, their employer, or a
recognizable project in the prose may still be identified. Blinding protects
structured fields, not self-identifying writing.

Treat the switch as immediate. Turning blinding off, even briefly, exposes
identity to reviewers who load the page during that window. Turning it back on
stops future loads from receiving those fields, but cannot erase what someone
already saw.

## 4. Provision reviewers and committees

Use **Add reviewer** to grant review capability by email. This does not make the person an organizer
or full administrator, and it does not remove another event role they already hold; review access is an added capability.

Create committees and add reviewers to them. Each round's reviewer pool comes from the committees
assigned abstracts in that round, so choose the relevant
committee again when setting up a later round.

## 5. Assign abstracts

Filter the available abstracts by track when useful. Select abstracts and assign them to a
committee, or use **Assign all matching** to give that committee all abstracts in the current
filter. Every reviewer on the committee receives those abstracts for that round.

For a direct assignment, select an abstract and choose **Assign selected to reviewer**. Callboard
creates a solo committee behind that assignment, giving one reviewer that specific abstract without granting organizer access.

## 6. Let reviewers score or recuse themselves

Reviewers work from their own review workspace and see only abstracts assigned to them in an open
round. They score each rubric criterion, may leave a private comment, and submit the score.

A conflict of interest is declared by the reviewer with **Declare conflict**.
An organizer cannot set the recusal for them. The abstract leaves that reviewer's
queue for this round only; an assignment for the same abstract in another round
is unchanged.

A recused reviewer is removed from the amount of work they owe. Progress totals and reminders do
not count that abstract as an outstanding score for them.

## 7. Read progress and results

The round shows completed and remaining reviews plus progress by reviewer. Use
reminders for reviewers who still have assigned work, then read the round
averages and comments from the submission detail or the submissions list.

A **Contested** label means reviewers landed meaningfully far apart within the same round, not
merely a point or two apart. Callboard compares the highest and lowest reviewer's average with the
range that round's rubric allows, so narrow and wide scoring scales can be compared fairly.

Disagreement is never measured across rounds. Different results in later rounds
can reflect the committee's thinking changing, not a dispute. Recused reviews do
not enter this measure, so a recusal cannot create or conceal a disagreement.

Choose **Most contested** on the submissions list to put the largest proportional
disagreements first. The label and sort are advisory: they identify abstracts
worth discussing and never accept, decline, or otherwise change a submission.

## Exporting scores

Download `/admin/submissions/scores.csv` for a spreadsheet-ready record. Its columns begin, in
order, with ID, Title, Track, Status, Reviews, and Aggregate score, followed by one average column
for each round.

Next come columns for each dropdown criterion in each round, showing choice
distributions such as how many reviewers selected each option, then one column
per free-text criterion. Numeric criteria do not get individual columns; they
are folded into the relevant round average.

**Reviewer comments** concatenates the submitted written comments. The final two
columns are **AI triage score (advisory)** and **AI triage recommendation
(advisory)**. Their position and labels keep model output separate from human
review counts, round averages, and the overall aggregate.

## AI first-pass triage

The abstract detail page can request an AI first pass. It is advisory only: it does not write a
review or change a status, and the committee remains responsible for every decision. A deployment
without an AI binding says that the feature is unavailable instead of failing the page.

Bulk triage is capped at 12 submissions per event in any rolling one-hour window.
This limits model calls even if an organizer repeats the bulk action. A triage
opinion can be dismissed; deliberately choosing **Run again** on that submission
reverses the dismissal and creates a fresh opinion.

An opinion currently claimed by a bulk run cannot be dismissed while generation
is in progress. Callboard refuses the dismiss action and asks the organizer to
try again, rather than silently losing it or racing the running job.

Once an AI opinion exists, an organizer can record their own read on it: a
1-to-5 **Your score** with an optional one-line note, saved beside the AI
score and shown as **Organizer: N/5**. This is a lightweight organizer
annotation, not a review — it lives on the triage record itself, never on a
`reviews` row, and it does not appear in the score CSV at all (not even
among the AI-advisory columns). It is only offered once an AI opinion exists
to react to; there is no standalone way to record it first.

## Boundaries and what comes next

Blinding, recusal, and weighted rubrics are general judging tools rather than CFP-only rules. The
review engine is designed to generalize to other judging workflows, but Callboard does not currently ship a separate awards product.

This guide covers the review workflow. Once an abstract has been accepted and
becomes a programme session, see [Publish your programme](publish-your-programme.md)
for publication, speaker notices, and schedule conflicts.
