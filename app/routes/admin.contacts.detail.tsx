import { asc, desc, eq } from "drizzle-orm";

import { buttonClass, inputClass } from "~/components/portal-ui";
import { LaneStub, linkClass } from "~/components/shell";
import { getDb } from "~/db/client.server";
import {
  contactNotes,
  contactTags,
  eventPeople,
  events,
  people,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  sessionParticipants,
  sessions,
} from "~/db/schema";
import { requireAdmin } from "~/lib/auth/auth.server";
import { listEvents } from "~/lib/event.server";
import {
  enrollContact,
  loadPipelineForPerson,
  moveEntry,
  removeEntry,
} from "~/lib/pipeline.server";
import { emitWebhook } from "~/lib/webhooks/webhooks.server";
import type { Route } from "./+types/admin.contacts.detail";

const BUTTON = buttonClass("primary");
const CARD = "rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950";
type BatchArgument = Parameters<ReturnType<typeof getDb>["batch"]>[0];

export interface ContactDetailData {
  contact: null | {
    id: string;
    fullName: string | null;
    email: string;
    company: string | null;
    title: string | null;
    pronouns: string | null;
    bio: string | null;
    links: [string, string][];
    travelNotes: string | null;
    mergedInto: string | null;
  };
  events: { eventId: string; eventName: string; eventRole: string; status: string }[];
  sessions: {
    sessionId: string;
    /*
     * Grouped on the ID, never the name: two events may legitimately share a
     * name (an annual series), and a name-keyed group would show one event's
     * sessions under the other's heading.
     */
    eventId: string;
    eventName: string;
    title: string;
    role: string;
    isAbstract: boolean;
    status: string;
  }[];
  notes: { id: string; body: string; authorName: string; createdAt: Date }[];
  tags: string[];
  allEvents: { id: string; name: string }[];
  pipeline?: Awaited<ReturnType<typeof loadPipelineForPerson>>;
  pipelineStageOptions?: { value: keyof typeof PIPELINE_STAGE_LABELS; label: string }[];
}

