/**
 * The S3-compatible storage backend (rules 3613-3617): a second `StorageAdapter` (src/lib/media/storage.ts) for a bucket
 * at any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces). It is chosen
 * only when `MEDIA_STORAGE=s3`; the disk stays the default, so nothing changes until the founder sets the variables
 * (docs/system/variables.md). No SDK: requests are signed with AWS Signature Version 4 from src/lib/media/sigv4.ts.
 *
 *  - The endpoint, region, bucket and keys come from the environment only, never from a request; the endpoint must be a
 *    bare `https://` origin. Every request goes to `{endpoint}/{bucket}/{name}` (path-style, which every provider above
 *    accepts) and follows no redirect, so a request never leaves that host. No user-supplied URL is fetched here.
 *  - Object names are the store's own (`MEDIA_NAME`, made by the server); anything else is refused before a request.
 *  - `put` never overwrites (`If-None-Match: *`), as the disk's hard link never does.
 *  - Objects are private. They are served by our own `/m/` route (member or share-link check) and `/api/avatar/`,
 *    `/api/logo/` (signed links), which stream them through this adapter: there is no public bucket URL.
 *  - `signedUpload` (rule 3615) grants the browser one direct upload. Default: a presigned POST policy, because only a
 *    POST policy lets the bucket itself enforce the size cap (`content-length-range` 1..maxBytes), the exact key, the
 *    exact content type and the expiry. A presigned PUT cannot cap a size; it can only pin an exact `Content-Length`, so
 *    `S3_UPLOAD=put` (for a provider without POST policies, such as R2) signs the size the browser declared (already
 *    checked against the cap) together with the type. `S3_UPLOAD=off` turns direct upload off (the server upload is
 *    used). Whatever the grant, `takeUpload` reads the real bytes back from the bucket and checks them again.
 *  - Nothing here logs a key, a signature, a URL or an object name.
 */
import { Readable } from "node:stream";
import { MEDIA_NAME } from "../media-catalog";
import { mediaOrigin } from "./config";
import { amzDate, postPolicy, presignQuery, queryString, sha256Hex, signRequest, type SigV4Credentials } from "./sigv4";
import type { SignedUpload, SignedUploadSpec, StorageAdapter, StorageProbe, StoredHead } from "./storage";

export type S3Config = { origin: string; host: string; bucket: string; creds: SigV4Credentials; upload: "post" | "put" | "off" };

/** Which backend `storage()` uses: "s3" only for exactly `MEDIA_STORAGE=s3`; anything else is the disk. */
export const storageBackend = (env: NodeJS.ProcessEnv = process.env): "disk" | "s3" => ((env.MEDIA_STORAGE ?? "").trim().toLowerCase() === "s3" ? "s3" : "disk");

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;

/**
 * The bucket's settings from the environment, or null when any is missing or malformed (the adapter then reports itself
 * not configured and the store stays off, as an unset `MEDIA_DIR` does on the disk). Read at call time.
 */
export function s3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const v = (k: string) => (env[k] ?? "").trim();
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = [v("S3_ENDPOINT"), v("S3_REGION"), v("S3_BUCKET"), v("S3_ACCESS_KEY_ID"), v("S3_SECRET_ACCESS_KEY")];
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  // A bare https origin: no credentials, path, query or fragment that could steer a request elsewhere.
  if (u.protocol !== "https:" || u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
  if (!BUCKET.test(bucket) || !REGION.test(region)) return null;
  const mode = v("S3_UPLOAD").toLowerCase();
  const upload = mode === "put" ? "put" : mode === "off" ? "off" : "post";
  return { origin: u.origin, host: u.host, bucket, creds: { accessKeyId, secretAccessKey, region, service: "s3" }, upload };
}

const typeOf = (name: string): StoredHead["contentType"] => (name.endsWith(".mp4") ? "video/mp4" : "image/jpeg");

/** The signed headers of one request: host, date and the body's hash, plus the caller's. */
export function signedRequestHeaders(c: S3Config, method: string, path: string, extra: Record<string, string>, payloadHash: string, date = new Date()): Record<string, string> {
  const headers: Record<string, string> = { ...extra, host: c.host, "x-amz-date": amzDate(date), "x-amz-content-sha256": payloadHash };
  const { authorization } = signRequest({ method, path, headers, payloadHash, creds: c.creds, date });
  const out: Record<string, string> = { ...headers, authorization };
  // `fetch` sets Host itself from the URL (the same host that was signed).
  delete out.host;
  return out;
}

/** One signed request to `{origin}/{bucket}/{name}` (or the bucket itself). No redirect is followed. */
async function call(c: S3Config, method: string, name: string | null, opts: { headers?: Record<string, string>; body?: Buffer; timeoutMs?: number } = {}): Promise<Response> {
  if (name !== null && !MEDIA_NAME.test(name) && !PROBE_NAME.test(name)) throw new Error("storage_name_refused");
  const path = `/${c.bucket}${name ? `/${name}` : "/"}`;
  const hash = sha256Hex(opts.body ?? "");
  const headers = signedRequestHeaders(c, method, path, opts.headers ?? {}, hash);
  return fetch(`${c.origin}${path}`, { method, headers, body: opts.body ? new Uint8Array(opts.body) : undefined, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), cache: "no-store" });
}

/** The probe's object (rule 1762's check): its own shape, never one of the store's names. */
const PROBE_NAME = /^probe-[a-f0-9]{16}\.txt$/;

function need(): S3Config {
  const c = s3Config();
  if (!c) throw new Error("storage_not_configured");
  return c;
}

