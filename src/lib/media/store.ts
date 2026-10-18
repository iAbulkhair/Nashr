/**
 * Our own copy of every provider result (spec 4.6), on Hostinger's disk (rules 1750-1763). kie and Higgsfield delete
 * results after 1 to 14 days, while Instagram and Facebook fetch a post's image by URL whenever the owner publishes, so a
 * post must point at a file we keep.
 *
 * Private by default (rule 1754): `/m/{name}` serves a file only to a signed-in member of the workspace whose index
 * holds it, or to a holder of a short signed link minted at the moment we hand the file to Meta, a provider or Composio
 * (`share.ts`). The name is 128 random bits and carries no tenant identifier; the index is `mfile:{scope}:{name}`, written
 * with the job's own scope.
 *
 * The source URL is provider output, so it is untrusted: downloaded only through safeFetch over https on every redirect
 * hop, capped while it streams, and judged by its magic bytes, never by its Content-Type. Every error is a StoreError
 * with a fixed code.
 *
 * The bytes themselves go through the storage adapter (`storage()`, src/lib/media/storage.ts, rule 2058); everything
 * that decides what may be written and who may read it stays here.
 */
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { db } from "../db";
import { pmap } from "../parallel";
import { safeFetch } from "../safe-fetch";
import { MEDIA_NAME, isOurMediaUrl, ourMediaName, type MediaKind } from "../media-catalog";
import { storeConfigured, storeLimits } from "./config";
import { abortAfter, budget } from "./keys";
import { storage } from "./storage";
import { StoreError, type StoredMedia } from "./types";
import { log } from "../log";

export const SOURCE_CAP_BYTES: Record<MediaKind, number> = { image: 25 * 1024 * 1024, video: 100 * 1024 * 1024 };
export const DOWNLOAD_MAX_MS: Record<MediaKind, number> = { image: 15_000, video: 45_000 };
export const PUT_MAX_MS: Record<MediaKind, number> = { image: 20_000, video: 30_000 };
/** Kept free after the download for the JPEG conversion and the upload. */
const AFTER_DOWNLOAD_MS = 10_000;
/** A step with less time than this would only start work the deadline then cuts off. */
const MIN_STEP_MS = 3_000;

/** What the bytes are, from their magic numbers. MP4 is any ISO media file (`ftyp` at offset 4). */
export function sniff(b: Uint8Array): "jpeg" | "png" | "webp" | "gif" | "mp4" | null {
  const at = (o: number, s: string) => b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && at(1, "PNG")) return "png";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(0, "GIF8")) return "gif";
  if (at(4, "ftyp")) return "mp4";
  return null;
}

/**
 * Any image to one upright JPEG no larger than 1440×1920. Transparency becomes white (JPEG has no alpha, and sharp would
 * otherwise flatten to black). sharp's failure level stays at its default, "warning": the strictest one, and the one its
 * typings recommend for untrusted input. Do not set it to "error", which sounds stricter and is not.
 */
export async function toJpeg(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: 1440, height: 1920, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new StoreError("convert_failed");
  }
}

/**
 * The body, read with a running total so a file with no or a false Content-Length still stops at the cap. Exported for
 * the one-time move of old Blob copies (scripts/media-blob-move.ts, rule 1763), which must read through the same checks.
 */
export async function download(url: string, kind: MediaKind, ms: number, cap = SOURCE_CAP_BYTES[kind]): Promise<Buffer> {
  let res: Response;
  try {
    // https on every hop, not only the first: a redirect to http would let anyone on that leg swap the file.
    res = await safeFetch(url, { signal: abortAfter(ms) }, { httpsOnly: true });
  } catch {
    throw new StoreError("fetch_failed");
  }
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => {});
    throw new StoreError("fetch_failed");
  }
  if (Number(res.headers.get("content-length")) > cap) {
    res.body.cancel().catch(() => {});
    throw new StoreError("too_large");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        reader.cancel().catch(() => {});
        throw new StoreError("too_large");
      }
      chunks.push(value);
    }
  } catch (e) {
    throw e instanceof StoreError ? e : new StoreError("fetch_failed");
  }
  return Buffer.concat(chunks, total);
}

/**
 * One file's index entry (rule 1752). `taskId` and `kind` say what it is; no prompt, title or URL. A file in the
 * workspace's library (rule 1781: imported from a cloud drive or uploaded from the device) has an empty `taskId` and
 * says where it came from in `source`. Expand step (rule 679): an entry without `source` is a task's file, as before.
 */
export type LibrarySource = "upload" | "google_drive" | "dropbox" | "onedrive";
export type MediaEntry = { taskId: string; kind: MediaKind; bytes: number; at: string; source?: LibrarySource };
export type MediaOwner = { scope: string; taskId: string; source?: LibrarySource };
export const MEDIA_KEYS = {
  /** One file of one workspace: what `/m/{name}` checks for a signed-in member. */
  entry: (scope: string, name: string) => `mfile:${scope}:${name}`,
  /** Every name the workspace owns, for account deletion. */
  names: (scope: string) => `mfiles:${scope}`,
  /** The whole store, for the quota guard (rule 1753). Never per tenant. */
  bytes: () => "mfiles:bytes",
  count: () => "mfiles:count",
};