export function meta() {
  return [{ title: "Contact — callboard admin" }];
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<ContactDetailData> {
  await requireAdmin(request);
  const db = getDb();
  const [contactRows, eventRows, sessionRows, noteRows, tagRows, everyEvent, pipeline] = await Promise.all([
    db
      .select({
        id: people.id,
        fullName: people.fullName,
        email: people.email,
        company: people.company,
        title: people.title,
        pronouns: people.pronouns,
        bio: people.bio,
        links: people.links,
        travelNotes: people.travelNotes,
        mergedInto: people.mergedInto,
      })
      .from(people)
      .where(eq(people.id, params.id)),
    db
      .select({
        eventId: events.id,
        eventName: events.name,
        eventRole: eventPeople.eventRole,
        status: eventPeople.status,
      })
      .from(eventPeople)
      .innerJoin(events, eq(events.id, eventPeople.eventId))
      .where(eq(eventPeople.personId, params.id))
      .orderBy(desc(events.createdAt)),
    db
      .select({
        sessionId: sessions.id,
        eventId: events.id,
        eventName: events.name,
        title: sessions.title,
        role: sessionParticipants.role,
        isAbstract: sessions.isAbstract,
        status: sessions.status,
      })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(eq(sessionParticipants.personId, params.id))
      .orderBy(desc(sessions.createdAt)),
    db
      .select({
        id: contactNotes.id,
        body: contactNotes.body,
        authorName: people.fullName,
        authorEmail: people.email,
        createdAt: contactNotes.createdAt,
      })
      .from(contactNotes)
      .leftJoin(people, eq(people.id, contactNotes.authorId))
      .where(eq(contactNotes.personId, params.id))
      .orderBy(desc(contactNotes.createdAt)),
    db
      .select({ tag: contactTags.tag })
      .from(contactTags)
      .where(eq(contactTags.personId, params.id))
      .orderBy(asc(contactTags.tag)),
    listEvents(),
    loadPipelineForPerson(db, params.id),
  ]);

  const found = contactRows[0];
  const attached = new Set(eventRows.map((row) => row.eventId));
  return {
    contact: found
      ? {
          ...found,
          links: Object.entries((found.links ?? {}) as Record<string, string>).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[1].trim().length > 0,
          ),
        }
      : null,
    events: eventRows,
    sessions: sessionRows,
    notes: noteRows.map(({ authorName, authorEmail, ...note }) => ({
      ...note,
      authorName: authorName ?? authorEmail ?? "Deleted organizer",
    })),
    tags: tagRows.map((row) => row.tag),
    allEvents: everyEvent.filter((event) => !attached.has(event.id)).map(({ id, name }) => ({ id, name })),
    pipeline,
    pipelineStageOptions: PIPELINE_STAGES.map((value) => ({
      value,
      label: PIPELINE_STAGE_LABELS[value],
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const db = getDb();
  const contact = await db.query.people.findFirst({
    where: eq(people.id, params.id),
  });
  if (!contact) {
    return { ok: false as const, error: "That contact does not exist." };
  }
  if (contact.mergedInto) {
    return { ok: false as const, error: "This contact was merged into another record." };
  }

  if (intent === "enroll-pipeline") {
    const result = await enrollContact(db, {
      personId: contact.id,
      stage: formData.get("stage") || "prospect",
      score: formData.get("score"),
      rationale: formData.get("rationale"),
      movedByPersonId: admin.id,
    });
    if (!result.ok) return result;
    const stage = String(formData.get("stage") || "prospect") as keyof typeof PIPELINE_STAGE_LABELS;
    return {
      ...result,
      intent,
      notice: `${contact.fullName ?? contact.email} added to the sourcing pipeline as ${PIPELINE_STAGE_LABELS[stage]}.`,
    };
  }

  if (intent === "move-pipeline") {
    const pipeline = await loadPipelineForPerson(db, contact.id);
    if (!pipeline.entry) {
      return { ok: false as const, error: "This contact is not in the sourcing pipeline." };
    }
    const result = await moveEntry(db, {
      entryId: pipeline.entry.entryId,
      toStage: formData.get("stage"),
      movedByPersonId: admin.id,
    });
    if (!result.ok) return result;
    const notice = result.moved
      ? `Moved to ${PIPELINE_STAGE_LABELS[result.to]}.`
      : "This contact is already in that sourcing stage.";
    return { ...result, intent, notice };
  }

  if (intent === "remove-pipeline") {
    const pipeline = await loadPipelineForPerson(db, contact.id);
    if (!pipeline.entry) {
      return { ok: false as const, error: "This contact is not in the sourcing pipeline." };
    }
    const result = await removeEntry(db, { entryId: pipeline.entry.entryId });
    return {
      ...result,
      intent,
      notice: "Removed from the sourcing pipeline. The transition log was kept.",
    };
  }

  if (intent === "add-note") {
    const body = String(formData.get("body") ?? "").trim();
    if (!body) return { ok: false as const, error: "A note needs some text." };
    if (body.length > 5000) {
      return {
        ok: false as const,
        error: `Note is ${body.length} characters; the limit is 5000.`,
      };
    }
    await db.insert(contactNotes).values({
      personId: contact.id,
      authorId: admin.id,
      body,
    });
    return { ok: true as const, intent, notice: "Note added." };
  }

  if (intent === "add-to-event") {
    const eventId = String(formData.get("eventId") ?? "");
    const event = await db.query.events.findFirst({ where: eq(events.id, eventId) });
    if (!event) return { ok: false as const, error: "Choose a real event." };
    await db
      .insert(eventPeople)
      .values({ eventId, personId: contact.id, eventRole: "speaker" })
      .onConflictDoNothing();
    return {
      ok: true as const,
      intent,
      notice: `Added to ${event.name}; the existing profile was reused.`,
    };
  }

  if (intent === "set-tags") {
    const normalized = String(formData.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);
    const tags = [...new Set(normalized)];
    const tooLong = tags.find((tag) => tag.length > 40);
    if (tooLong) {
      return { ok: false as const, error: `Tag "${tooLong}" is ${tooLong.length} characters; the limit is 40.` };
    }
    if (tags.length > 12) {
      return { ok: false as const, error: `This contact has ${tags.length} tags; the limit is 12.` };
    }
    const statements = [
      db.delete(contactTags).where(eq(contactTags.personId, contact.id)),
      ...(tags.length ? [db.insert(contactTags).values(tags.map((tag) => ({ personId: contact.id, tag })))] : []),
    ];
    await db.batch(statements as unknown as BatchArgument);
    return { ok: true as const, intent, notice: tags.length ? "Tags saved." : "Tags cleared." };
  }

  if (intent === "save-travel") {
    const travelNotes = String(formData.get("travelNotes") ?? "").trim();
    if (travelNotes.length > 2000) {
      return { ok: false as const, error: `Travel notes are ${travelNotes.length} characters; the limit is 2000.` };
    }
    await db.update(people).set({ travelNotes: travelNotes || null }).where(eq(people.id, contact.id));
    await emitWebhook("contact.updated", contact.id, {
      field: "travelNotes",
      travelNotes: travelNotes || null,
    });
    return { ok: true as const, intent, notice: "Travel and logistics saved." };
  }

  return { ok: false as const, error: `Unknown intent "${intent}".` };
}

type DetailActionData = Awaited<ReturnType<typeof action>> | undefined;

export function ContactDetailScreen({ data, actionData }: { data: ContactDetailData; actionData?: DetailActionData }) {
  if (!data.contact) {
    return (
      <LaneStub lane="Contact not found">
        No such contact. <a className={linkClass} href="/admin/contacts">Back to contacts</a>.
      </LaneStub>
    );
  }

  const contact = data.contact;
  const pipeline = data.pipeline ?? { entry: null, transitions: [] };
  const pipelineStageOptions = data.pipelineStageOptions ?? [];
  const pipelineStageLabel = (stage: keyof typeof PIPELINE_STAGE_LABELS) =>
    pipelineStageOptions.find((option) => option.value === stage)?.label ?? stage;
  return (
    <div className="space-y-4">
      <a className={linkClass} href="/admin/contacts">Back to contacts</a>
      {actionData && "error" in actionData ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">{actionData.error}</p> : null}
      {actionData && "notice" in actionData ? <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">{actionData.notice}</p> : null}
      {contact.mergedInto ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">This record was merged into another contact. <a className={linkClass} href={`/admin/contacts/${contact.mergedInto}`}>View the surviving contact</a>.</div> : null}

      <section className={CARD}>
        <h2 className="text-xl font-semibold">{contact.fullName ?? contact.email}</h2>
        <p className="mt-1 text-sm"><a className={linkClass} href={`mailto:${contact.email}`}>{contact.email}</a></p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{[contact.company, contact.title].filter(Boolean).join("-") || "No affiliation on file"}{contact.pronouns ? ` - ${contact.pronouns}` : ""}</p>
        {contact.links.length ? <ul className="mt-3 flex flex-wrap gap-3 text-sm">{contact.links.map(([label, href]) => <li key={label}><a className={linkClass} href={href}>{label}</a></li>)}</ul> : null}
        <p className="mt-3 text-sm leading-relaxed">{contact.bio ?? "No biography on file."}</p>
      </section>

      <section className={CARD} data-testid="contact-tags">
        <h3 className="font-semibold">Tags</h3>
        {data.tags.length ? <div className="mt-2 flex flex-wrap gap-1">{data.tags.map((tag) => <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">{tag}</span>)}</div> : <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No tags on this contact. Tags are free-text labels you add below, and they drive saved segments in the contacts directory.</p>}
        {!contact.mergedInto ? <form method="post" className="mt-3 space-y-2"><label className="block text-sm">Comma-separated tags<input name="tags" defaultValue={data.tags.join(", ")} className={inputClass} /></label><p className="text-xs text-gray-500 dark:text-gray-400">Save an empty field to clear all tags.</p><button type="submit" name="intent" value="set-tags" className={BUTTON}>Save tags</button></form> : null}
      </section>

      <section className={CARD} data-testid="contact-pipeline">
        <h3 className="font-semibold">Sourcing pipeline</h3>
        {!pipeline.entry ? (
          <>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              This contact is not currently in the sourcing pipeline.
            </p>
            {!contact.mergedInto ? (
              <form method="post" className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  Stage
                  <select name="stage" defaultValue="prospect" className={inputClass}>
                    {pipelineStageOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Score (optional)
                  <input name="score" type="number" min={0} max={100} className={inputClass} />
                </label>
                <label className="text-sm">
                  Rationale (optional)
                  <input name="rationale" type="text" maxLength={1000} className={inputClass} />
                </label>
                <div className="sm:col-span-3">
                  <button type="submit" name="intent" value="enroll-pipeline" className={BUTTON}>
                    Add to pipeline
                  </button>
                </div>
              </form>
            ) : null}
          </>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                {pipelineStageLabel(pipeline.entry.stage)}
              </span>
              <span className="text-sm">
                {pipeline.entry.score === null ? "No score" : `Score ${pipeline.entry.score}`}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">
              {pipeline.entry.rationale ?? "No rationale recorded."}
            </p>
            {!contact.mergedInto ? (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <form method="post" className="flex flex-wrap items-end gap-2">
                  <label className="text-sm">
                    Sourcing stage
                    <select name="stage" defaultValue={pipeline.entry.stage} className={inputClass}>
                      {pipelineStageOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" name="intent" value="move-pipeline" className={BUTTON}>
                    Move
                  </button>
                </form>
                <form method="post">
                  <button type="submit" name="intent" value="remove-pipeline" className={buttonClass("danger")}>
                    Remove from pipeline
                  </button>
                </form>
                <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
                  Removing the contact keeps the transition log for future reference.
                </p>
              </div>
            ) : null}
          </>
        )}
        <div className="mt-5">
          <h4 className="font-medium">Transition log</h4>
          <ol
            className="mt-2 divide-y divide-gray-200 dark:divide-gray-800"
            data-testid="pipeline-transitions"
          >
            {pipeline.transitions.length ? (
              pipeline.transitions.map((transition) => {
                const timestamp = new Date(transition.createdAt).toISOString();
                return (
                  <li key={transition.id} className="py-3 text-sm">
                    <p>
                      {transition.fromStage === null
                        ? `Enrolled as ${pipelineStageLabel(transition.toStage)}`
                        : `${pipelineStageLabel(transition.fromStage)} -> ${pipelineStageLabel(transition.toStage)}`}
                    </p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {transition.byName} - <time dateTime={timestamp}>{timestamp}</time>
                    </p>
                  </li>
                );
              })
            ) : (
              <li className="py-2 text-sm text-gray-500 dark:text-gray-400">No pipeline transitions recorded yet. Adding this contact to the sourcing pipeline or moving them to another stage logs who made the change and when.</li>
            )}
          </ol>
        </div>
      </section>

      <section className={CARD} data-testid="contact-travel">
        <h3 className="font-semibold">Travel and logistics</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">Internal organizer context that is never shown publicly.</p>
        {!contact.mergedInto ? <form method="post" className="mt-3 space-y-2"><label className="block text-sm">Travel notes<textarea name="travelNotes" rows={5} maxLength={2000} defaultValue={contact.travelNotes ?? ""} className={inputClass} /></label><button type="submit" name="intent" value="save-travel" className={BUTTON}>Save travel notes</button></form> : contact.travelNotes ? <p className="mt-3 whitespace-pre-wrap text-sm">{contact.travelNotes}</p> : null}
      </section>

      <section className={CARD}>
        <h3 className="font-semibold">Add to event</h3>
        {contact.mergedInto ? <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Merged records cannot be added to events.</p> : data.allEvents.length ? (
          <form method="post" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">Event<select name="eventId" required className={inputClass}><option value="">Choose an event</option>{data.allEvents.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label>
            <button type="submit" name="intent" value="add-to-event" className={BUTTON}>Add to event</button>
            <p className="basis-full text-xs text-gray-500 dark:text-gray-400">Adding reuses this profile; the contact is not duplicated.</p>
          </form>
        ) : <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">This contact is already attached to every event.</p>}
      </section>

      <section className={CARD} data-testid="contact-event-history">
        <h3 className="font-semibold">Event history</h3>
        {data.events.length === 0 ? <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Not attached to any event yet.</p> : (
          <ul className="mt-3 space-y-4">{data.events.map((event) => {
            const eventSessions = data.sessions.filter((session) => session.eventId === event.eventId);
            return <li key={event.eventId} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{event.eventName}</span><span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800">{event.eventRole}</span><span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200">{event.status}</span></div>
              {eventSessions.length ? <ul className="mt-2 space-y-1 text-sm">{eventSessions.map((session) => <li key={`${session.sessionId}-${session.role}`}><a className={linkClass} href={`/admin/submissions/${session.sessionId}`}>{session.title}</a> - {session.role}{session.isAbstract ? " - abstract" : ""}</li>)}</ul> : <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">No sessions for this contact. Talks appear here when this person is attached as a speaker or co-author.</p>}
            </li>;
          })}</ul>
        )}
      </section>

      <section className={CARD} data-testid="contact-notes">
        <h3 className="font-semibold">Internal notes</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">Organizer-only; never shown to the speaker.</p>
        {!contact.mergedInto ? <form method="post" className="mt-3 space-y-2">
          <label className="block text-sm">Add a note<textarea name="body" rows={4} maxLength={5000} required className={inputClass} /></label>
          <button type="submit" name="intent" value="add-note" className={BUTTON}>Add note</button>
        </form> : null}
        {data.notes.length ? <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-800">{data.notes.map((note) => {
          const timestamp = new Date(note.createdAt).toISOString();
          return <li key={note.id} className="py-3"><p className="whitespace-pre-wrap text-sm">{note.body}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{note.authorName} - <time dateTime={timestamp}>{timestamp}</time></p></li>;
        })}</ul> : <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No internal notes yet. Notes you add above stay with the team and are never shown to the speaker.</p>}
      </section>
    </div>
  );
}

export default function AdminContactDetail({ loaderData, actionData }: Route.ComponentProps) {
  return <ContactDetailScreen data={loaderData} actionData={actionData} />;
}