/**
 * Rule 3615: one direct browser upload, under the server's name and the policy's limits. Pure apart from the clock the
 * caller passes, so the test reads the limits back. Throws (the planner then falls back to the server upload) on a name
 * that is not the store's, more than one content type, a size over the cap, or direct upload switched off.
 */
export function signUpload(c: S3Config, spec: SignedUploadSpec, now = new Date()): SignedUpload {
  if (c.upload === "off") throw new Error("direct_upload_off");
  if (!MEDIA_NAME.test(spec.name)) throw new Error("storage_name_refused");
  if (spec.contentTypes.length !== 1 || !/^[a-z]+\/[a-z0-9.+-]+$/.test(spec.contentTypes[0])) throw new Error("one_content_type");
  if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1) throw new Error("bad_cap");
  // SigV4 grants live at most 7 days; ours are minutes. At least a minute, at most an hour.
  const ttl = Math.min(3600, Math.max(60, Math.floor(spec.expiresInS)));
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const contentType = spec.contentTypes[0];
  if (c.upload === "put") {
    // A presigned PUT cannot cap a body; it pins the exact length the browser declared (already checked against the cap).
    if (typeof spec.size !== "number" || !Number.isSafeInteger(spec.size) || spec.size < 1 || spec.size > spec.maxBytes) throw new Error("put_needs_size");
    const path = `/${c.bucket}/${spec.name}`;
    const q = presignQuery({ method: "PUT", path, host: c.host, extraHeaders: { "content-length": String(spec.size), "content-type": contentType }, creds: c.creds, date: now, expiresS: ttl });
    return { url: `${c.origin}${path}?${queryString(q)}`, method: "PUT", headers: { "content-type": contentType }, expiresAt: expiresAt.toISOString() };
  }
  const { fields } = postPolicy({ bucket: c.bucket, key: spec.name, contentType, maxBytes: spec.maxBytes, expiresAt, creds: c.creds, date: now });
  return { url: `${c.origin}/${c.bucket}`, method: "POST", headers: {}, fields, expiresAt: expiresAt.toISOString() };
}

export const s3Storage: StorageAdapter = {
  name: "s3",
  configured: () => s3Config() !== null,

  async signedUpload(spec) {
    return signUpload(need(), spec);
  },

  async put(name, body) {
    if (!MEDIA_NAME.test(name)) throw new Error("storage_put_refused");
    const res = await call(need(), "PUT", name, { body, headers: { "content-type": typeOf(name), "if-none-match": "*" }, timeoutMs: 120_000 });
    // 412: the name exists. Never overwritten, as on the disk.
    if (!res.ok) throw new Error(res.status === 412 ? "storage_exists" : `storage_put_${res.status}`);
  },

  async get(name) {
    if (!MEDIA_NAME.test(name)) return null;
    const res = await call(need(), "GET", name, { timeoutMs: 120_000 });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage_get_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },

  stream(name, range) {
    if (!MEDIA_NAME.test(name)) throw new Error("storage_stream_refused");
    const c = need();
    async function* body() {
      const res = await call(c, "GET", name, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, timeoutMs: 300_000 });
      if (!(res.ok || res.status === 206) || !res.body) throw new Error(`storage_stream_${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    }
    return Readable.from(body());
  },

  async head(name) {
    if (!MEDIA_NAME.test(name)) return null;
    const c = s3Config();
    if (!c) return null;
    const res = await call(c, "HEAD", name);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage_head_${res.status}`);
    const size = Number(res.headers.get("content-length"));
    const mtime = new Date(res.headers.get("last-modified") ?? 0);
    return { size: Number.isSafeInteger(size) ? size : 0, mtime: Number.isNaN(mtime.getTime()) ? new Date(0) : mtime, contentType: typeOf(name) };
  },

  async delete(name) {
    if (!MEDIA_NAME.test(name)) return "missing";
    const c = need();
    // S3 answers 204 for a key that never existed, so the HEAD first says which it was.
    const there = await s3Storage.head(name);
    if (!there) return "missing";
    const res = await call(c, "DELETE", name);
    if (res.status === 404) return "missing";
    if (!res.ok) throw new Error(`storage_delete_${res.status}`);
    return "deleted";
  },

  url: (name) => `${mediaOrigin()}/m/${name}`,

  /** A bucket has no free-space figure to read; the store's own ceilings (MEDIA_MAX_BYTES, MEDIA_MAX_FILES) still apply. */
  freeBytes: async () => Infinity,

  /** Write, read back and delete a tiny object. A bucket outlives every build, so there is no build count. Never throws. */
  async probe(): Promise<StorageProbe> {
    const out: StorageProbe = { status: "ok", survivedBuilds: null, freeBytes: null };
    const c = s3Config();
    if (!c) return { ...out, status: "error:no_store" };
    const name = `probe-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}.txt`;
    try {
      const w = await call(c, "PUT", name, { body: Buffer.from("ok"), headers: { "content-type": "text/plain" } });
      if (!w.ok) return { ...out, status: "error:write_failed" };
    } catch {
      return { ...out, status: "error:write_failed" };
    }
    let read = "";
    try {
      const r = await call(c, "GET", name);
      read = r.ok ? await r.text() : "";
    } catch {}
    try {
      const d = await call(c, "DELETE", name);
      if (!d.ok) return { ...out, status: "error:del_failed" };
    } catch {
      return { ...out, status: "error:del_failed" };
    }
    return read === "ok" ? out : { ...out, status: "error:read_failed" };
  },
};
