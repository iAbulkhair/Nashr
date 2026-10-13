/**
 * Short signed links to our private media (rule 1755). A stored file is served to a signed-in member of its workspace
 * only (rule 1754), but Meta, kie, Higgsfield, Composio and WordPress fetch a post's image with no session. So at the
 * moment we hand a file to one of them, and only then, we mint `…/m/{name}?exp={unix s}&sig={HMAC}`: valid for one
 * name, for at most SHARE_TTL_S. The task keeps the plain URL; a signed link is never stored, logged or shown.
 *
 * The key is derived from CONNECT_SECRET with a fixed label (no new variable): `HMAC-SHA256(CONNECT_SECRET,
 * "media-share:v1")`. Rotating CONNECT_SECRET ends every link still in flight, which is at most a day of them.
 */
import { createHmac } from "node:crypto";
import { MEDIA_NAME, ourMediaName } from "../media-catalog";
import { connectSecret } from "../connectors/store";
import { sameSecret } from "../secret";

/** A day: Meta and Composio fetch at once; kie and Higgsfield may queue a render for hours before they read its image. */
export const SHARE_TTL_S = 24 * 3600;
/** Clock skew allowed between the mint and the check (one process today, so this is a margin, not a need). */
const SKEW_S = 60;

const key = () => createHmac("sha256", connectSecret()).update("media-share:v1").digest();
const sign = (name: string, exp: number) => createHmac("sha256", key()).update(`${name}.${exp}`).digest("base64url");

/**
 * The URL to hand a third party for a file we keep. A disk-store URL gets a signature; anything else (an old public Blob
 * copy, fal's own link) is returned unchanged, because it is already public. Undefined stays undefined.
 */
export function shareUrl<T extends string | undefined>(url: T, now = Date.now()): T {
  const name = ourMediaName(url);
  if (!name) return url;
  const exp = Math.floor(now / 1000) + SHARE_TTL_S;
  return `${url}?exp=${exp}&sig=${sign(name, exp)}` as T;
}

/** Does this request carry a valid, unexpired signature for `name`? Expiry beyond the TTL is refused as forged. */
export function shareValid(name: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  if (!MEDIA_NAME.test(name) || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const e = Number(exp);
  const t = Math.floor(now / 1000);
  if (e < t || e > t + SHARE_TTL_S + SKEW_S) return false;
  return sameSecret(sig, sign(name, e));
}
