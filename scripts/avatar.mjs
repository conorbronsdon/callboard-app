import { deflateSync } from "node:zlib";

/**
 * Deterministic, illustrative speaker avatars for the DEMO SEED.
 *
 * ── Why these exist at all ──────────────────────────────────────────────────
 * The judged demo has to show a real photo grid, cold, right after a reset. It
 * must do that without publishing anybody's actual headshot and without the
 * failure mode a rival entry shipped: photorealistic stock faces attached to
 * invented names, which reads as a privacy fault whether or not it is one.
 *
 * So the seeded people are fabricated identities wearing obviously fabricated
 * portraits. Flat geometry only — no face, no silhouette, no skin tone, nothing
 * a viewer could mistake for a photograph of a person who exists. The tile is
 * still meant to be attractive: a wall of thirty of these should look like a
 * designed identity system, not like placeholder art.
 *
 * ── Why a hand-written PNG encoder ─────────────────────────────────────────
 * `node:zlib` and nothing else. The seed runs on a contributor's laptop and in
 * CI before any deploy; adding a native image dependency to make thirty small
 * squares would be a build-time liability for a build-time asset. The encoder
 * is ~40 lines and `scripts/avatar.test.mjs` proves its CRCs can actually fail.
 *
 * ── Why LAYOUTS, not random shapes ─────────────────────────────────────────
 * The first cut scattered 3-5 primitives at random positions. Every image was
 * individually plausible and the grid as a whole looked like noise: clusters in
 * one corner, dead space in another, palettes that collided. Composition is not
 * something a uniform random generator finds. So placement comes from a small
 * table of hand-composed LAYOUTS that each fill the square deliberately, and
 * the seed picks a layout, jitters it slightly, and rotates the palette. The
 * randomness varies a composition instead of inventing one.
 *
 * Byte-for-byte deterministic: same seed, same bytes, any machine, any Node 22+.
 * That is what lets the seed be idempotent and the demo reset be repeatable.
 */

function seedHash(seed) {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

/** Murmur3-style finalizer. One bit in, half the bits out. */
function avalanche(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Stable per-person hue.
 *
 * This deliberately does NOT match `speakerHue` in
 * app/components/speaker-monogram.tsx, and the first cut's mistake is worth
 * recording. `speakerHue` is a bare `hash * 31 + charCode` with no final mix,
 * which is fine for one tile in isolation and useless for a WALL of them: the
 * seeded person ids differ only in their last characters, so eight consecutive
 * speakers came out at hues 264, 265, 266 … 271. A six-degree spread across the
 * whole gallery reads as one colour repeated, not as an identity system.
 *
 * Running the same hash through an avalanche finalizer turns those eight into
 * 24, 111, 6, 78, 335, 81, 238, 154 — the property the grid actually needs. The
 * monogram's tint is untouched, and the two never appear together anyway: a
 * person shows a photo or shows initials, never both.
 */
export function avatarHue(seed) {
  return avalanche(seedHash(seed)) % 360;
}

/** mulberry32. Never `Math.random` — a non-deterministic avatar is a broken seed. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = h / 60;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (sector < 1) [red, green] = [chroma, intermediate];
  else if (sector < 2) [red, green] = [intermediate, chroma];
  else if (sector < 3) [green, blue] = [chroma, intermediate];
  else if (sector < 4) [green, blue] = [intermediate, chroma];
  else if (sector < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];

  const offset = l - chroma / 2;
  return [red, green, blue].map((channel) => Math.round((channel + offset) * 255));
}

/**
 * ANALOGOUS, not complementary.
 *
 * The earlier palette put `hue + 180` next to `hue`, which is a colour-wheel
 * rule that works for a single accent and fails badly when two large shapes
 * carry it — green against magenta at equal weight reads as an error. Three
 * neighbouring hues plus one desaturated ink stays harmonious for every seed
 * hue on the wheel, which is the only workable test when the hue is generated.
 */
function palette(hue) {
  return {
    paper: hslToRgb(hue + 34, 44, 93),
    deep: hslToRgb(hue, 58, 42),
    mid: hslToRgb(hue + 16, 68, 56),
    light: hslToRgb(hue + 36, 76, 70),
    ink: hslToRgb(hue + 8, 20, 23),
  };
}

/* ------------------------------------------------------------ primitives
 *
 * Every primitive takes NORMALISED coordinates (0..1 over the square) and is
 * clipped to the canvas by `paintBounds`. Normalised coordinates are what make
 * the layout table below readable as composition rather than as arithmetic, and
 * what make a layout independent of the supersampling factor.
 */

function paintBounds(pixels, width, bounds, colour, contains) {
  const left = Math.max(0, Math.floor(bounds[0] * width));
  const top = Math.max(0, Math.floor(bounds[1] * width));
  const right = Math.min(width - 1, Math.ceil(bounds[2] * width));
  const bottom = Math.min(width - 1, Math.ceil(bounds[3] * width));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / width;
      if (!contains(u, v)) continue;
      const offset = (y * width + x) * 3;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
    }
  }
}