/** The disk backend's path for a name (tests and the one-time Blob move read it). */
export { mediaPath } from "./disk";
/** Kept free on the disk whatever our own counters say: the last guard if hPanel's quota is smaller than configured. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** The share of each ceiling the store may fill before it refuses new renders (rule 1753). */
export const FULL_AT = 0.95;

/**
 * Rule 1753: room for one more file of `kind` at its largest. Read before a render is charged (MediaDeps.storeReady)
 * and again just before the write. One `mget` for both counters.
 */
export async function storeHasRoom(kind: MediaKind, extraBytes = SOURCE_CAP_BYTES[kind]): Promise<boolean> {
  if (!storeConfigured()) return false;
  const lim = storeLimits();
  const [bytes, count] = (await db.mget<number>([MEDIA_KEYS.bytes(), MEDIA_KEYS.count()])).map((v) => Math.max(0, Number(v) || 0));
  return bytes + Math.min(extraBytes, lim.maxFileBytes) <= lim.maxBytes * FULL_AT && count + 1 <= lim.maxFiles * FULL_AT;
}
export const storeReady = (kind: MediaKind) => storeHasRoom(kind);

/**
 * Download a provider result (untrusted URL) and keep our own copy under the job's scope and task. Throws StoreError
 * with a fixed code. Write order (rule 1752): the index first, then the bytes through the adapter, which never
 * overwrites (disk: `.tmp/{name}.part` created with `wx` and flushed, then a hard link to the final name); a crash leaves
 * an index entry with no file (served as a 404), never a file nobody can find to delete.
 */
export async function copyToStore(sourceUrl: string, kind: MediaKind, deadline: number, owner: { scope: string; taskId: string }): Promise<StoredMedia> {
  if (!storeConfigured()) throw new StoreError("no_store");
  if (!URL.canParse(sourceUrl) || new URL(sourceUrl).protocol !== "https:") throw new StoreError("not_https");
  const dl = budget(DOWNLOAD_MAX_MS[kind], deadline - AFTER_DOWNLOAD_MS);
  if (dl < MIN_STEP_MS) throw new StoreError("no_time");
  const raw = await download(sourceUrl, kind, dl);

  const format = sniff(raw);
  if (kind === "image" ? !format || format === "mp4" : format !== "mp4") throw new StoreError("not_media");
  const body = kind === "image" ? await toJpeg(raw) : raw;
  if (budget(PUT_MAX_MS[kind], deadline) < MIN_STEP_MS) throw new StoreError("no_time");
  return writeToStore(body, kind, owner);
}

/**
 * Keep bytes that are already checked (a JPEG from toJpeg, or MP4 bytes that sniffed as MP4) under the owner's scope
 * and task. Every writer of the store goes through here, so the size cap, the quota guard and the write order (rule
 * 1752) hold for all of them.
 */
export async function writeToStore(body: Buffer, kind: MediaKind, owner: MediaOwner): Promise<StoredMedia> {
  const st = storage();
  if (!st.configured()) throw new StoreError("no_store");
  const contentType = kind === "image" ? "image/jpeg" : "video/mp4";
  // Rule 2059: the cap, the quota and the free-space guard run before the adapter is asked to keep anything.
  if (body.length > storeLimits().maxFileBytes) throw new StoreError("too_large");
  if (!(await storeHasRoom(kind, body.length)) || (await st.freeBytes()) - body.length < MIN_FREE_BYTES) throw new StoreError("full");

  const name = `${randomBytes(16).toString("hex")}.${kind === "image" ? "jpg" : "mp4"}`;
  const entry: MediaEntry = { taskId: owner.taskId, kind, bytes: body.length, at: new Date().toISOString(), ...(owner.source ? { source: owner.source } : {}) };
  await Promise.all([db.set(MEDIA_KEYS.entry(owner.scope, name), entry), db.sadd(MEDIA_KEYS.names(owner.scope), name)]);
  try {
    await st.put(name, body);
  } catch {
    await Promise.all([
      db.del(MEDIA_KEYS.entry(owner.scope, name)).catch(() => {}),
      db.srem(MEDIA_KEYS.names(owner.scope), name).catch(() => {}),
    ]);
    throw new StoreError("put_failed");
  }
  await Promise.all([db.incrby(MEDIA_KEYS.bytes(), body.length), db.incrby(MEDIA_KEYS.count(), 1)]);
  const url = st.url(name);
  if (!isOurMediaUrl(url)) throw new StoreError("put_failed");
  return { url, bytes: body.length, contentType };
}

/** The index entry of `name` in this workspace, or null: the one check before a file is handed on (rule 1782). */
export async function mediaEntryOf(scope: string, url: string | undefined): Promise<(MediaEntry & { name: string }) | null> {
  const name = ourMediaName(url);
  if (!name) return null;
  const e = await db.get<MediaEntry>(MEDIA_KEYS.entry(scope, name));
  return e ? { ...e, name } : null;
}

