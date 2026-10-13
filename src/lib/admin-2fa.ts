import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "./db";
import { ADMIN_COOKIE, sessionCookie } from "./auth";
import { allow, clientIp, giveBack, retryLater, sameSecret } from "./rate";
import { connectSecret } from "./connectors/store";
import { looksLikeRecovery, newRecoveryCode, newTotpSecret, otpauthUri, recoveryHash, totpMatch } from "./totp";

/**
 * The founder console's second factor (360 study C-004, leftovers L055, rules 1370-1389, docs/system/flows.md "Founder
 * console second factor").
 *
 * One enrolment for the whole console: `admin:2fa` holds the authenticator secret, encrypted (AES-256-GCM under a key
 * derived from CONNECT_SECRET with its own label, so it never decrypts a connector token or the other way round), and a
 * SHA-256 of the one recovery code. Neither is ever logged or sent back after setup.
 *
 * Rollout never locks the founder out: until the secret is enrolled nothing is enforced and the console shows a banner.
 * Once enrolled, every console WRITE (money, plans, credits, top-ups, payments, partners, impersonation, account
 * actions, agent skills and platform instructions, the golden run, the wishlist) needs either a live step-up or a code
 * in the `x-admin-otp` header (`secondFactorRefusal`). Reads stay on the key or the founder sign-in alone.
 *
 * A step-up is a server record `admin2fa:step:{sha256(id)}` behind the `nashr_admin_2fa` cookie (a random id). It is
 * tied to the actor ("key" or the founder's email) and to a hash of the cookie that made them the actor (`nashr_admin`
 * for the key, `nashr_session` for a founder), so ending the key session or signing out ends it too, and a copied 2FA
 * cookie is useless without the session it was opened in. It ends after 30 idle minutes and 12 hours at most.
 *
 * Codes are rate limited per IP and for the whole console (`allow`), a right code hands its hit back, and every
 * accepted 30-second step is burned (`admin2fa:used:{step}`), so a code seen over a shoulder cannot be replayed.
 *
 * The recovery code, used once, removes the enrolment: the console is back to key-only with the banner, and the founder
 * sets up the authenticator again (a new secret and a new recovery code). Break glass when both the phone and the
 * recovery code are lost: delete the `admin:2fa` key in the Upstash console.
 */
export const ADMIN_2FA_COOKIE = "nashr_admin_2fa";
/** A step-up ends after this many seconds without a gated write. */
export const STEP_UP_IDLE = 30 * 60;
/** No step-up outlives this many seconds from the code entry. */
export const STEP_UP_MAX = 12 * 60 * 60;
/** A live step-up is renewed at most once a minute. */
export const STEP_UP_RENEW = 60;
/** A setup not confirmed with a code within this many seconds is dropped. */
export const ENROL_TTL = 15 * 60;
/** Code tries per IP per window, and for the whole console per hour (a leaked key from many addresses). */
export const CODE_TRIES_PER_IP = 5, CODE_TRIES_WINDOW = 15 * 60, CODE_TRIES_ALL = 30, CODE_TRIES_ALL_WINDOW = 60 * 60;

export const ENROLMENT_KEY = "admin:2fa";
export const PENDING_KEY = "admin:2fa:pending";
/** The enrolment: the encrypted secret, the recovery code's hash, when and by whom (the actor) it was set up. */
export type Enrolment = { enc: string; rc: string; at: string; by: string };
type Pending = { enc: string; at: string; by: string };
type StepUp = { who: string; base: string; at: number; seen: number };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stepKey = (id: string) => `admin2fa:step:${sha(id)}`;
const usedKey = (step: number) => `admin2fa:used:${step}`;

function cryptKey(): Buffer {
  return createHash("sha256").update(`nashr-admin-2fa:${connectSecret()}`).digest();
}
export function sealSecret(secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cryptKey(), iv);
  const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
