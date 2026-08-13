/**
 * The speaker monogram — and, since the photo lane, the frame a consented
 * headshot is drawn into.
 *
 * Callboard serves a speaker photo publicly ONLY when that person's record
 * carries explicit consent (DECISIONS #57, revised). Every other speaker still
 * gets the monogram, which is why the fallback was never an error path and
 * still isn't: it is the normal rendering for anyone who has not opted in.
 *
 * ONE definition, used by the directory, the gallery, the profile and both
 * embed widgets. Two copies of the hash would let the same person wear one tint
 * on the roster and a different one on their own page — a drift nobody would
 * catch in review because each copy looks right on its own.
 *
 * ── Why the photo is a LAYER over the initials, not a replacement ───────────
 * The public surfaces are SSR with zero client JavaScript, so there is no
 * `onError` handler to swap a broken image back to a monogram. Instead the
 * initials are always rendered, and the `<img>` is absolutely positioned over
 * them. A photo that 404s (consent withdrawn between page render and image
 * fetch, object missing from R2, offline) paints nothing — `alt=""` on a
 * decorative image means no broken-image chrome either — and the initials
 * underneath are simply revealed. The fallback needs no script and cannot get
 * out of sync with the thing it falls back to.
 *
 * The hue only ever tints the FILL, at ~14% alpha, and the initials stay a
 * near-black/near-white neutral: the same rule `TrackChip` follows, for the
 * same reason. A generated hue can land anywhere on the wheel, so it can never
 * be trusted to carry text.
 */

/** Stable per-person hue. Deterministic: the same id always gets the same tint. */
export function speakerHue(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Where the monogram is being drawn — a roster row, a gallery tile, a profile header. */
export type MonogramSize = "row" | "tile" | "profile";

const SIZE_CLASSES: Record<MonogramSize, string> = {
  row: "size-12 rounded-xl text-sm",
  tile: "aspect-square w-full rounded-xl text-4xl",
  profile: "size-28 rounded-2xl text-3xl",
};

export function SpeakerMonogram({
  personId,
  initials,
  size = "row",
  photoHref = null,
}: {
  personId: string;
  initials: string;
  size?: MonogramSize;
  /** Set only for a speaker who has consented to a public photo. */
  photoHref?: string | null;
}) {
  return (
    <span
      /*
       * Decorative: the accessible name comes from the real speaker name beside
       * it, and a screen reader announcing "R O" before "Rina Okafor" is noise.
       * That holds for the photo too — it carries no information the adjacent
       * name does not, so it is `alt=""` rather than a second reading of the
       * name.
       */
      aria-hidden="true"
      data-speaker-photo={photoHref ? personId : undefined}
      className={[
        "relative grid shrink-0 place-items-center overflow-hidden font-semibold tracking-tight text-gray-900 ring-1 ring-black/5 ring-inset dark:text-gray-100 dark:ring-white/10",
        SIZE_CLASSES[size],
      ].join(" ")}
      style={{ backgroundColor: `hsl(${speakerHue(personId)} 72% 50% / 0.14)` }}
    >
      {initials}
      {photoHref ? (
        <img
          src={photoHref}
          alt=""
          loading="lazy"
          decoding="async"
          /*
           * `absolute inset-0 size-full` rather than replacing the content:
           * see the header. `object-cover` is what keeps a non-square headshot
           * from letterboxing inside a square gallery tile.
           */
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </span>
  );
}
