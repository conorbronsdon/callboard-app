/**
 * The library's pure shaping rules, and the constraint copy that must not
 * drift from the enforced limit (CNT-04, CNT-06, CNT-13).
 *
 * Every case is paired. "v2 is marked Latest" proves nothing on its own — a
 * function that marked EVERY row Latest would pass it — so each must-fire sits
 * beside the must-not-fire the broken version would trip.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildLibrary, fileTimestamp, librarySummary, type LibraryRow } from "./files-library";
import {
  MAX_UPLOAD_BYTES,
  numberVersions,
  rootUploadId,
  uploadConstraintText,
  validateUpload,
} from "./portal-uploads";
import {
  MAX_ZIP_BYTES,
  WORKER_MEMORY_BYTES,
  buildZip,
  crc32,
  uniqueZipNames,
  zipSafeName,
} from "./zip";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

function row(over: Partial<LibraryRow> & { id: string }): LibraryRow {
  return {
    versionOf: null,
    version: 1,
    filename: "slides.pdf",
    contentType: "application/pdf",
    purpose: "document",
    sizeBytes: 1024,
    createdAt: T0,
    ownerType: "session",
    ownerId: "sess-1",
    uploaderName: "Ingrid Speaker",
    sessionTitle: "Your AI Pair Programmer",
    ownerPersonName: null,
    ...over,
  };
}

describe("rootUploadId", () => {
  it("MUST FIRE: v1 is its own root and a later version points back at it", () => {
    expect(rootUploadId({ id: "a", versionOf: null })).toBe("a");
    expect(rootUploadId({ id: "b", versionOf: "a" })).toBe("a");
  });

  it("MUST NOT FIRE: it never returns the child's own id when a root exists", () => {
    expect(rootUploadId({ id: "b", versionOf: "a" })).not.toBe("b");
  });
});

describe("numberVersions", () => {
  it("MUST FIRE: numbers oldest-first and marks exactly the newest Latest", () => {
    const numbered = numberVersions([
      { id: "b", version: 2, createdAt: T0 },
      { id: "a", version: 1, createdAt: T0 },
      { id: "c", version: 3, createdAt: T0 },
    ]);
    expect(numbered.map((v) => [v.id, v.version, v.isLatest])).toEqual([
      ["a", 1, false],
      ["b", 2, false],
      ["c", 3, true],
    ]);
    // MUST NOT FIRE: exactly one Latest, not "all of them" and not "none".
    expect(numbered.filter((v) => v.isLatest)).toHaveLength(1);
  });

  it("MUST FIRE: orders by the STORED version even when timestamps are identical", () => {
    // `uploads.created_at` is second-resolution, so this is the real case: two
    // uploads a moment apart carry the SAME epoch. A time-ordered sort would
    // mark Latest by row-order luck; the stored counter cannot.
    const same = numberVersions([
      { id: "second", version: 2, createdAt: T0 },
      { id: "first", version: 1, createdAt: T0 },
    ]);
    expect(same.map((v) => v.id)).toEqual(["first", "second"]);
    expect(same[1].isLatest).toBe(true);

    // ...and the reverse input order gives the identical answer.
    const flipped = numberVersions([
      { id: "first", version: 1, createdAt: T0 },
      { id: "second", version: 2, createdAt: T0 },
    ]);
    expect(flipped.map((v) => v.id)).toEqual(same.map((v) => v.id));
  });

  it("a single upload is version 1 AND Latest", () => {
    expect(numberVersions([{ id: "only", version: 1, createdAt: T0 }])).toEqual([
      { id: "only", version: 1, createdAt: T0, isLatest: true },
    ]);
  });
});

describe("buildLibrary", () => {
  const chainRows = [
    row({ id: "v1" }),
    row({ id: "v2", versionOf: "v1", version: 2, createdAt: T0 + HOUR, sizeBytes: 2048 }),
    row({
      id: "solo",
      versionOf: null,
      filename: "headshot.png",
      purpose: "headshot",
      ownerType: "person",
      ownerId: "pe-1",
      sessionTitle: null,
      ownerPersonName: "Ingrid Speaker",
      createdAt: T0 - HOUR,
    }),
  ];

  it("MUST FIRE: two uploads of one deliverable collapse into one entry with both versions", () => {
    const chains = buildLibrary(chainRows);
    const deck = chains.find((chain) => chain.rootId === "v1");
    expect(deck?.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(deck?.latest.id).toBe("v2");
    expect(deck?.latest.isLatest).toBe(true);
    expect(deck?.versions[0].isLatest).toBe(false);
  });

  it("MUST NOT FIRE: an unrelated upload does NOT join that chain", () => {
    const chains = buildLibrary(chainRows);
    expect(chains).toHaveLength(2);
    expect(chains.find((chain) => chain.rootId === "solo")?.versions).toHaveLength(1);
  });

  it("labels a session-owned file by session and a person-owned file by person", () => {
    const chains = buildLibrary(chainRows);
    expect(chains.find((c) => c.rootId === "v1")).toMatchObject({
      linkageKind: "session",
      linkageLabel: "Your AI Pair Programmer",
    });
    expect(chains.find((c) => c.rootId === "solo")).toMatchObject({
      linkageKind: "person",
      linkageLabel: "Ingrid Speaker",
    });
  });

  it("names the chain after the NEWEST version, not the first one", () => {
    const chains = buildLibrary([
      row({ id: "v1", filename: "draft.pdf" }),
      row({ id: "v2", versionOf: "v1", version: 2, filename: "final.pdf", createdAt: T0 + HOUR }),
    ]);
    expect(chains[0].filename).toBe("final.pdf");
  });

  it("counts every version's bytes and every comment against its own chain", () => {
    const comments = new Map([
      ["v1", [{ id: "c1", authorName: "Ada Organiser", body: "Looks good", createdAt: T0 }]],
    ]);
    const chains = buildLibrary(chainRows, comments);
    const deck = chains.find((chain) => chain.rootId === "v1");
    expect(deck?.totalBytes).toBe(1024 + 2048);
    expect(deck?.comments).toHaveLength(1);
    // MUST NOT FIRE: the other chain does not inherit that thread.
    expect(chains.find((chain) => chain.rootId === "solo")?.comments).toHaveLength(0);
  });

  it("orders deliverables by their newest version, newest first", () => {
    expect(buildLibrary(chainRows).map((chain) => chain.rootId)).toEqual(["v1", "solo"]);
  });

  it("summarises files, deliverables and total size", () => {
    expect(librarySummary(buildLibrary(chainRows))).toBe(
      "3 files across 2 deliverables · 4 KB",
    );
    expect(librarySummary([])).toBe("0 files across 0 deliverables · 0 B");
  });

  it("renders an unambiguous absolute timestamp", () => {
    expect(fileTimestamp(T0)).toBe("2026-08-08 12:00 UTC");
  });
});

describe("upload constraint copy (CNT-06)", () => {
  it("MUST FIRE: the stated cap is the cap the validator enforces", () => {
    const stated = uploadConstraintText("document");
    expect(stated).toContain(`${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

    // The complement: a file one byte over the stated number is REJECTED, and
    // the rejection quotes the same figure. A copy string that merely contained
    // "25 MB" would pass the line above while the server allowed 30.
    const rejection = validateUpload({
      size: MAX_UPLOAD_BYTES + 1,
      contentType: "application/pdf",
      purpose: "document",
      filename: "big.pdf",
    });
    expect(rejection).toContain(`${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

    // MUST NOT FIRE: a file at exactly the cap is accepted, so the sentence is
    // not describing a limit stricter than the one enforced.
    expect(
      validateUpload({
        size: MAX_UPLOAD_BYTES,
        contentType: "application/pdf",
        purpose: "document",
        filename: "exact.pdf",
      }),
    ).toBeNull();
  });

  it("names the accepted types the validator actually accepts", () => {
    expect(uploadConstraintText("headshot")).toContain("JPEG");
    expect(
      validateUpload({
        size: 10,
        contentType: "image/jpeg",
        purpose: "headshot",
        filename: "p.jpg",
      }),
    ).toBeNull();
    // MUST NOT FIRE: a PDF is not a headshot, and the copy never claims it is.
    expect(uploadConstraintText("headshot")).not.toContain("PDF");
    expect(
      validateUpload({
        size: 10,
        contentType: "application/pdf",
        purpose: "headshot",
        filename: "p.pdf",
      }),
    ).not.toBeNull();
  });

  it("no upload surface hard-codes the megabyte figure in its own copy", () => {
    // The drift this exists to catch: someone types "up to 25 MB" into JSX and
    // the cap later changes. Reading the SOURCE is the only way to see it.
    const surfaces = [
      "../routes/portal.task.tsx",
      "../routes/portal.profile.tsx",
      "../components/submit/fields.tsx",
    ];
    for (const relative of surfaces) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(source).not.toMatch(/up to \d+ ?MB/i);
    }
  });
});

describe("zip writer (CNT-14)", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("MUST FIRE: produces a real archive with the local and central signatures", () => {
    const zip = buildZip([{ name: "a.txt", bytes: bytes("hello") }]);
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // End-of-central-directory sits in the last 22 bytes and claims one entry.
    const view = new DataView(zip.buffer, zip.byteLength - 22);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
    expect(view.getUint16(8, true)).toBe(1);
    // The stored bytes are present verbatim — method 0 means no compression.
    expect(new TextDecoder().decode(zip).includes("hello")).toBe(true);
  });

  it("counts every entry, so the archive cannot silently drop a file", () => {
    const zip = buildZip([
      { name: "a.txt", bytes: bytes("one") },
      { name: "b.txt", bytes: bytes("two") },
      { name: "c.txt", bytes: bytes("three") },
    ]);
    const view = new DataView(zip.buffer, zip.byteLength - 22);
    expect(view.getUint16(8, true)).toBe(3);
  });

  it("MUST NOT FIRE: a traversal filename cannot escape the archive root", () => {
    expect(zipSafeName("../../etc/passwd")).toBe("etc/passwd");
    expect(zipSafeName("C:/Windows/system32")).toBe("C_/Windows/system32");
    expect(zipSafeName("../..")).toBe("file");
    // ...and ordinary filenames survive intact — a sanitiser that mangled every
    // name would pass the assertions above.
    expect(zipSafeName("Q3-final_deck.v2.pdf")).toBe("Q3-final_deck.v2.pdf");
  });

  it("de-duplicates names so two speakers' slides.pdf both survive", () => {
    expect(uniqueZipNames(["slides.pdf", "slides.pdf", "notes.md"])).toEqual([
      "slides.pdf",
      "slides (1).pdf",
      "notes.md",
    ]);
  });

  it("computes the standard CRC-32", () => {
    // Known-answer vector: CRC-32("123456789") = 0xCBF43926.
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    // MUST NOT FIRE: a different input gives a different digest.
    expect(crc32(bytes("12345678"))).not.toBe(0xcbf43926);
  });

  /**
   * The cap is an arithmetic claim about memory, so it is asserted as one.
   *
   * The download route holds the source bytes AND the finished archive at the
   * same time — `entries` is fully populated before `buildZip` allocates its
   * own exact-size output, and the `Response` keeps that output alive. Peak is
   * therefore ~2x the cap. At the original 60 MB that put a legitimate 55 MB
   * selection at ~120 MB against a 128 MB isolate: the constant meant to
   * protect the Worker was the thing sizing the failure.
   *
   * Both ends are pinned, because moving the cap in either direction breaks
   * something real. Raising it re-creates the OOM; dropping it below
   * MAX_UPLOAD_BYTES makes an individually-legal file undownloadable.
   */
  it("MUST FIRE: the archive cap leaves headroom for its own 2x peak", () => {
    const doubling = 2;
    // A quarter of the isolate is left for the runtime, the app and the R2
    // client; "under 128 MB" with nothing spare is not headroom.
    expect(MAX_ZIP_BYTES * doubling).toBeLessThanOrEqual(WORKER_MEMORY_BYTES * 0.75);
  });

  it("MUST NOT FIRE: the cap is not so low that a single legal upload is undownloadable", () => {
    expect(MAX_ZIP_BYTES).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
    // And a real archive of one max-size file still fits: the ZIP overhead per
    // entry is ~76 bytes plus the name, so the floor above is not off by a
    // structure the writer adds. Measured on a small entry rather than
    // allocating 25 MB in a unit test.
    const overhead = buildZip([{ name: "deck.pdf", bytes: bytes("x") }]).length - 1;
    expect(MAX_UPLOAD_BYTES + overhead).toBeLessThanOrEqual(MAX_ZIP_BYTES);
  });
});
