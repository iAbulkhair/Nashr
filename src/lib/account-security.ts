import { currentSessionKey, type User } from "@/lib/auth";
import { listDevices, revokeDevice, type Device } from "@/lib/devices";
import { globalKey, type PersonId } from "@/lib/keys";
import { mfaActive } from "@/lib/mfa";
import { actingLogin, ownPasswordMatches } from "@/lib/own-password";
import { listPasskeys, type PasskeyItem } from "@/lib/passkeys";
import { PASSKEYS_MAX, passkeysOn } from "@/lib/passkey-switch";
import { getPerson } from "@/lib/person";
import { allow, giveBack, WINDOW } from "@/lib/rate";
import { can } from "@/lib/roles";

/**
 * Settings > Security for the oRPC procedures (rules 3421-3423, docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md
 * section 8): the same reads and the same one write as GET /api/account/sessions, DELETE /api/account/sessions and GET
 * /api/account/passkeys, from the same library functions, in the same order, with the same refusals. The REST routes keep
 * their own code untouched while AUTH_ENGINE is off (the expand release); tests/better-auth-rpc.test.ts runs both paths
 * on the same fixtures and compares the answers, so the two cannot drift. The contract release deletes the copy that
 * loses.
 *
 * Every function takes the session's user and nothing that names a person: the login, the person and the device index
 * all come from `actingLogin(u)`, never from the request (rule 1940, rule 2400). No workspace is keyed here (the scope
 * builder is never called), which is why /api/rpc may sit outside the second guard (rule 3423).
 */

/** `retryAfter`: seconds, on a 429 only (rule 680): the window of the bucket that refused, sent as `Retry-After`. */
export type Refusal = { status: 400 | 401 | 403 | 404 | 409 | 429; error: string; retryAfter?: number };
export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refused = (status: Refusal["status"], error: string): Result<never> => ({ ok: false, refusal: { status, error } });

/** Wrong passwords per login and hour when ending a device; the REST route's `SIGN_OUT_OTHERS_PER_HOUR`, the same bucket. */
export const SIGN_OUT_OTHERS_PER_HOUR = 10;

/** The revocation stamps that apply to the acting login's sessions, as `resolveSession` reads them (the REST route's `stampsOf`). */
export async function deviceStamps(u: User, me: { kind: "owner" | "member"; pid: PersonId }): Promise<(string | undefined)[]> {
  const p = await getPerson(me.pid);
  return me.kind === "owner" ? [p?.sessionsAfter, p?.devicesAfter] : [p?.sessionsAfter, p?.devicesAfter, u.teamSessionsAfter];
}

/** GET /api/account/sessions (rule 1938): the acting login's own devices, this one marked `current`. */
export async function devicesFor(u: User): Promise<Result<Device[]>> {
  const me = await actingLogin(u);
  if (!me) return refused(403, "forbidden");
  return ok(await listDevices(me.email, await currentSessionKey(), await deviceStamps(u, me)));
}

/**
 * DELETE /api/account/sessions (rules 1939-1940): end ONE other device of the acting login, with its own password. The
 * gate first (`sessions.revoke`, refused while a founder impersonates), then a hit on the wrong-password bucket the REST
 * route uses (one counter for both paths), the password, the hit given back, and the id looked up in the login's own
 * index only.
 */
export async function endDeviceFor(u: User, id: string, password: string): Promise<Result<null>> {
  if (!can(u, "sessions.revoke")) return refused(403, "forbidden");
  const me = await actingLogin(u);
  if (!me) return refused(403, "forbidden");
  const bucket = globalKey.signOutOthersBucket(me.email);
  if (!(await allow(bucket, SIGN_OUT_OTHERS_PER_HOUR, WINDOW.hour))) return { ok: false, refusal: { status: 429, error: "slow_down", retryAfter: WINDOW.hour } };
  if (!(await ownPasswordMatches(u, password))) return refused(401, "wrong_password");
  await giveBack(bucket);
  const done = await revokeDevice(me.email, id, await currentSessionKey());
  if (done === "current") return refused(400, "current_device");
  if (done === "unknown") return refused(404, "not_found");
  return ok(null);
}

export type PasskeyList = { items: PasskeyItem[]; max: number; enabled: boolean; proof: "password" | "code" | "none" };

/**
 * GET /api/account/passkeys (rules 2412-2413, 2426): the acting login's passkeys (never a credential id or key), the cap,
 * whether adding is on, and which proof adding and removing take. Refused while a founder impersonates
 * (`passkeys.manage`), before anything is read.
 */
export async function passkeysFor(u: User): Promise<Result<PasskeyList>> {
  if (!can(u, "passkeys.manage")) return refused(403, "forbidden");
  const a = await actingLogin(u);
  if (!a) return refused(403, "forbidden");
  const person = await getPerson(a.pid);
  if (!person) return refused(403, "forbidden");
  const [items, mfa, enabled] = await Promise.all([listPasskeys(a.pid, person.createdAt), mfaActive(a.email, a.bornAt), passkeysOn()]);
  return ok({ items, max: PASSKEYS_MAX, enabled, proof: mfa ? "code" : person.passHash ? "password" : "none" });
}
