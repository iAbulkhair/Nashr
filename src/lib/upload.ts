/**
 * Uploads from the browser (rules 3500-3501): one generic planner for every upload kind (a person's picture, and since
 * rule 3611 a workspace logo). Ideas from Supastarter's signed upload URL (packages/storage), built the
 * Thakeen way:
 *
 *  - the caller is authenticated before anything here runs; `owner` is built by the route from the session
 *    (`p:{pid}` for a person, `w:{aid}` from the session's account for a workspace logo), never from the request;
 *  - the object name is generated here (`newUploadName`, 128 random bits, MEDIA_NAME shape): a name, path or scope
 *    from the request never reaches the storage backend;
 *  - the content type and the size are checked against the kind's policy BEFORE a grant is made, and again on the bytes
 *    (magic numbers, not the declared type) when the upload is taken;
 *  - a backend that can sign (`StorageAdapter.signedUpload`, e.g. a bucket) gets the policy's limits as parameters and the
 *    browser sends the bytes straight to it; the server records a ticket (`upload:{owner}:{name}`, 15 minutes) and the
 *    completion finds it only under the caller's own owner. A backend that cannot sign (the disk, the default) or a
 *    signing that fails answers `server`: the browser sends the bytes to our own route, under the same limits.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { globalKey } from "./keys";
import { log } from "./log";
import { MEDIA_NAME } from "./media-catalog";
import { sniff } from "./media/store";
import { storage, type StorageAdapter } from "./media/storage";

/** What one upload kind accepts. `formats` are the magic-number formats the bytes must sniff as. */
export type UploadPolicy = {
  kind: string;
  contentTypes: readonly string[];
  formats: readonly ("jpeg" | "png" | "webp")[];
  maxBytes: number;
  /** How long a signed grant lives. */
  ttlS: number;
};

/** Rule 3502: a profile picture. Image only (JPEG, PNG, WebP), 5 MB before it is resized. */
export const AVATAR_UPLOAD: UploadPolicy = { kind: "avatar", contentTypes: ["image/jpeg", "image/png", "image/webp"], formats: ["jpeg", "png", "webp"], maxBytes: 5 * 1024 * 1024, ttlS: 900 };
/**
 * Rule 3611: a workspace logo. The same image types and cap as a picture, but a kind of its own ("logo"): a ticket is
 * taken only by the policy of its kind (`takeUpload`), and under the account's own owner `w:{aid}`, never a person's.
 */
export const LOGO_UPLOAD: UploadPolicy = { kind: "logo", contentTypes: ["image/jpeg", "image/png", "image/webp"], formats: ["jpeg", "png", "webp"], maxBytes: 5 * 1024 * 1024, ttlS: 900 };

export type UploadTicket = { kind: string; contentTypes: readonly string[]; maxBytes: number; at: string };
export type UploadPlan =
  | { mode: "signed"; name: string; url: string; method: "PUT" | "POST"; headers: Record<string, string>; fields?: Record<string, string>; expiresAt: string; maxBytes: number }
  | { mode: "server"; maxBytes: number; contentTypes: readonly string[] };
export type UploadRefusal = "bad_type" | "too_large" | "bad_input";

/** A server-made object name: 128 random bits in the store's name shape, so every adapter accepts it. */
export const newUploadName = (): string => `${randomBytes(16).toString("hex")}.jpg`;

/** The declared type and size against the policy: null when they pass, else the refusal. */
export function checkDeclared(policy: UploadPolicy, contentType: unknown, size: unknown): UploadRefusal | null {
  if (typeof contentType !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return "bad_input";
  if (!policy.contentTypes.includes(contentType.toLowerCase())) return "bad_type";
  if (size > policy.maxBytes) return "too_large";
  return null;
}

/** The bytes themselves against the policy: their size and their magic numbers, never a declared type. */
export function checkBytes(policy: UploadPolicy, body: Uint8Array): UploadRefusal | null {
  if (!body.length) return "bad_input";
  if (body.length > policy.maxBytes) return "too_large";
  const f = sniff(body);
  return f && (policy.formats as readonly string[]).includes(f) ? null : "bad_type";
}

/**
 * Rule 3501: plan one upload for an authenticated caller. `owner` is the route's, from the session. A signed grant when
 * the backend can sign, else (or when signing fails) the server upload. Never throws for a refused input.
 */
export async function planUpload(owner: string, policy: UploadPolicy, input: { contentType: unknown; size: unknown }, st: StorageAdapter = storage()): Promise<{ ok: true; plan: UploadPlan } | { ok: false; error: UploadRefusal }> {
  const refused = checkDeclared(policy, input.contentType, input.size);
  if (refused) return { ok: false, error: refused };
  const server = { ok: true as const, plan: { mode: "server" as const, maxBytes: policy.maxBytes, contentTypes: policy.contentTypes } };
  if (!st.signedUpload || !st.configured()) return server;
  const name = newUploadName();
  try {
    // `size` (rule 3615): the declared size, already checked against the cap, for a backend that can only pin an exact
    // length (a presigned PUT); a POST policy enforces `maxBytes` itself. The bytes are checked again when taken.
    const grant = await st.signedUpload({ name, contentTypes: [String(input.contentType).toLowerCase()], maxBytes: policy.maxBytes, expiresInS: policy.ttlS, size: input.size as number });
    const ticket: UploadTicket = { kind: policy.kind, contentTypes: policy.contentTypes, maxBytes: policy.maxBytes, at: new Date().toISOString() };
    await db.set(globalKey.uploadTicket(owner, name), ticket, policy.ttlS);
    return { ok: true, plan: { mode: "signed", name, ...grant, maxBytes: policy.maxBytes } };
  } catch (e) {
    // The kind and the backend only: no owner, name or URL in a log.
    log.error("upload: signing failed, server upload instead", { kind: policy.kind, backend: st.name, err: e instanceof Error ? e.name : "error" });
    return server;
  }
}

/**
 * Rule 3501: take a signed upload the caller finished. The ticket is read and deleted in one command (`getdel`) under the
 * caller's own owner, so a name from the request finds nothing of anyone else's and is used once. The bytes are read
 * back from the backend, deleted there (the caller keeps a processed copy, never the raw upload), and checked as a
 * server upload would be. Null when there is no such ticket or no such object.
 */
export async function takeUpload(owner: string, policy: UploadPolicy, name: unknown, st: StorageAdapter = storage()): Promise<{ ok: true; body: Buffer } | { ok: false; error: UploadRefusal | "not_found" }> {
  if (typeof name !== "string" || !MEDIA_NAME.test(name)) return { ok: false, error: "not_found" };
  const ticket = await db.getdel<UploadTicket>(globalKey.uploadTicket(owner, name));
  if (!ticket || ticket.kind !== policy.kind) return { ok: false, error: "not_found" };
  const body = await st.get(name).catch(() => null);
  await st.delete(name).catch(() => "missing");
  if (!body) return { ok: false, error: "not_found" };
  const bad = checkBytes(policy, body);
  return bad ? { ok: false, error: bad } : { ok: true, body };
}

/** Read a server upload's body with a running cap, so a missing or false Content-Length still stops at the limit. */
export async function readCappedBody(req: Request, maxBytes: number): Promise<Buffer | "too_large" | null> {
  if (Number(req.headers.get("content-length")) > maxBytes) return "too_large";
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
