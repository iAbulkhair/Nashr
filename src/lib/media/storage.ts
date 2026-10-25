/**
 * The storage adapter seam (rules 2058-2063, `flows.md` section 85): where the bytes of our media copies live. The
 * store (src/lib/media/store.ts) keeps everything that decides what may be written and who may read it: the source
 * download through safeFetch, the magic-byte check, the JPEG conversion, the size cap, the quota guard and the
 * tenant index `mfile:{scope}:{name}` written with `sc(u)`'s scope. An adapter only keeps bytes under a name that passed
 * MEDIA_NAME; it never sees a scope, an email or a URL from a request.
 *
 * The default backend is the private folder on Hostinger's disk (src/lib/media/disk.ts, rules 1750-1763); an
 * S3-compatible bucket (src/lib/media/s3.ts, rules 3613-3617) is the second implementation, chosen in `storage()` below
 * only when `MEDIA_STORAGE=s3`. The future disk + Drive archive backend (draft PR #320, rules 991-1015)
 * is not built here; it would be a second implementation of this type.
 */
import type { Readable } from "node:stream";
import { diskStorage } from "./disk";
import { s3Storage, storageBackend } from "./s3";

export type StoredHead = { size: number; mtime: Date; contentType: "image/jpeg" | "video/mp4" };

/** What the founder console's store check reads from the backend (rule 1762). Never throws. */
export type StorageProbe = {
  status: "ok" | "error:no_store" | "error:write_failed" | "error:read_failed" | "error:del_failed";
  survivedBuilds: number | null;
  freeBytes: number | null;
};

/**
 * What the server asks a backend to sign (rule 3500): one object under a name the SERVER built (`newUploadName`, never a
 * name, path or scope from the request), the only content types the browser may send, the largest body, and how long
 * the grant lives. Provider-neutral on purpose: a bucket backend (Vercel Blob client tokens, S3 presigned PUT or POST)
 * turns it into its own grant; the limits are parameters, so a later upload kind (a workspace logo) passes its own.
 */
export type SignedUploadSpec = {
  name: string;
  contentTypes: readonly string[];
  maxBytes: number;
  expiresInS: number;
  /**
   * The size the browser declared, already checked against `maxBytes` (rule 3615). Optional and new: a backend that can
   * cap a body itself (an S3 POST policy's `content-length-range`) ignores it; one that can only pin an exact length (a
   * presigned PUT) signs it. The bytes are checked again by `takeUpload` whatever the backend.
   */
  size?: number;
};

/**
 * A grant the browser uses to send the bytes straight to the backend: `method` to `url` with `headers`, or for a form
 * POST (S3 POST policy) the `fields` first and the file last. `expiresAt` is ISO. Nothing in it is stored or logged.
 */
export type SignedUpload = { url: string; method: "PUT" | "POST"; headers: Record<string, string>; fields?: Record<string, string>; expiresAt: string };

export interface StorageAdapter {
  /** "disk" (the default) or "s3" (rule 3613). */
  readonly name: string;
  /**
   * Optional (rule 3500): a backend the browser can upload to directly signs one upload here. A backend without it (the
   * disk) is uploaded to through our own server route instead (`planUpload` in src/lib/upload.ts answers `server`).
   * Throws when it cannot sign; the caller then falls back to the server upload.
   */
  signedUpload?(spec: SignedUploadSpec): Promise<SignedUpload>;
  /** The backend can keep files on this deployment. */
  configured(): boolean;
  /** Keep checked bytes under a new name. Never overwrites: a name that exists fails. Throws on any failure. */
  put(name: string, body: Buffer): Promise<void>;
  /** The whole file, or null when there is none. */
  get(name: string): Promise<Buffer | null>;
  /** The bytes `start`..`end` (inclusive), or the whole file. Call after `head`. */
  stream(name: string, range?: { start: number; end: number }): Readable;
  /** Size, time and type of a file, or null when there is none (or the name is not one of ours). */
  head(name: string): Promise<StoredHead | null>;
  /** "missing" for a file already gone. Any other failure throws, so a caller that must not lose track can stop. */
  delete(name: string): Promise<"deleted" | "missing">;
  /** The served URL (`{origin}/m/{name}`): private, answered by the `/m/` route's member or share-link check. */
  url(name: string): string;
  /** Free space for new files, or Infinity when the backend cannot say. */
  freeBytes(): Promise<number>;
  /** Write, read back and delete a tiny file, and count the builds the store outlived (rule 1762). */
  probe(): Promise<StorageProbe>;
}

/**
 * The one place the media storage backend is chosen (rule 2058). Since rule 3613: `MEDIA_STORAGE=s3` picks the
 * S3-compatible bucket (src/lib/media/s3.ts); anything else, unset included, keeps the disk, so nothing changes until the
 * founder sets the bucket's variables. Read at call time, like every other variable.
 */
export function storage(): StorageAdapter {
  return storageBackend() === "s3" ? s3Storage : diskStorage;
}