/** Null when the blob does not open (CONNECT_SECRET changed, or a damaged record): the gate then refuses, it never opens. */
export function openSecret(blob: string): string | null {
  try {
    const [iv, tag, enc] = blob.split(".");
    const d = createDecipheriv("aes-256-gcm", cryptKey(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const isEnrolment = (v: unknown): v is Enrolment =>
  !!v && typeof v === "object" && typeof (v as Enrolment).enc === "string" && typeof (v as Enrolment).rc === "string";

/** Whether the console has a second factor, and since when. What the layout's banner reads. */
export async function secondFactorStatus(): Promise<{ enrolled: boolean; at: string | null }> {
  const rec = await db.get<Enrolment>(ENROLMENT_KEY);
  return isEnrolment(rec) ? { enrolled: true, at: rec.at } : { enrolled: false, at: null };
}

/** The cookie that makes `who` the console actor, hashed: what a step-up is tied to. Null for a header-key call. */
async function baseOf(who: string): Promise<string | null> {
  const v = (await cookies()).get(who === "key" ? ADMIN_COOKIE : "nashr_session")?.value;
  return v ? sha(`nashr-admin-2fa-base:${v}`) : null;
}

const stepInTime = (s: StepUp, now: number) =>
  typeof s.at === "number" && typeof s.seen === "number" && now - s.at < STEP_UP_MAX * 1000 && now - s.seen < STEP_UP_IDLE * 1000;

/** True while this browser holds a live step-up for this actor and the session it was opened in. Renews it. */
export async function stepUpLive(who: string): Promise<boolean> {
  const id = (await cookies()).get(ADMIN_2FA_COOKIE)?.value;
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
  const k = stepKey(id);
  const [rec, base] = await Promise.all([db.get<StepUp>(k), baseOf(who)]);
  if (!rec || typeof rec.who !== "string" || typeof rec.base !== "string" || !base) return false;
  if (rec.who !== who || !sameSecret(rec.base, base)) return false;
  const now = Date.now();
  if (!stepInTime(rec, now)) return false;
  const ttl = Math.max(0, Math.min(STEP_UP_IDLE, Math.floor((rec.at + STEP_UP_MAX * 1000 - now) / 1000)));
  if (now - rec.seen >= STEP_UP_RENEW * 1000 && ttl > 0) {
    await db.setXx(k, { ...rec, seen: now } satisfies StepUp, ttl).catch(() => false);
  }
  return true;
}

/** Open a step-up for `who` in this browser. False for a call with no session cookie (the key header alone). */
async function openStepUp(who: string): Promise<boolean> {
  const base = await baseOf(who);
  if (!base) return false;
  const id = randomBytes(32).toString("hex");
  const now = Date.now();
  await db.set(stepKey(id), { who, base, at: now, seen: now } satisfies StepUp, STEP_UP_IDLE);
  (await cookies()).set(ADMIN_2FA_COOKIE, id, await sessionCookie(STEP_UP_MAX));
  return true;
}

/**
 * Take one code try for this caller: per IP and for the whole console. Null when allowed, else the 429 to answer.
 * A right code hands both hits back (`codeAccepted`), so only wrong codes count.
 */
async function takeTry(req: Request): Promise<NextResponse | null> {
  const ip = `admin2fa:ip:${clientIp(req)}`;
  const [one, all] = await Promise.all([allow(ip, CODE_TRIES_PER_IP, CODE_TRIES_WINDOW), allow("admin2fa:all", CODE_TRIES_ALL, CODE_TRIES_ALL_WINDOW)]);
  if (one && all) return null;
  return retryLater({ ok: false, error: "slow_down" }, one ? CODE_TRIES_ALL_WINDOW : CODE_TRIES_WINDOW);
}
async function codeAccepted(req: Request): Promise<void> {
  await Promise.all([giveBack(`admin2fa:ip:${clientIp(req)}`), giveBack("admin2fa:all")]);
}

/** A code against a secret, burning the step it matched. False for a wrong code and for a step already used. */
async function totpOnce(secret: string, code: string): Promise<boolean> {
  const step = totpMatch(secret, code, Date.now());
  if (step === null) return false;
  return db.setNx(usedKey(step), 1, 120);
}

export type CodeResult = { ok: true; via: "totp" | "recovery" } | { ok: false; res: NextResponse };
const badCode = () => NextResponse.json({ ok: false, error: "bad_code" }, { status: 400 });

/**
 * Check a code typed by the founder (rate limited): the authenticator's 6 digits, or the recovery code. A recovery code
 * removes the enrolment (see the file comment). The caller decides what a pass opens.
 */
export async function checkCode(req: Request, code: unknown): Promise<CodeResult> {
  if (typeof code !== "string" || code.length > 64) return { ok: false, res: badCode() };
  const slow = await takeTry(req);
  if (slow) return { ok: false, res: slow };
  const rec = await db.get<Enrolment>(ENROLMENT_KEY);
  if (!isEnrolment(rec)) return { ok: false, res: NextResponse.json({ ok: false, error: "not_enrolled" }, { status: 409 }) };
  if (looksLikeRecovery(code)) {
    if (!sameSecret(recoveryHash(code), rec.rc)) return { ok: false, res: badCode() };
    await db.del(ENROLMENT_KEY);
    await codeAccepted(req);
    return { ok: true, via: "recovery" };
  }
  const secret = openSecret(rec.enc);
  if (!secret || !(await totpOnce(secret, code))) return { ok: false, res: badCode() };
  await codeAccepted(req);
  return { ok: true, via: "totp" };
}

/**
 * The gate every founder write calls right after `adminActor` (rule 1376). Null to go on: nothing enrolled yet, a live
 * step-up for this actor, or a right code in `x-admin-otp` (for a script on the key header). Otherwise 403
 * `second_factor`, which the console's `adminFetch` turns into the code prompt and then sends the request again.
 */
export async function secondFactorRefusal(req: Request, who: string): Promise<NextResponse | null> {
  const [rec, live] = await Promise.all([db.get<Enrolment>(ENROLMENT_KEY), stepUpLive(who)]);
  if (!isEnrolment(rec) || live) return null;
  const otp = req.headers.get("x-admin-otp");
  // Six digits only: a recovery code in a header would remove the enrolment as a side effect of some other write.
  if (otp !== null && /^\d{6}$/.test(otp)) {
    const r = await checkCode(req, otp);
    if (r.ok) return null;
    if (!r.ok && r.res.status === 429) return r.res;
  }
  return NextResponse.json({ ok: false, error: "second_factor" }, { status: 403 });
}

/** Verify a code from the console's prompt and open a step-up. What POST /api/admin/2fa `verify` does. */
export async function verifyAndStepUp(req: Request, who: string, code: unknown): Promise<CodeResult & { stepUp?: boolean }> {
  const r = await checkCode(req, code);
  if (!r.ok) return r;
  return { ...r, stepUp: r.via === "totp" ? await openStepUp(who) : false };
}

/**
 * Begin setup: a new secret, kept encrypted for 15 minutes until a code from it confirms it. Returns the secret and its
 * otpauth URI for the founder's app, and nothing is enrolled yet. Replacing an enrolled authenticator goes through the
 * gate first (the route checks `secondFactorRefusal`).
 */
export async function startEnrolment(who: string): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  await db.set(PENDING_KEY, { enc: sealSecret(secret), at: new Date().toISOString(), by: who } satisfies Pending, ENROL_TTL);
  return { secret, uri: otpauthUri(secret, "founder console") };
}

/**
 * Finish setup with a code from the new secret (rate limited like every code). Writes the enrolment with a new recovery
 * code's hash, drops the pending secret, opens a step-up, and returns the recovery code: the only time it is shown.
 */
export async function confirmEnrolment(req: Request, who: string, code: unknown): Promise<{ ok: true; recovery: string } | { ok: false; res: NextResponse }> {
  if (typeof code !== "string" || code.length > 64) return { ok: false, res: badCode() };
  const slow = await takeTry(req);
  if (slow) return { ok: false, res: slow };
  const p = await db.get<Pending>(PENDING_KEY);
  if (!p || typeof p.enc !== "string" || p.by !== who) return { ok: false, res: NextResponse.json({ ok: false, error: "no_setup" }, { status: 409 }) };
  const secret = openSecret(p.enc);
  if (!secret || !(await totpOnce(secret, code))) return { ok: false, res: badCode() };
  const recovery = newRecoveryCode();
  await db.set(ENROLMENT_KEY, { enc: p.enc, rc: recoveryHash(recovery), at: new Date().toISOString(), by: who } satisfies Enrolment);
  await Promise.all([db.del(PENDING_KEY), codeAccepted(req)]);
  await openStepUp(who);
  return { ok: true, recovery };
}
