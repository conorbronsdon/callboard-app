import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { avatarHue, avatarPng } from "./avatar.mjs";

/**
 * These avatars replace public headshots, so a merely decodable file is not
 * enough: identity stability, correct dimensions, real pixel variation, and
 * checksums that detect corruption are all part of the public contract. The
 * parser below deliberately shares no encoder code, keeping a green test from
 * being the result of generator and verifier repeating the same mistake.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseChunks(png) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunks.push({
      type,
      data: png.subarray(dataStart, dataEnd),
      storedCrc: png.readUInt32BE(dataEnd),
    });
    offset = dataEnd + 4;
  }
  return chunks;
}

describe("geometric avatar PNG", () => {
  it("is byte-identical for the same seed", () => {
    expect(avatarPng("abc", 64).equals(avatarPng("abc", 64))).toBe(true);
  });

  it("changes when the seed changes", () => {
    expect(avatarPng("abc", 64).equals(avatarPng("abd", 64))).toBe(false);
  });

  it("starts with the exact PNG signature", () => {
    expect(avatarPng("abc", 64).subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("writes the requested RGB dimensions into IHDR", () => {
    const requestedSize = 73;
    const ihdr = parseChunks(avatarPng("abc", requestedSize))[0];
    expect(ihdr.type).toBe("IHDR");
    expect(ihdr.data.readUInt32BE(0)).toBe(requestedSize);
    expect(ihdr.data.readUInt32BE(4)).toBe(requestedSize);
    expect(ihdr.data[8]).toBe(8);
    expect(ihdr.data[9]).toBe(2);
  });

  it("writes valid CRCs and detects a mutated IDAT byte", () => {
    const chunks = parseChunks(avatarPng("abc", 64));
    for (const current of chunks) {
      const checkedBytes = Buffer.concat([Buffer.from(current.type, "ascii"), current.data]);
      expect(crc32(checkedBytes)).toBe(current.storedCrc);
    }

    const idat = chunks.find((current) => current.type === "IDAT");
    const changedData = Buffer.from(idat.data);
    changedData[Math.floor(changedData.length / 2)] ^= 0x01;
    const changedBytes = Buffer.concat([Buffer.from("IDAT", "ascii"), changedData]);
    expect(crc32(changedBytes)).not.toBe(idat.storedCrc);
  });

  it("contains several colours without one colour swallowing the image", () => {
    const size = 96;
    const chunks = parseChunks(avatarPng("abc", size));
    const compressed = Buffer.concat(
      chunks.filter((current) => current.type === "IDAT").map((current) => current.data),
    );
    const scanlines = inflateSync(compressed);
    const counts = new Map();
    for (let y = 0; y < size; y += 1) {
      const rowStart = y * (size * 3 + 1);
      expect(scanlines[rowStart]).toBe(0);
      for (let x = 0; x < size; x += 1) {
        const offset = rowStart + 1 + x * 3;
        const colour = scanlines.subarray(offset, offset + 3).toString("hex");
        counts.set(colour, (counts.get(colour) ?? 0) + 1);
      }
    }
    expect(counts.size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(size * size * 0.9);
  });

  it("spreads consecutive seeded ids across the colour wheel", () => {
    /*
     * The assertion that matters for a GRID, and the one the first cut failed.
     * `scripts/seed.mjs` mints person ids that differ only in their final
     * characters; an un-finalised string hash mapped eight of them onto hues
     * 264-271, so the gallery rendered as one purple repeated six times. This
     * pins the fix as a measured property rather than as a comment.
     */
    const ids = Array.from(
      { length: 8 },
      (_, index) => `000000pe-0000-4000-8000-0000000000${String(10 + index).padStart(2, "0")}`,
    );
    const hues = ids.map((id) => avatarHue(id));

    const sextants = new Set(hues.map((hue) => Math.floor(hue / 60)));
    expect(new Set(hues).size).toBe(ids.length);
    expect(Math.max(...hues) - Math.min(...hues)).toBeGreaterThan(180);
    expect(sextants.size).toBeGreaterThanOrEqual(4);

    /*
     * The control. Every assertion above is a threshold, and a threshold is
     * only evidence if the broken input actually crosses it — so run the
     * PREVIOUS hash (no avalanche finalizer, the one still used by
     * `speakerHue`) through the same measurement and confirm it collapses.
     */
    const unmixed = ids.map((id) => {
      let hash = 0;
      for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      return hash % 360;
    });
    expect(Math.max(...unmixed) - Math.min(...unmixed)).toBeLessThan(20);
    expect(new Set(unmixed.map((hue) => Math.floor(hue / 60))).size).toBe(1);
  });
});
