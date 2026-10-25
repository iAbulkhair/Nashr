/**
 * A workspace's logo (rules 3610-3612). Stored per ACCOUNT, not per brand: every brand and every member of the workspace
 * sees the same mark beside the workspace's name (the switcher, the sidebar). The pointer `wslogo:{aid}` holds the stored
 * file's name; `aid` is always the session's account (`aidOf(u)`), never an id from a request. The bytes live in the
 * media store under a server-made name (`newUploadName`), outside every brand's index (`mfile:{scope}:{name}`), so `/m/`
 * never serves them; `/api/logo/{name}?s=` does (`logoUrl`), with a signature only our server can make.
 *
 * Every upload is re-encoded here (`toLogo`): the bytes must sniff as JPEG, PNG or WebP; sharp decodes them under a pixel
 * limit, turns them upright, fits the whole mark inside a 256 px square on white (a logo is never cropped by the server;
 * the browser's crop dialog is the place to frame it) and writes a fresh JPEG, so no metadata and no payload of the
 * original survives. Changing it is an owner's or an admin's (`workspace.logo`), never a founder's impersonation.
 *
 * Expand-only (rule 679): a new key nothing older reads; the account's deletion removes it (`forgetLogo`).
 */
import { createHmac } from "node:crypto";
import sharp from "sharp";
import { dropFile } from "./avatar";
import { db } from "./db";
import { accountKey, type AccountId } from "./keys";
import { withNamedLock } from "./locks";
import { MEDIA_NAME } from "./media-catalog";
import { MEDIA_KEYS, MIN_FREE_BYTES, storeHasRoom } from "./media/store";
import { storage } from "./media/storage";
import { connectSecret } from "./connectors/store";
import { LOGO_UPLOAD, checkBytes, newUploadName, type UploadRefusal } from "./upload";

/** The stored pointer: the file's name and when it was set. */
export type LogoRecord = { name: string; at: string };
/** The side of the square we keep. */
export const LOGO_PX = 256;
export const LOGO_LOCK_TIMEOUT = "logo_lock_timeout";

export type LogoError = UploadRefusal | "convert_failed" | "no_store" | "full" | "put_failed" | "busy";

/** Rule 3610: any accepted image to one upright 256×256 JPEG, the whole mark inside on white. Throws `convert_failed`. */
export async function toLogo(raw: Buffer): Promise<Buffer> {
  try {
    return await sharp(raw, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: LOGO_PX, height: LOGO_PX, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("convert_failed");
  }
}

/** A key of its own (label "wslogo:v1"): an avatar's signature never opens a logo link, nor the reverse. */
const sigKey = () => createHmac("sha256", connectSecret()).update("wslogo:v1").digest();
/** Rule 3612: the signature of one logo name. A name made up by a caller has none that verifies. */
export const logoSig = (name: string) => createHmac("sha256", sigKey()).update(name).digest("base64url").slice(0, 32);
/** The URL the app shows for a stored logo name, or null for none. */
export const logoUrl = (name: string | null | undefined): string | null => (name && MEDIA_NAME.test(name) ? `/api/logo/${name}?s=${logoSig(name)}` : null);

/** The workspace's logo URL, or null. */
export async function getLogo(aid: AccountId): Promise<string | null> {
  return logoUrl((await db.get<LogoRecord>(accountKey.logo(aid)))?.name);
}

/** Logo URLs for many workspaces in ONE `mget` (the switcher's list). Keyed by account; one without a logo is absent. */
export async function logoUrls(aids: readonly AccountId[]): Promise<Map<AccountId, string>> {
  const uniq = [...new Set(aids.filter(Boolean))];
  const out = new Map<AccountId, string>();
  if (!uniq.length) return out;
  const recs = await db.mget<LogoRecord>(uniq.map((a) => accountKey.logo(a)));
  uniq.forEach((a, i) => {
    const url = logoUrl(recs[i]?.name);
    if (url) out.set(a, url);
  });
  return out;
}

/**
 * Rule 3610: set the workspace's logo from raw bytes (a server upload, or a signed upload taken back by `takeUpload`).
 * Checked against the logo policy, re-encoded, then under `lock:wslogo:{aid}`: the room check, the new file, the pointer,
 * the counters, and the old file deleted last, so a failure leaves the old logo showing. The caller checked the role.
 */
export async function setLogo(aid: AccountId, raw: Buffer): Promise<{ ok: true; url: string } | { ok: false; error: LogoError }> {
  const bad = checkBytes(LOGO_UPLOAD, raw);
  if (bad) return { ok: false, error: bad };
  let body: Buffer;
  try {
    body = await toLogo(raw);
  } catch {
    return { ok: false, error: "convert_failed" };
  }
  const st = storage();
  if (!st.configured()) return { ok: false, error: "no_store" };
  try {
    return await withNamedLock(accountKey.logoLock(aid), async () => {
      if (!(await storeHasRoom("image", body.length)) || (await st.freeBytes()) - body.length < MIN_FREE_BYTES) return { ok: false as const, error: "full" as const };
      const name = newUploadName();
      try {
        await st.put(name, body);
      } catch {
        return { ok: false as const, error: "put_failed" as const };
      }
      const old = await db.get<LogoRecord>(accountKey.logo(aid));
      await Promise.all([db.set(accountKey.logo(aid), { name, at: new Date().toISOString() } satisfies LogoRecord), db.incrby(MEDIA_KEYS.bytes(), body.length), db.incrby(MEDIA_KEYS.count(), 1)]);
      if (old?.name && MEDIA_NAME.test(old.name) && old.name !== name) await dropFile(old.name, "logo");
      return { ok: true as const, url: logoUrl(name)! };
    }, LOGO_LOCK_TIMEOUT);
  } catch (e) {
    if (e instanceof Error && e.message === LOGO_LOCK_TIMEOUT) return { ok: false, error: "busy" };
    throw e;
  }
}

/** Rule 3610: remove the workspace's logo (the pointer first, then the file). True when there was one. */
export async function removeLogo(aid: AccountId): Promise<boolean> {
  try {
    return await withNamedLock(accountKey.logoLock(aid), async () => {
      const rec = await db.getdel<LogoRecord>(accountKey.logo(aid));
      if (!rec?.name || !MEDIA_NAME.test(rec.name)) return false;
      await dropFile(rec.name, "logo");
      return true;
    }, LOGO_LOCK_TIMEOUT);
  } catch (e) {
    if (e instanceof Error && e.message === LOGO_LOCK_TIMEOUT) return false;
    throw e;
  }
}

/** Rule 3610: when the account is deleted, its logo goes with it. Never throws (the deletion must finish). */
export async function forgetLogo(aid: AccountId): Promise<void> {
  const rec = await db.getdel<LogoRecord>(accountKey.logo(aid)).catch(() => null);
  if (rec?.name && MEDIA_NAME.test(rec.name)) await dropFile(rec.name, "logo");
}
