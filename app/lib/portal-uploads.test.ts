import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_DOC_TYPES,
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  OWNER_UPLOAD_QUOTA,
  UPLOADER_EVENT_UPLOAD_QUOTA,
  formatBytes,
  validateUpload,
  validateUploadQuota,
} from "./portal-uploads";

const ok = {
  size: 1024,
  contentType: "image/png",
  purpose: "headshot" as const,
  filename: "me.png",
};

describe("validateUpload — must fire", () => {
  it("rejects an empty filename", () => {
    expect(validateUpload({ ...ok, filename: "   " })).toBe("Choose a file first.");
  });

  it("rejects a zero-byte file", () => {
    expect(validateUpload({ ...ok, size: 0 })).toBe("That file is empty.");
  });

  it("rejects a file over the cap and says how big it was", () => {
    const message = validateUpload({ ...ok, size: MAX_UPLOAD_BYTES + 1 });
    expect(message).toContain("25 MB");
    expect(message).toContain("25.0 MB");
  });

  it("rejects a PDF as a headshot", () => {
    expect(validateUpload({ ...ok, contentType: "application/pdf", filename: "cv.pdf" })).toContain(
      "not accepted here",
    );
  });

  it("rejects an executable everywhere", () => {
    for (const purpose of ["headshot", "slides", "document", "other"] as const) {
      expect(
        validateUpload({ size: 10, contentType: "application/x-msdownload", purpose, filename: "x.exe" }),
        purpose,
      ).toContain("not accepted");
    }
  });

  it("rejects an svg headshot (SVG is a script container)", () => {
    expect(
      validateUpload({ ...ok, contentType: "image/svg+xml", filename: "me.svg" }),
    ).toContain("not accepted");
  });
});

describe("validateUpload — must NOT fire", () => {
  it("accepts every allowed image type as a headshot", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(validateUpload({ ...ok, contentType: type }), type).toBeNull();
    }
  });

  it("accepts every allowed document type as slides", () => {
    for (const type of ALLOWED_DOC_TYPES) {
      expect(
        validateUpload({ size: 10, contentType: type, purpose: "slides", filename: "deck" }),
        type,
      ).toBeNull();
    }
  });

  it("accepts a file EXACTLY at the cap (off-by-one guard)", () => {
    expect(validateUpload({ ...ok, size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  it("accepts a content type carrying a charset parameter", () => {
    expect(validateUpload({ ...ok, contentType: "image/png; charset=binary" })).toBeNull();
  });

  it("accepts an upper-case content type", () => {
    expect(validateUpload({ ...ok, contentType: "IMAGE/PNG" })).toBeNull();
  });

  it("accepts an image as slides (a photographed whiteboard is legitimate)", () => {
    expect(
      validateUpload({ size: 10, contentType: "image/jpeg", purpose: "slides", filename: "b.jpg" }),
    ).toBeNull();
  });
});

describe("validateUploadQuota — must fire", () => {
  it("rejects the next file once the owner file count is full", () => {
    expect(
      validateUploadQuota({
        existingFiles: OWNER_UPLOAD_QUOTA.maxFiles,
        existingBytes: 0,
        incomingBytes: 1,
        ...OWNER_UPLOAD_QUOTA,
        scopeLabel: "session",
      }),
    ).toContain("Upload limit reached for this session");
  });

  it("rejects one byte beyond the uploader's event storage cap", () => {
    expect(
      validateUploadQuota({
        existingFiles: 0,
        existingBytes: UPLOADER_EVENT_UPLOAD_QUOTA.maxBytes,
        incomingBytes: 1,
        ...UPLOADER_EVENT_UPLOAD_QUOTA,
        scopeLabel: "event",
      }),
    ).toContain("Storage limit reached for this event");
  });
});

describe("validateUploadQuota — must NOT fire", () => {
  it("allows the last file below the count cap", () => {
    expect(
      validateUploadQuota({
        existingFiles: OWNER_UPLOAD_QUOTA.maxFiles - 1,
        existingBytes: 0,
        incomingBytes: 1,
        ...OWNER_UPLOAD_QUOTA,
        scopeLabel: "session",
      }),
    ).toBeNull();
  });

  it("allows an upload that lands exactly on the byte cap", () => {
    expect(
      validateUploadQuota({
        existingFiles: 0,
        existingBytes: UPLOADER_EVENT_UPLOAD_QUOTA.maxBytes - 1,
        incomingBytes: 1,
        ...UPLOADER_EVENT_UPLOAD_QUOTA,
        scopeLabel: "event",
      }),
    ).toBeNull();
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

/**
 * Drift guard. `app/lib/r2.server.ts` (WS0's file) declares the same policy
 * constants and cannot be imported here — it pulls in `cloudflare:workers`.
 * Reading it as TEXT is a check that can actually fail if the two drift.
 */
describe("policy constants stay in step with r2.server.ts", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./r2.server.ts", import.meta.url)),
    "utf8",
  );

  it("finds the r2.server.ts source (control — a missing file must not pass silently)", () => {
    expect(source).toContain("MAX_UPLOAD_BYTES");
    expect(source).toContain("ALLOWED_IMAGE_TYPES");
  });

  it("agrees on MAX_UPLOAD_BYTES", () => {
    const match = /export const MAX_UPLOAD_BYTES = ([^;]+);/.exec(source);
    expect(match).not.toBeNull();
    // eslint-disable-next-line no-eval
    expect(eval(match![1])).toBe(MAX_UPLOAD_BYTES);
  });

  it("agrees on the image type list", () => {
    const match = /export const ALLOWED_IMAGE_TYPES = (\[[^\]]*\])/.exec(source);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1].replace(/'/g, '"'))).toEqual(ALLOWED_IMAGE_TYPES);
  });

  it("agrees on the document type list", () => {
    const match = /export const ALLOWED_DOC_TYPES = (\[[\s\S]*?\])/.exec(source);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1].replace(/,(\s*\])/g, "$1").replace(/'/g, '"'));
    expect(parsed).toEqual(ALLOWED_DOC_TYPES);
  });
});