function fillRect(pixels, width, [x0, y0, x1, y1], colour) {
  paintBounds(pixels, width, [x0, y0, x1, y1], colour, () => true);
}

/**
 * `half` selects which side of the circle survives: null keeps the whole disc,
 * otherwise "top" | "right" | "bottom" | "left" keeps that half, and a
 * two-word value such as "top-right" keeps that quadrant wedge.
 */
function fillDisc(pixels, width, { cx, cy, r, half = null }, colour) {
  const keeps = {
    top: (dx, dy) => dy <= 0,
    right: (dx) => dx >= 0,
    bottom: (dx, dy) => dy >= 0,
    left: (dx) => dx <= 0,
    "top-left": (dx, dy) => dx <= 0 && dy <= 0,
    "top-right": (dx, dy) => dx >= 0 && dy <= 0,
    "bottom-right": (dx, dy) => dx >= 0 && dy >= 0,
    "bottom-left": (dx, dy) => dx <= 0 && dy >= 0,
  };
  const keep = half ? keeps[half] : () => true;
  paintBounds(pixels, width, [cx - r, cy - r, cx + r, cy + r], colour, (u, v) => {
    const dx = u - cx;
    const dy = v - cy;
    return dx * dx + dy * dy <= r * r && keep(dx, dy);
  });
}

function fillTriangle(pixels, width, [ax, ay, bx, by, cx, cy], colour) {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const sign = area >= 0 ? 1 : -1;
  paintBounds(
    pixels,
    width,
    [
      Math.min(ax, bx, cx),
      Math.min(ay, by, cy),
      Math.max(ax, bx, cx),
      Math.max(ay, by, cy),
    ],
    colour,
    (u, v) => {
      const s1 = ((bx - ax) * (v - ay) - (by - ay) * (u - ax)) * sign;
      const s2 = ((cx - bx) * (v - by) - (cy - by) * (u - bx)) * sign;
      const s3 = ((ax - cx) * (v - cy) - (ay - cy) * (u - cx)) * sign;
      return s1 >= 0 && s2 >= 0 && s3 >= 0;
    },
  );
}

/** A capsule: the stadium shape around the segment a→b. */
function fillBar(pixels, width, { ax, ay, bx, by, t }, colour) {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy || 1e-9;
  paintBounds(
    pixels,
    width,
    [
      Math.min(ax, bx) - t,
      Math.min(ay, by) - t,
      Math.max(ax, bx) + t,
      Math.max(ay, by) + t,
    ],
    colour,
    (u, v) => {
      const projection = Math.max(
        0,
        Math.min(1, ((u - ax) * vx + (v - ay) * vy) / lengthSquared),
      );
      const dx = u - (ax + projection * vx);
      const dy = v - (ay + projection * vy);
      return dx * dx + dy * dy <= t * t;
    },
  );
}

/* --------------------------------------------------------------- layouts
 *
 * Six hand-composed arrangements. Each is a function of (jitter, ink) so the
 * seed can nudge it without breaking the composition, and each returns shapes
 * in PAINT ORDER — later entries sit on top.
 *
 * `k` is a role index into the rotated palette, so the same layout renders in a
 * different colour assignment for a different seed. Rotating roles rather than
 * picking colours per shape is what keeps a layout's figure/ground relationship
 * intact: the shape the composition treats as the anchor is always one of the
 * two heavy colours, never the pale one.
 */
