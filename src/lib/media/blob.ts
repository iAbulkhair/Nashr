/**
 * Our own copy of every provider result (spec 4.6). kie and Higgsfield delete results after 1 to 14 days, while Instagram
 * and Facebook fetch a post's image by URL whenever the owner publishes, so a post must point at a file we keep. The
 * store is public (Meta fetches without credentials); the path is 128 random bits and carries no tenant identifier.
 *
 * The source URL is provider output, so it is untrusted: downloaded only through safeFetch over https on every redirect
 * hop, capped while it streams, and judged by its magic bytes, never by its Content-Type. Every error is a StoreError
 * with a fixed code.
 */
import { randomBytes } from "crypto";
import { del, put } from "@vercel/blob";
import sharp from "sharp";
import { safeFetch } from "../safe-fetch";
import { isOurBlobUrl, type MediaKind } from "../media-catalog";
import { blobConfigured } from "./config";
import { abortAfter, budget } from "./keys";
import { StoreError, type StoredMedia } from "./types";

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

/** The body, read with a running total so a file with no or a false Content-Length still stops at the cap. */
async function download(url: string, kind: MediaKind, ms: number): Promise<Buffer> {
  const cap = SOURCE_CAP_BYTES[kind];
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

/** Download a provider result (untrusted URL) and keep our own copy. Throws StoreError with a fixed code. */
export async function copyToBlob(sourceUrl: string, kind: MediaKind, deadline: number): Promise<StoredMedia> {
  if (!blobConfigured()) throw new StoreError("no_blob");
  if (!URL.canParse(sourceUrl) || new URL(sourceUrl).protocol !== "https:") throw new StoreError("not_https");
  const dl = budget(DOWNLOAD_MAX_MS[kind], deadline - AFTER_DOWNLOAD_MS);
  if (dl < MIN_STEP_MS) throw new StoreError("no_time");
  const raw = await download(sourceUrl, kind, dl);

  const format = sniff(raw);
  if (kind === "image" ? !format || format === "mp4" : format !== "mp4") throw new StoreError("not_media");
  const body = kind === "image" ? await toJpeg(raw) : raw;
  const contentType = kind === "image" ? "image/jpeg" : "video/mp4";

  const up = budget(PUT_MAX_MS[kind], deadline);
  if (up < MIN_STEP_MS) throw new StoreError("no_time");
  let url: string;
  try {
    ({ url } = await put(`media/${randomBytes(16).toString("hex")}.${kind === "image" ? "jpg" : "mp4"}`, body, {
      access: "public",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31536000,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      abortSignal: abortAfter(up),
    }));
  } catch {
    throw new StoreError("put_failed");
  }
  // A private store, or a token for some other service, answers with a URL providers and Meta cannot fetch.
  if (!isOurBlobUrl(url)) throw new StoreError("put_failed");
  return { url, bytes: body.length, contentType };
}

/** Founder console only: write, check and delete a tiny public file. Never throws. */
export async function probeBlob(signal: AbortSignal): Promise<"ok" | "error:no_blob" | "error:put_failed" | "error:foreign_host" | "error:del_failed"> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return "error:no_blob";
  let url: string;
  try {
    ({ url } = await put(`media/check-${randomBytes(8).toString("hex")}.txt`, "ok", { access: "public", contentType: "text/plain", addRandomSuffix: false, token, abortSignal: signal }));
  } catch {
    return "error:put_failed";
  }
  const ours = isOurBlobUrl(url);
  // Deleted even when the host is wrong: the file was written, and the probe leaves nothing behind.
  try {
    await del(url, { token, abortSignal: signal });
  } catch {
    return ours ? "error:del_failed" : "error:foreign_host";
  }
  return ours ? "ok" : "error:foreign_host";
}
