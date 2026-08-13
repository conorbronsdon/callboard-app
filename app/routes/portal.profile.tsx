/**
 * Portal → Profile. **The buyer's red annotation: "update your own bio data".**
 *
 * Everything a speaker can maintain about themselves lives on this one screen:
 * headshot, name/pronouns/company/title, bio, links, and slides/documents.
 *
 * Sessionboard splits these — the profile screen has no headshot upload at all;
 * a photo only arrives through a Task or a File Request, which is why their own
 * dashboard has to track "missing a bio or headshot" as a chase-up. Putting the
 * upload where the speaker already is removes the chase. (Proposed DECISIONS
 * entry — WS3 does not edit that file on its branch.)
 *
 * Four independent forms share the route, discriminated by `intent`, so a
 * failed upload never discards typed bio text.
 */
import { Form, useNavigation } from "react-router";
import { eq } from "drizzle-orm";

import { BioEditor } from "~/components/BioEditor";
import {
  Avatar,
  Card,
  EmptyState,
  FieldLabel,
  Notice,
  buttonClass,
  inputClass,
} from "~/components/portal-ui";
import { getDb } from "~/db/client.server";
import { people } from "~/db/schema";
import { renderMarkdown } from "~/lib/markdown";
import { ACCEPT_ATTRIBUTE, formatBytes, uploadConstraintText } from "~/lib/portal-uploads";
import { FileVersions } from "~/components/file-history";
import { buildLibrary, type LibraryChain, type LibraryRow } from "~/lib/files-library";
import { RATE_LIMIT_POLICIES, enforceRateLimit } from "~/lib/rate-limit.server";
import { portalContext, publicPerson } from "~/lib/portal/portal.server";
import {
  deletePersonUpload,
  listPersonUploads,
  storeUpload,
} from "~/lib/portal/uploads.server";
import type { Route } from "./+types/portal.profile";

const BIO_MAX = 5000;

/**
 * The sentence that turns an upload into permission.
 *
 * Written to be understood on one reading: it names the surfaces by the words
 * a speaker would see in the site's own navigation, states that it happens on
 * upload rather than "may be used", and says how to undo it. Exported so the
 * route's tests can assert it is rendered — see the comment at its render site
 * for why a missing notice must fail the build rather than quietly ship.
 */
export const PUBLIC_PHOTO_NOTICE =
  "Uploading a photo here publishes it on the public speaker pages — the speaker directory, the speaker gallery, and your own speaker profile — for every event where you speak, not only this one. Ask an organizer if you would like it taken down.";

const LINK_FIELDS = [
  { key: "linkedin", label: "LinkedIn URL", placeholder: "https://www.linkedin.com/in/…" },
  { key: "x", label: "X (Twitter) URL", placeholder: "https://x.com/…" },
  { key: "github", label: "GitHub URL", placeholder: "https://github.com/…" },
  { key: "website", label: "Website", placeholder: "https://…" },
] as const;

