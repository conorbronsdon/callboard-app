/**
 * Content-signature checks for the upload allowlist.
 *
 * `File.type` is supplied by the client and is only a claim. These checks run
 * after size/MIME policy validation and before an R2 write, so a renamed
 * executable cannot be stored and served as an allowed image or document.
 *
 * This module is deliberately pure and dependency-free. It recognizes only
 * the media types in `portal-uploads.ts`; expanding that allowlist requires an
 * explicit signature rule and tests here.
 */

export const SIGNATURE_MISMATCH =
  "The file contents do not match the selected file type. Choose the original file and try again.";

type SignatureRule = (bytes: Uint8Array) => boolean;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function containsAscii(bytes: Uint8Array, value: string, limit = bytes.length): boolean {
  const end = Math.min(bytes.length, limit) - value.length;
  for (let offset = 0; offset <= end; offset += 1) {
    if (asciiAt(bytes, offset, value)) return true;
  }
  return false;
}

const isJpeg: SignatureRule = (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]);
const isPng: SignatureRule = (bytes) =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isWebp: SignatureRule = (bytes) =>
  asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
const isAvif: SignatureRule = (bytes) =>
  asciiAt(bytes, 4, "ftyp") &&
  (containsAscii(bytes, "avif", 64) || containsAscii(bytes, "avis", 64));
const isPdf: SignatureRule = (bytes) => containsAscii(bytes, "%PDF-", 1024);
const isZip: SignatureRule = (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
const isCompoundFile: SignatureRule = (bytes) =>
  startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const ALLOWED_TEXT_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d]);

const isUtf8Text: SignatureRule = (bytes) => {
  for (const byte of bytes) {
    if (byte === 0x00) return false;
    if (byte < 0x20 && !ALLOWED_TEXT_CONTROL_BYTES.has(byte)) return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const SIGNATURE_RULES: Readonly<Record<string, SignatureRule>> = {
  "image/jpeg": isJpeg,
  "image/png": isPng,
  "image/webp": isWebp,
  "image/avif": isAvif,
  "application/pdf": isPdf,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": isZip,
  "application/vnd.ms-powerpoint": isCompoundFile,
  "text/plain": isUtf8Text,
  "text/markdown": isUtf8Text,
};

/**
 * Returns a human-facing error or null when the bytes match the claimed type.
 * The caller passes at most the first 8 KiB; every supported signature lives
 * inside that prefix.
 */
export function validateUploadSignature(input: {
  contentType: string;
  bytes: Uint8Array;
}): string | null {
  const type = input.contentType.split(";")[0].trim().toLowerCase();
  const rule = SIGNATURE_RULES[type];

  // Metadata validation owns the allowlist. Fail closed here if a future caller
  // forgets it or expands the list without adding a signature rule.
  if (!rule || !rule(input.bytes)) return SIGNATURE_MISMATCH;
  return null;
}
