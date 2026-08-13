import { describe, expect, it } from "vitest";

import { SIGNATURE_MISMATCH, validateUploadSignature } from "./upload-signatures";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

const validSamples: Array<[string, Uint8Array]> = [
  ["image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
  ["image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  ["image/webp", text("RIFF0000WEBP")],
  ["image/avif", bytes(0, 0, 0, 24, ...text("ftypavif").values())],
  ["application/pdf", text("\n%PDF-1.7\n")],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes(0x50, 0x4b, 0x03, 0x04),
  ],
  [
    "application/vnd.ms-powerpoint",
    bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
  ],
  ["text/plain", text("Speaker notes\nwith two lines.")],
  ["text/markdown", text("# Session notes\n\n- one\n- two\n")],
];

describe("validateUploadSignature — must NOT fire", () => {
  it.each(validSamples)("accepts bytes matching %s", (contentType, sample) => {
    expect(validateUploadSignature({ contentType, bytes: sample })).toBeNull();
  });

  it("normalizes MIME case and parameters", () => {
    expect(
      validateUploadSignature({
        contentType: "IMAGE/PNG; charset=binary",
        bytes: validSamples[1][1],
      }),
    ).toBeNull();
  });

  it("accepts a PDF header within the first 1024 bytes", () => {
    expect(
      validateUploadSignature({
        contentType: "application/pdf",
        bytes: text(`${" ".repeat(40)}%PDF-1.4`),
      }),
    ).toBeNull();
  });
});

describe("validateUploadSignature — must fire", () => {
  it("rejects a renamed executable claiming to be a PNG", () => {
    expect(
      validateUploadSignature({
        contentType: "image/png",
        bytes: bytes(0x4d, 0x5a, 0x90, 0x00),
      }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects valid bytes claimed as a different allowed type", () => {
    expect(
      validateUploadSignature({ contentType: "image/jpeg", bytes: validSamples[1][1] }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects a generic ZIP claiming to be a legacy PowerPoint", () => {
    expect(
      validateUploadSignature({
        contentType: "application/vnd.ms-powerpoint",
        bytes: bytes(0x50, 0x4b, 0x03, 0x04),
      }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects binary data claiming to be plain text", () => {
    expect(
      validateUploadSignature({ contentType: "text/plain", bytes: bytes(0x41, 0x00, 0x42) }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects invalid UTF-8 claiming to be Markdown", () => {
    expect(
      validateUploadSignature({ contentType: "text/markdown", bytes: bytes(0xc3, 0x28) }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects an AVIF claim without an AVIF-compatible brand", () => {
    expect(
      validateUploadSignature({ contentType: "image/avif", bytes: text("0000ftypheic") }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("fails closed for a type without a signature rule", () => {
    expect(
      validateUploadSignature({ contentType: "application/octet-stream", bytes: text("hello") }),
    ).toBe(SIGNATURE_MISMATCH);
  });

  it("rejects an empty prefix", () => {
    expect(
      validateUploadSignature({ contentType: "image/png", bytes: new Uint8Array() }),
    ).toBe(SIGNATURE_MISMATCH);
  });
});