export function meta() {
  return [{ title: "Your profile — callboard" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { actor } = await portalContext(request);
  const uploads = await listPersonUploads(actor.person.id);

  return {
    person: publicPerson(actor.person),
    bioPreview: renderMarkdown(actor.person.bio),
    /*
     * Grouped into version chains (CNT-04), not listed flat: two rows both
     * called `slides.pdf` with no dates is precisely the state this replaces.
     */
    files: buildLibrary(
      uploads
        .filter((upload) => upload.purpose !== "headshot")
        .map(
          (upload): LibraryRow => ({
            id: upload.id,
            versionOf: upload.versionOf,
            version: upload.version,
            filename: upload.filename,
            contentType: upload.contentType,
            purpose: upload.purpose,
            sizeBytes: upload.sizeBytes,
            createdAt: upload.createdAt.getTime(),
            ownerType: upload.ownerType,
            ownerId: upload.ownerId,
            uploaderName: null,
            sessionTitle: null,
            ownerPersonName: null,
          }),
        ),
    ),
    headshot: uploads.find((upload) => upload.purpose === "headshot") ?? null,
    headshotSize: (() => {
      const current = uploads.find((upload) => upload.purpose === "headshot");
      return current ? formatBytes(current.sizeBytes) : null;
    })(),
    accept: {
      headshot: ACCEPT_ATTRIBUTE.headshot,
      slides: ACCEPT_ATTRIBUTE.slides,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { actor, event } = await portalContext(request);

  /*
   * The THIRD way into `storeUpload`, and the last one.
   *
   * #85 capped `/api/upload`; #90 capped `/portal/tasks/:taskId` and its
   * comment said that covered "both doors". It is four: `/api/upload`, the
   * public submit step, the task form, and this screen — headshot and document
   * uploads from an authenticated session, with no limiter at all. Rejected
   * uploads leave no `uploads` row, so the per-owner storage quota does not cap
   * the attempts either; that is the argument that made the original finding
   * and it applies here unchanged.
   *
   * Same policy and the same constant `"upload"` scope on purpose: scope is
   * part of the `(scope, identifier_hash, window_start)` primary key AND is
   * HMAC'd into the digest, so a route-specific scope would be a second full
   * allowance rather than a shared bucket. One bucket per person, three doors.
   *
   * Placed before `request.formData()`, as on the other two doors: reject a
   * flooder before buffering the body. Every intent on this route is therefore
   * charged, not only the ones carrying a file, because whether a file is
   * attached is not knowable until the body has been read — which is the thing
   * this call exists to avoid doing for an abusive caller.
   *
   * The identifier is the REAL caller, matching `uploadedById` below: an
   * organizer previewing a speaker's portal must not spend that speaker's
   * allowance.
   */
  const uploader = actor.impersonatedBy?.id ?? actor.person.id;
  await enforceRateLimit({
    scope: "upload",
    identifier: uploader,
    policy: RATE_LIMIT_POLICIES.apiUpload,
    message: "Too many files were uploaded. Please wait before trying again.",
  });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const db = getDb();

  if (intent === "details") {
    const fullName = String(form.get("fullName") ?? "").trim();
    if (!fullName) return { error: "Your name cannot be blank.", intent };

    const bio = String(form.get("bio") ?? "");
    if (bio.length > BIO_MAX) {
      return { error: `Your bio is ${bio.length} characters — the limit is ${BIO_MAX}.`, intent };
    }

    const links: Record<string, string> = {};
    for (const field of LINK_FIELDS) {
      const value = String(form.get(`link_${field.key}`) ?? "").trim();
      if (!value) continue;
      if (!/^https?:\/\/\S+\.\S+/i.test(value)) {
        return { error: `${field.label} must start with http:// or https://.`, intent };
      }
      links[field.key] = value;
    }

    const [first, ...rest] = fullName.split(" ");
    await db
      .update(people)
      .set({
        fullName,
        firstName: first ?? null,
        lastName: rest.join(" ") || null,
        pronouns: String(form.get("pronouns") ?? "").trim() || null,
        company: String(form.get("company") ?? "").trim() || null,
        title: String(form.get("title") ?? "").trim() || null,
        bio: bio.trim() || null,
        links,
      })
      .where(eq(people.id, actor.person.id));

    return { ok: "Profile saved.", intent };
  }

  if (intent === "headshot" || intent === "document") {
    const file = form.get("file");
    if (!(file instanceof File)) return { error: "Choose a file first.", intent };

    const result = await storeUpload({
      file,
      eventId: event.id,
      ownerType: "person",
      ownerId: actor.person.id,
      purpose: intent === "headshot" ? "headshot" : "slides",
      uploadedById: uploader,
    });
    if (!result.ok) return { error: result.error, intent };

    /*
     * THE CONSENT EVENT.
     *
     * `PUBLIC_PHOTO_NOTICE` is rendered beside the file control on this form.
     * A speaker who uploads with that sentence on screen has been told, in
     * plain words and at the moment of the act, where the photo goes — so the
     * upload itself is the permission, and nothing else in the product sets
     * this flag from a speaker's side.
     *
     * `!actor.impersonatedBy` is the load-bearing half. An organizer previewing
     * this page through /admin/view-as sees the same notice, but they are not
     * the person in the photograph and cannot consent on their behalf. An
     * organizer who has permission out of band uses the explicit toggle on the
     * admin speaker record, where the act is theirs and is logged as theirs.
     *
     * The flag is only ever raised here, never lowered: a speaker replacing
     * their photo has not withdrawn anything, and silently un-publishing them
     * on re-upload would drop them out of the gallery with no explanation.
     */
    if (intent === "headshot" && !actor.impersonatedBy) {
      await db
        .update(people)
        .set({ photoPublishable: true })
        .where(eq(people.id, actor.person.id));
    }

    return { ok: intent === "headshot" ? "Headshot updated." : `Uploaded ${file.name}.`, intent };
  }

  if (intent === "delete-file") {
    const uploadId = String(form.get("uploadId") ?? "");
    const removed = await deletePersonUpload(actor.person.id, uploadId);
    return removed
      ? { ok: "File removed.", intent }
      : { error: "That file is not yours to delete.", intent };
  }

  return { error: "Unknown action.", intent };
}

export default function PortalProfile({ loaderData, actionData }: Route.ComponentProps) {
  const { person, bioPreview, files, headshot, headshotSize, accept } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar
          name={person.fullName}
          email={person.email}
          size="lg"
          src={person.hasHeadshot ? `/portal/headshot/${person.id}` : null}
        />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{person.fullName ?? person.email}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{person.email}</p>
        </div>
      </div>

      {actionData?.error ? <Notice tone="error">{actionData.error}</Notice> : null}
      {actionData?.ok ? <Notice tone="success">{actionData.ok}</Notice> : null}

      {/* ─────────── headshot ─────────── */}
      <Card title="Headshot">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar
            name={person.fullName}
            email={person.email}
            size="lg"
            src={person.hasHeadshot ? `/portal/headshot/${person.id}` : null}
          />
          <Form
            method="post"
            encType="multipart/form-data"
            className="min-w-0 flex-1 space-y-2"
          >
            <input type="hidden" name="intent" value="headshot" />
            <FieldLabel htmlFor="headshot" hint={`Square, at least 800×800. ${uploadConstraintText("headshot")}`}>
              Upload a new photo
            </FieldLabel>
            {/*
              * The notice sits BETWEEN the label and the file input, not in a
              * footnote and not behind a disclosure. It is the thing that makes
              * the upload a consent event rather than a surprise, so it has to
              * be unavoidable at the moment of the act — a speaker who scrolls
              * past a collapsed "learn more" has not been told anything.
              *
              * `PUBLIC_PHOTO_NOTICE` is exported so the action's own test can
              * assert that the sentence the flag depends on is actually on the
              * page. A consent flag set by a form whose notice has been deleted
              * is worse than no flag at all.
              */}
            <p
              data-testid="headshot-public-notice"
              className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100"
            >
              {PUBLIC_PHOTO_NOTICE}
            </p>
            <input
              id="headshot"
              type="file"
              name="file"
              accept={accept.headshot}
              required
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
            />
            <button type="submit" className={buttonClass()} disabled={busy}>
              {busy ? "Uploading…" : "Upload headshot"}
            </button>
            {headshot ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Current: {headshot.filename} ({headshotSize})
              </p>
            ) : null}
          </Form>
        </div>
      </Card>

      {/* ─────────── details + bio + links ─────────── */}
      <Form method="post" className="space-y-5">
        <input type="hidden" name="intent" value="details" />

        <Card title="General">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FieldLabel htmlFor="fullName" required>
                Full name
              </FieldLabel>
              <input
                id="fullName"
                name="fullName"
                defaultValue={person.fullName ?? ""}
                required
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="pronouns">Pronouns</FieldLabel>
              <input
                id="pronouns"
                name="pronouns"
                defaultValue={person.pronouns ?? ""}
                placeholder="she/her"
                className={inputClass}
              />
            </div>
            <div>
              <FieldLabel htmlFor="company">Company</FieldLabel>
              <input
                id="company"
                name="company"
                defaultValue={person.company ?? ""}
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel htmlFor="title">Job title</FieldLabel>
              <input
                id="title"
                name="title"
                defaultValue={person.title ?? ""}
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel
                htmlFor="bio"
                hint="Third person reads best on a programme page. Formatting is markdown."
              >
                Biography
              </FieldLabel>
              <div className="mt-1.5">
                <BioEditor name="bio" defaultValue={person.bio ?? ""} maxLength={BIO_MAX} />
              </div>
            </div>
          </div>
        </Card>

        <Card title="My links" tone="plain">
          <div className="grid gap-4 sm:grid-cols-2">
            {LINK_FIELDS.map((field) => (
              <div key={field.key}>
                <FieldLabel htmlFor={`link_${field.key}`}>{field.label}</FieldLabel>
                <input
                  id={`link_${field.key}`}
                  name={`link_${field.key}`}
                  type="url"
                  inputMode="url"
                  defaultValue={person.links[field.key] ?? ""}
                  placeholder={field.placeholder}
                  className={inputClass}
                />
              </div>
            ))}
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonClass()} disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Changes appear on the public speaker page once the programme is published.
          </p>
        </div>
      </Form>

      {/* ─────────── bio preview ─────────── */}
      {bioPreview ? (
        <Card title="How your bio will read" tone="plain">
          <div
            className="prose-portal text-sm leading-relaxed"
            // Server-rendered from markdown and passed through the sanitiser.
            dangerouslySetInnerHTML={{ __html: bioPreview }}
          />
        </Card>
      ) : null}

      {/* ─────────── slides + documents ─────────── */}
      <Card title={`Slides and documents (${files.length})`}>
        <Form method="post" encType="multipart/form-data" className="space-y-2">
          <input type="hidden" name="intent" value="document" />
          <FieldLabel htmlFor="doc" hint={`16:9 works best. ${uploadConstraintText("slides")}`}>
            Upload a deck or document
          </FieldLabel>
          <input
            id="doc"
            type="file"
            name="file"
            accept={accept.slides}
            required
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
          />
          <button type="submit" className={buttonClass("secondary")} disabled={busy}>
            Upload file
          </button>
        </Form>

        <div className="mt-4">
          {files.length === 0 ? (
            <EmptyState title="No files yet">
              Slides you upload here are visible to the programme team.
            </EmptyState>
          ) : (
            <ul className="space-y-4">
              {files.map((file: LibraryChain) => (
                <li key={file.rootId} data-testid="file-chain" data-root-id={file.rootId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {file.filename}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {file.versions.length} version{file.versions.length === 1 ? "" : "s"}
                    </span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-file" />
                      <input type="hidden" name="uploadId" value={file.latest.id} />
                      <button type="submit" className="text-xs text-rose-600 underline">
                        Remove latest
                      </button>
                    </Form>
                  </div>
                  <FileVersions versions={file.versions} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
