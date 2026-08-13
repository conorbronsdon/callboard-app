# Publish your programme

Publishing puts a scheduled session on the public programme and sends its
speaker a calendar invitation in the same action. Callboard pauses publication
when the speaker has not been told or when the timetable cannot physically work,
so an accidental click does not quietly create either problem.

## 1. Schedule and check the session

Open [Agenda](/admin/agenda), give the session a date and time, and assign a room
if it needs one. A session without a time cannot be published.

Use the **Conflicts** view before publication. Two sessions overlap in a blocking
way when they use the same room or the same speaker at the same time. Two
sessions in the same track at the same time are only advisory: attendees may
have to choose, but the programme can still run.

## 2. Publish a session

Choose **Publish** for the scheduled session. If no hold applies, Callboard makes
the session public and sends the calendar invitation as part of that action.

Publication is not only a visibility switch. Check the title, description,
speakers, time, and room first, because the invitation uses those details.

## 3. Read a courtesy-notice hold

Callboard refuses to publish when it has no record that the speaker was informed.
This can happen when an organizer composes a session directly from an accepted
submission without using the usual acceptance flow, or when no decision notice
was sent.

The override means: publish this session even though Callboard cannot confirm
that its speaker has been told. It does not mean that a message was sent, and it
does not approve any timetable conflict. Prefer **Send decision letters now**
when the missing notice is the real problem.

## 4. Read a blocking-conflict hold

Callboard also refuses to publish a session that double-books a room or a
speaker. The conflict override means: publish despite that specific physical
conflict. It does not mark the speaker as informed.

Same-track overlap does not need this override. It is shown as advice because
it may be undesirable, but it is never a publication gate.

## 5. Use “Publish anyway” deliberately

The Agenda screen lists every held session with its reasons printed
underneath, and a single **Publish anyway** button per session. There is no
separate checkbox to tick — the button reads that session's own listed
reasons and applies exactly the override(s) they call for: the informed-gate
override when the reason is an uninformed speaker, the conflict override when
the reason is a room or speaker double-booking, or both at once when a
session carries both reasons. A session held for only one reason never
receives the other override.

This is intentional. A courtesy exception for one speaker must not silently
authorize a double-booked room, whether on that session or another one — the
two are decided together per session, never as one blanket switch.

## 6. Publish several sessions

**Publish all scheduled** publishes the ready, scheduled sessions together. It
cannot override the courtesy-notice hold: any session whose speaker has not been
informed remains private, even when the bulk action is forced through blocking
room or speaker conflicts.

To override an uninformed-speaker hold, publish that session on its own. This
keeps the affected speaker visible at the moment the organizer accepts the risk.

## 7. Confirm what went public

Open **View public schedule** and check the published session page. It offers
**Add to calendar (.ics)**, **Google Calendar**, and **Outlook** beside one
another. These are three ways to add the same event, not three separate events.

Check the communication history as well. A successful entry says
**Accepted by mail service**, not “delivered.” The mail service can confirm that it accepted
the message for sending; Callboard cannot know whether it reached the speaker's
inbox.

## Auto-placement and advisory overlaps

**Auto-place remaining** tries the available combinations of day, time, and room.
It accepts only placements with no blocking room or speaker conflict, so it does
not create those conflicts on purpose.

Auto-placement does not consider same-track overlap. Two sessions from one track
may therefore land at the same time. That is expected: track overlap is advice
for an organizer to review, not a physical impossibility.

## Unpublishing and unscheduling

Unpublishing is never gated. Taking a session off the public schedule does not
ask for either publication override.

Unscheduling removes the session's date and time and also unpublishes it. Nothing
without a scheduled time remains on the public schedule; a previously sent
calendar event is withdrawn as part of that change.

## Rooms, tracks, and session history

Deleting a room does not delete or block its sessions. Callboard moves every
session assigned to that room to **No room**, so review those sessions and place
them again.

Deleting a track is stricter. Callboard refuses while any submission, programme
session, or form still refers to the track, and the refusal names what is in the
way. Remove or change those references before trying again.

Edits to a session's title or description create a revision history with
one-click restore. Schedule moves, room changes, and publish or unpublish actions
are not content revisions and do not appear in that history.
