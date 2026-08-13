/**
 * A minimal STORE-only ZIP writer (CNT-14).
 *
 * Why hand-rolled: the bulk download runs inside a Worker, and pulling a
 * compression library in for PDFs, PPTX and PNGs — all three already
 * compressed — would spend the memory ceiling to save nothing. Method 0
 * (stored) needs no compressor at all, so the only real work is CRC-32 and the
 * header layout.
 *
 * Deliberately NOT Zip64: `MAX_ZIP_BYTES` keeps an archive far below the 4 GiB
 * field width, and the route refuses a selection above it rather than emitting
 * a file whose size fields silently wrap. A truncated archive that opens is
 * worse than a refusal that explains itself.
 */

/**
 * Refuse to build an archive larger than this. Guards the Worker's memory.
 *
 * The number is derived, not chosen. The download path holds the source bytes
 * and the finished archive AT THE SAME TIME — the route buffers every object
 * into `entries`, then `buildZip` allocates a second buffer of the same order
 * and the `Response` keeps it alive until the body is read. So peak allocation
 * is roughly 2x this constant, against a Worker isolate's 128 MB. At the
 * original 60 MB that peak was ~120 MB plus runtime overhead: a legitimate
 * 55 MB selection sat on the edge of an OOM, and the cap that was supposed to
 * protect the isolate was the thing sizing the failure.
 *
 * The floor is `MAX_UPLOAD_BYTES`: a cap below the single-file upload limit
 * would make some individual files undownloadable through the library, which is
 * a worse bug than the one being fixed. 30 MB clears that floor and lands the
 * 2x peak near 60 MB. `zip.test.ts` pins both ends of that arithmetic.
 *
 * Streaming the archive would remove the doubling entirely and is the right
 * long-term shape; it needs a `ReadableStream` writer and per-entry CRC as the
 * bytes arrive, which is more surgery than this correction warrants.
 */
export const MAX_ZIP_BYTES = 30 * 1024 * 1024;

/** Cloudflare's per-isolate memory allowance. The reason the cap above exists. */
export const WORKER_MEMORY_BYTES = 128 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive. Sanitised by `zipSafeName` before use. */
  name: string;
  bytes: Uint8Array;
}

/**
 * Make a filename safe to write into an archive.
 *
 * Strips drive letters, leading slashes and every `..` segment: a stored path
 * like `../../etc/passwd` is a real extraction attack against the person who
 * opens the zip, and the names here come from user-supplied uploads.
 */
export function zipSafeName(name: string): string {
  const cleaned = name
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.replace(/[\x00-\x1f<>:"|?*]/g, "_").trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

/** Ensure names are unique — two speakers can both upload `slides.pdf`. */
export function uniqueZipNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = zipSafeName(raw);
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0
      ? `${name.slice(0, dot)} (${count})${name.slice(dot)}`
      : `${name} (${count})`;
  });
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value & 0xffff, true);
}
function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

/** MS-DOS date/time. Fixed at 1980-01-01 — upload times live in the DB, not here. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/**
 * Build a complete store-only archive.
 *
 * Returns one buffer: an archive of `MAX_ZIP_BYTES` is well inside a Worker's
 * allowance, and streaming would still need every entry's CRC and length in the
 * local header before its bytes, so the saving is smaller than it looks.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = uniqueZipNames(entries.map((entry) => entry.name)).map((name) =>
    encoder.encode(name),
  );

  let size = 0;
  for (let i = 0; i < entries.length; i += 1) {
    size += 30 + names[i].length + entries[i].bytes.length; // local header + data
    size += 46 + names[i].length; // central directory record
  }
  size += 22; // end of central directory

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let cursor = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const { bytes } = entries[i];
    const name = names[i];
    const crc = crc32(bytes);
    offsets.push(cursor);
    crcs.push(crc);

    u32(view, cursor, 0x04034b50);
    u16(view, cursor + 4, 20); // version needed
    u16(view, cursor + 6, 0x0800); // UTF-8 filename flag
    u16(view, cursor + 8, 0); // method: stored
    u16(view, cursor + 10, DOS_TIME);
    u16(view, cursor + 12, DOS_DATE);
    u32(view, cursor + 14, crc);
    u32(view, cursor + 18, bytes.length);
    u32(view, cursor + 22, bytes.length);
    u16(view, cursor + 26, name.length);
    u16(view, cursor + 28, 0);
    out.set(name, cursor + 30);
    out.set(bytes, cursor + 30 + name.length);
    cursor += 30 + name.length + bytes.length;
  }

  const centralStart = cursor;
  for (let i = 0; i < entries.length; i += 1) {
    const name = names[i];
    u32(view, cursor, 0x02014b50);
    u16(view, cursor + 4, 20); // version made by
    u16(view, cursor + 6, 20); // version needed
    u16(view, cursor + 8, 0x0800);
    u16(view, cursor + 10, 0);
    u16(view, cursor + 12, DOS_TIME);
    u16(view, cursor + 14, DOS_DATE);
    u32(view, cursor + 16, crcs[i]);
    u32(view, cursor + 20, entries[i].bytes.length);
    u32(view, cursor + 24, entries[i].bytes.length);
    u16(view, cursor + 28, name.length);
    u16(view, cursor + 30, 0); // extra
    u16(view, cursor + 32, 0); // comment
    u16(view, cursor + 34, 0); // disk number
    u16(view, cursor + 36, 0); // internal attrs
    u32(view, cursor + 38, 0); // external attrs
    u32(view, cursor + 42, offsets[i]);
    out.set(name, cursor + 46);
    cursor += 46 + name.length;
  }

  u32(view, cursor, 0x06054b50);
  u16(view, cursor + 4, 0);
  u16(view, cursor + 6, 0);
  u16(view, cursor + 8, entries.length);
  u16(view, cursor + 10, entries.length);
  u32(view, cursor + 12, cursor - centralStart);
  u32(view, cursor + 16, centralStart);
  u16(view, cursor + 20, 0);

  return out;
}
