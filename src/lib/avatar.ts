/**
 * A person's profile picture (rules 3502-3503). Stored per PERSON, not per workspace: the same face in every workspace
 * the person belongs to, as Supastarter keeps `user.image`. The pointer `avatar:{pid}` holds the stored file's name; the
 * bytes live in the media store under a server-made name (`newUploadName`), outside every workspace's index
 * (`mfile:{scope}:{name}`), so `/m/{name}` never serves them. They are served by `/api/avatar/{name}?s=` only
 * (`avatarUrl`), whose signature our server alone can make.
 *
 * Every upload is re-encoded here (`toAvatar`): the bytes must sniff as JPEG, PNG or WebP, sharp decodes them under a
 * pixel limit, turns them upright, crops a 256 px square and writes a fresh JPEG, so no metadata (EXIF location) and no
 * polyglot payload of the original survives.
 */
import { createHmac } from "node:crypto";
import sharp from "sharp";
import { db } from "./db";
import { personKey, type PersonId } from "./keys";
import { withNamedLock } from "./locks";
import { log } from "./log";
import { MEDIA_NAME } from "./media-catalog";
import { MEDIA_KEYS, MIN_FREE_BYTES, storeHasRoom } from "./media/store";
import { storage } from "./media/storage";
import { connectSecret } from "./connectors/store";
import { AVATAR_UPLOAD, checkBytes, newUploadName, type UploadRefusal } from "./upload";

/** The stored pointer: the file's name and when it was set. */
export type AvatarRecord = { name: string; at: string };
/** The side of the square we keep. */
export const AVATAR_PX = 256;
export const AVATAR_LOCK_TIMEOUT = "avatar_lock_timeout";

export type AvatarError = UploadRefusal | "convert_failed" | "no_store" | "full" | "put_failed" | "busy";

/** Rule 3502: any accepted image to one upright 256×256 JPEG; transparency becomes white. Throws `convert_failed`. */
export async function toAvatar(raw: Buffer): Promise<Buffer> {
  try {
    return await sharp(raw, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: AVATAR_PX, height: AVATAR_PX, fit: "cover", position: "attention" })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("convert_failed");
  }
}

const sigKey = () => createHmac("sha256", connectSecret()).update("avatar:v1").digest();
/** Rule 3503: the signature of one avatar name. A name made up by a caller has none that verifies. */
export const avatarSig = (name: string) => createHmac("sha256", sigKey()).update(name).digest("base64url").slice(0, 32);
/** The URL the app shows for a stored avatar name, or null for none. */
export const avatarUrl = (name: string | null | undefined): string | null => (name && MEDIA_NAME.test(name) ? `/api/avatar/${name}?s=${avatarSig(name)}` : null);

/** The person's avatar URL, or null. */
export async function getAvatar(pid: PersonId): Promise<string | null> {
  return avatarUrl((await db.get<AvatarRecord>(personKey.avatar(pid)))?.name);
}

/** Avatar URLs for many people in ONE `mget` (the team list, the sidebar). Keyed by pid; a person without one is absent. */
export async function avatarUrls(pids: readonly PersonId[]): Promise<Map<PersonId, string>> {
  const uniq = [...new Set(pids.filter(Boolean))];
  const out = new Map<PersonId, string>();
  if (!uniq.length) return out;
  const recs = await db.mget<AvatarRecord>(uniq.map((p) => personKey.avatar(p)));
  uniq.forEach((p, i) => {
    const url = avatarUrl(recs[i]?.name);
    if (url) out.set(p, url);
  });
  return out;
}

/** Drop one stored file and give its size back to the store counters. Never throws. Shared with the workspace logo (rule 3610). */
export async function dropFile(name: string, what: "avatar" | "logo" = "avatar"): Promise<void> {
  const st = storage();
  const head = await st.head(name).catch(() => null);
  const gone = await st.delete(name).catch(() => null);
  if (gone === "deleted" && head) await Promise.all([db.incrby(MEDIA_KEYS.bytes(), -head.size), db.incrby(MEDIA_KEYS.count(), -1)]).catch(() => {});
  if (gone === null) log.error(`${what}: old file not deleted`, { err: "delete_failed" });
}

/**
 * Rule 3502: set the person's avatar from raw bytes (a server upload, or a signed upload taken back by `takeUpload`).
 * Checked against the avatar policy, re-encoded, then under `lock:avatar:{pid}`: the room check, the new file, the
 * pointer, the counters, and the old file deleted last, so a failure leaves the old picture showing.
 */
export async function setAvatar(pid: PersonId, raw: Buffer): Promise<{ ok: true; url: string } | { ok: false; error: AvatarError }> {
  const bad = checkBytes(AVATAR_UPLOAD, raw);
  if (bad) return { ok: false, error: bad };
  let body: Buffer;
  try {
    body = await toAvatar(raw);
  } catch {
    return { ok: false, error: "convert_failed" };
  }
  const st = storage();
  if (!st.configured()) return { ok: false, error: "no_store" };
  try {
    return await withNamedLock(personKey.avatarLock(pid), async () => {
      if (!(await storeHasRoom("image", body.length)) || (await st.freeBytes()) - body.length < MIN_FREE_BYTES) return { ok: false as const, error: "full" as const };
      const name = newUploadName();
      try {
        await st.put(name, body);
      } catch {
        return { ok: false as const, error: "put_failed" as const };
      }
      const old = await db.get<AvatarRecord>(personKey.avatar(pid));
      await Promise.all([db.set(personKey.avatar(pid), { name, at: new Date().toISOString() } satisfies AvatarRecord), db.incrby(MEDIA_KEYS.bytes(), body.length), db.incrby(MEDIA_KEYS.count(), 1)]);
      if (old?.name && MEDIA_NAME.test(old.name) && old.name !== name) await dropFile(old.name);
      return { ok: true as const, url: avatarUrl(name)! };
    }, AVATAR_LOCK_TIMEOUT);
  } catch (e) {
    if (e instanceof Error && e.message === AVATAR_LOCK_TIMEOUT) return { ok: false, error: "busy" };
    throw e;
  }
}

/** Rule 3502: remove the person's avatar (the pointer first, then the file). True when there was one. */
export async function removeAvatar(pid: PersonId): Promise<boolean> {
  try {
    return await withNamedLock(personKey.avatarLock(pid), async () => {
      const rec = await db.getdel<AvatarRecord>(personKey.avatar(pid));
      if (!rec?.name || !MEDIA_NAME.test(rec.name)) return false;
      await dropFile(rec.name);
      return true;
    }, AVATAR_LOCK_TIMEOUT);
  } catch (e) {
    if (e instanceof Error && e.message === AVATAR_LOCK_TIMEOUT) return false;
    throw e;
  }
}

/** Rule 3502: when a person is deleted, their picture goes with them. Never throws (the deletion must finish). */
export async function forgetAvatar(pid: PersonId): Promise<void> {
  const rec = await db.getdel<AvatarRecord>(personKey.avatar(pid)).catch(() => null);
  if (rec?.name && MEDIA_NAME.test(rec.name)) await dropFile(rec.name);
}
