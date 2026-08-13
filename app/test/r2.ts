/**
 * In-memory R2 stand-in for route tests.
 *
 * `app/test/d1.ts` gives unit tests a real SQLite database rather than a mocked
 * query builder; this does the same job for the bucket, for the same reason. A
 * test that stubbed `getObject` would prove the route calls a function, not
 * that a photo's bytes reach a visitor with the right headers — and headers are
 * most of what the public image route is.
 *
 * Only the four members production code actually touches are implemented
 * (`get`, `put`, `delete`, and the `R2ObjectBody` surface both response helpers
 * read). Filling in the rest of the R2 API would be inventing behaviour nothing
 * exercises.
 */
import { env } from "./workers-env";

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface TestR2 {
  /** Install the bucket into the shared bindings object as `FILES`. */
  install(): void;
  put(key: string, bytes: Uint8Array, contentType: string): void;
  has(key: string): boolean;
  keys(): string[];
}

function objectBody(key: string, stored: StoredObject) {
  return {
    key,
    size: stored.bytes.byteLength,
    // A stable, content-independent etag is enough: nothing under test compares
    // two etags, and a fake hash would imply a guarantee this does not make.
    httpEtag: `"${key.length}-${stored.bytes.byteLength}"`,
    httpMetadata: { contentType: stored.contentType },
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", stored.contentType);
    },
    get body() {
      return new Blob([stored.bytes as BlobPart]).stream();
    },
  };
}

export function createTestR2(): TestR2 {
  const objects = new Map<string, StoredObject>();

  const binding = {
    async get(key: string) {
      const stored = objects.get(key);
      return stored ? objectBody(key, stored) : null;
    },
    async put(key: string, body: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };

  return {
    install() {
      env.FILES = binding;
    },
    put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
    },
    has(key) {
      return objects.has(key);
    },
    keys() {
      return [...objects.keys()].sort();
    },
  };
}