/** How many files one workspace's library may hold (rule 1781), whatever the store's room. */
export const LIBRARY_MAX = 300;
export type LibraryItem = { name: string; url: string; kind: MediaKind; bytes: number; at: string; source: LibrarySource };

/** The workspace's library, newest first: its index entries with no task. Two calls, whatever its size. */
export async function listLibrary(scope: string): Promise<LibraryItem[]> {
  const names = (await db.smembers(MEDIA_KEYS.names(scope))).filter((n) => MEDIA_NAME.test(n));
  if (!names.length) return [];
  const entries = await db.mget<MediaEntry>(names.map((n) => MEDIA_KEYS.entry(scope, n)));
  const st = storage();
  return names
    .map((name, i) => ({ name, e: entries[i] }))
    .filter((x): x is { name: string; e: MediaEntry } => !!x.e && !x.e.taskId && !!x.e.source)
    .map(({ name, e }) => ({ name, url: st.url(name), kind: e.kind, bytes: e.bytes, at: e.at, source: e.source! }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Delete one library file of this workspace (rule 1784): only an entry with no task, so a post's image is never pulled
 * from under it. The index goes first, so a failed unlink leaves a file nobody is served, never a served file with no
 * index. Returns false when the workspace has no such library file.
 */
export async function deleteLibraryFile(scope: string, name: string): Promise<boolean> {
  if (!MEDIA_NAME.test(name)) return false;
  const e = await db.get<MediaEntry>(MEDIA_KEYS.entry(scope, name));
  if (!e || e.taskId || !e.source) return false;
  await Promise.all([db.del(MEDIA_KEYS.entry(scope, name)), db.srem(MEDIA_KEYS.names(scope), name)]);
  await storage().delete(name).catch(() => "missing");
  await Promise.all([db.incrby(MEDIA_KEYS.bytes(), -(Number(e.bytes) || 0)), db.incrby(MEDIA_KEYS.count(), -1)]);
  return true;
}

/**
 * Rule 1761: account deletion removes every file of every scope it names, with their index, and gives the space back to
 * the counters. Returns the index keys for the caller's own deletion pass. A missing file is already gone; any other
 * disk error stops the wipe (the caller retries), so an account is never reported deleted while its files remain. With
 * no store configured there is nothing on this deployment's disk to remove.
 */
export async function forgetScopeMedia(scopes: readonly string[]): Promise<string[]> {
  const perScope = await pmap(scopes, (s) => db.smembers(MEDIA_KEYS.names(s)));
  const files = scopes.flatMap((s, i) => perScope[i].filter((n) => MEDIA_NAME.test(n)).map((name) => ({ s, name })));
  const keys = [...scopes.map((s) => MEDIA_KEYS.names(s)), ...scopes.flatMap((s, i) => perScope[i].map((n) => MEDIA_KEYS.entry(s, n)))];
  if (!files.length) return keys;
  const entries = await db.mget<MediaEntry>(files.map((f) => MEDIA_KEYS.entry(f.s, f.name)));
  const st = storage();
  if (st.configured()) {
    await pmap(files, async (f) => {
      try {
        await st.delete(f.name);
      } catch {
        throw new Error("account wipe: a media file could not be deleted, try again");
      }
    }, 8);
  } else {
    // Count only: no scope or name in a log.
    log.error("account wipe: media index without a store", { files: files.length });
  }
  const bytes = entries.reduce((n, e) => n + (e && Number.isFinite(e.bytes) ? e.bytes : 0), 0);
  const count = entries.filter(Boolean).length;
  await Promise.all([bytes ? db.incrby(MEDIA_KEYS.bytes(), -bytes) : null, count ? db.incrby(MEDIA_KEYS.count(), -count) : null]);
  return keys;
}

export type StoreProbe = {
  status: "ok" | "error:no_store" | "error:write_failed" | "error:read_failed" | "error:del_failed";
  /** How many distinct builds the store has outlived (the sentinel, rule 1762); null before the first probe. */
  survivedBuilds: number | null;
  usage: { bytes: number; files: number };
  limits: { maxBytes: number; maxFiles: number; maxFileBytes: number };
  freeBytes: number | null;
};

/**
 * Founder console only (rule 1762): the adapter's write, read-back and delete check with its build sentinel
 * (`StorageAdapter.probe`), and the store's totals. Usage figures are the store's totals: no scope, name or tenant
 * data. Never throws.
 */
export async function probeStore(): Promise<StoreProbe> {
  const limits = storeLimits();
  const [bytes, files] = (await db.mget<number>([MEDIA_KEYS.bytes(), MEDIA_KEYS.count()]).catch(() => [0, 0])).map((v) => Math.max(0, Number(v) || 0));
  const r = await storage().probe();
  return { status: r.status, survivedBuilds: r.survivedBuilds, usage: { bytes, files }, limits, freeBytes: r.freeBytes };
}