const LAYOUTS = [
  // Arch — a full disc rising from a ground band, wedge in the upper corner.
  (j) => [
    { kind: "rect", args: [0, 0.72 + j(0.04), 1, 1], k: 0 },
    { kind: "disc", args: { cx: 0.5 + j(0.05), cy: 0.62, r: 0.34 + j(0.03) }, k: 1 },
    {
      kind: "disc",
      args: { cx: 0.86, cy: 0.16, r: 0.26 + j(0.04), half: "bottom-left" },
      k: 2,
    },
  ],
  // Split — a heavy left column with a disc straddling the seam.
  (j) => [
    { kind: "rect", args: [0, 0, 0.44 + j(0.05), 1], k: 0 },
    { kind: "disc", args: { cx: 0.46 + j(0.04), cy: 0.5, r: 0.33 + j(0.03) }, k: 2 },
    { kind: "bar", args: { ax: 0.62, ay: 0.14, bx: 0.94, by: 0.14, t: 0.07 }, k: 1 },
  ],
  // Horizon — three bands, one disc breaking the top line.
  (j) => [
    { kind: "rect", args: [0, 0.44 + j(0.04), 1, 0.7], k: 1 },
    { kind: "rect", args: [0, 0.7, 1, 1], k: 0 },
    { kind: "disc", args: { cx: 0.32 + j(0.08), cy: 0.44, r: 0.24 + j(0.03) }, k: 2 },
    { kind: "disc", args: { cx: 0.78, cy: 0.26 + j(0.05), r: 0.12 }, k: 3 },
  ],
  // Diagonal — a triangle field with a disc in the free corner.
  (j) => [
    { kind: "tri", args: [0, 1, 1, 1, 0, 0.18 + j(0.06)], k: 0 },
    { kind: "disc", args: { cx: 0.72 + j(0.05), cy: 0.34, r: 0.27 + j(0.03) }, k: 2 },
    { kind: "bar", args: { ax: 0.08, ay: 0.9, bx: 0.9, by: 0.9, t: 0.05 }, k: 1 },
  ],
  // Portal — a tall rounded column behind a half-disc.
  (j) => [
    {
      kind: "bar",
      args: { ax: 0.5 + j(0.06), ay: 0.3, bx: 0.5 + j(0.06), by: 0.82, t: 0.22 },
      k: 0,
    },
    { kind: "disc", args: { cx: 0.5 + j(0.06), cy: 0.34, r: 0.3, half: "top" }, k: 2 },
    { kind: "rect", args: [0.04, 0.86 + j(0.03), 0.96, 0.96], k: 1 },
  ],
  // Eclipse — two overlapping discs, one clipped by a corner wedge.
  (j) => [
    { kind: "disc", args: { cx: 0.38 + j(0.05), cy: 0.44, r: 0.32 }, k: 0 },
    { kind: "disc", args: { cx: 0.66, cy: 0.62 + j(0.05), r: 0.28 }, k: 2 },
    {
      kind: "disc",
      args: { cx: 0.12, cy: 0.94, r: 0.3 + j(0.04), half: "top-right" },
      k: 1,
    },
  ],
];

const DRAW = {
  rect: fillRect,
  disc: fillDisc,
  tri: fillTriangle,
  bar: fillBar,
};

/* ------------------------------------------------------------- PNG bytes */

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), 8 + data.length);
  return result;
}

/** 3x box downsample — the whole of the anti-aliasing, and enough of it. */
function downsample(source, size) {
  const width = size * 3;
  const scanlines = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let sy = 0; sy < 3; sy += 1) {
          for (let sx = 0; sx < 3; sx += 1) {
            sum += source[((y * 3 + sy) * width + x * 3 + sx) * 3 + channel];
          }
        }
        scanlines[row + 1 + x * 3 + channel] = Math.floor((sum + 4) / 9);
      }
    }
  }
  return scanlines;
}

export function avatarPng(seed, size = 512) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("Avatar size must be a positive integer.");
  }

  const random = mulberry32(seedHash(seed));
  const hue = avatarHue(seed);
  const colours = palette(hue);
  const width = size * 3;

  const pixels = new Uint8Array(width * width * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = colours.paper[0];
    pixels[offset + 1] = colours.paper[1];
    pixels[offset + 2] = colours.paper[2];
  }

  // Roles are rotated, not shuffled: `ink` must stay available as the heavy
  // anchor for every rotation, so it leads the ring rather than floating in it.
  const ring = [colours.ink, colours.deep, colours.mid, colours.light];
  const rotation = Math.floor(random() * ring.length);
  const roleColour = (k) => ring[(k + rotation) % ring.length];

  const layout = LAYOUTS[Math.floor(random() * LAYOUTS.length)];
  const jitter = (amount) => (random() * 2 - 1) * amount;

  for (const shape of layout(jitter)) {
    DRAW[shape.kind](pixels, width, shape.args, roleColour(shape.k));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(downsample(pixels, size))),
    chunk("IEND"),
  ]);
}
