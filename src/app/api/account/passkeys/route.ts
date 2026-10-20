import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { COPY } from "@/emails/copy";
import { currentSessionKey, currentUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateFormat } from "@/lib/dates";
import type { Lang } from "@/lib/i18n";
import { accountKey, personKey, type PersonId } from "@/lib/keys";
import { log } from "@/lib/log";
import { checkMfaCode, mfaActive } from "@/lib/mfa";
import { sendEmail } from "@/lib/notify";
import { appOrigin } from "@/lib/origin";
import { actingLogin, ownPasswordMatches } from "@/lib/own-password";
import { addPasskey, ensureUid, listPasskeys, readSet, removePasskey, renamePasskey } from "@/lib/passkeys";
import { PASSKEY_CHALLENGE_TTL, PASSKEYS_MAX, passkeysOn } from "@/lib/passkey-switch";
import { getPerson, isPersonLockTimeout, type Person } from "@/lib/person";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { sameSecret } from "@/lib/secret";
import { registrationOptions, verifyRegistration } from "@/lib/webauthn";

/**
 * The acting login's own passkeys, Settings > Security (customer passkeys, docs/specs/2026-10-20-passkeys.md flows A and
 * B, rules 2400, 2407, 2410-2416, 2426).
 *
 * GET: the list (`ref`, name, dates, `synced`, transports; never a credential id or key, rule 2413), the cap, whether
 * adding is on (rule 2426), and which proof adding and removing take (`password`, `code` or `none`) so the card asks for
 * the right one.
 * POST {action}:
 *   register-options {password? | code?}: the proof, then the WebAuthn options; opens `pkreg:{pid}` for 300 s, bound to
 *     this session (rules 2407, 2410).
 *   register-verify {response, name}: takes the challenge (`getdel`), verifies through the seam, stores the passkey
 *     under the person lock (rule 2414), then sends the notice email after the lock (rule 2415).
 *   rename {ref, name}: the session only (rule 2411).
 *   remove {ref, password? | code?}: an unknown ref is 404 first, then the proof again, in this request (rule 2411).
 *
 * Owner or member, each for their OWN person (`actingLogin`, rule 2412): refused while a founder impersonates
 * (`passkeys.manage` is in IMPERSONATION_BLOCKED, checked before anything is read) and for a token (`currentUser` reads
 * the session cookie only). The pid comes from the session through `actingLogin`, never from the body (rule 2400); the
 * body schema has no address, pid or account field. The birth stamp is the person's `createdAt` (pre-flight ruling 1).
 *
 * The proof (`freshProof`) runs before any person lock: a recovery code is spent under `lock:login`, which comes before
 * `lock:person` in rule 2139, and locks are not reentrant (pre-flight ruling 9).
 */

/** Wrong proofs per login and hour (rule 2410, the `mfapw:` pattern of POST /api/account/2fa). */
const PROOF_TRIES_PER_HOUR = 10;
/** The challenge's own age limit, in ms, on top of the key's TTL (rule 2407). */
const CHALLENGE_MS = PASSKEY_CHALLENGE_TTL * 1000;

/** SHA-256 hex (pre-flight ruling 20: a local helper). */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

type RegChallenge = { challenge: string; sess: string; at: number };
type Me = { pid: PersonId; email: string; bornAt: string | undefined; person: Person; born: string };

const no = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });
const FORBIDDEN = () => no(403, "forbidden");

/** The acting login and its person record (name, language, password hash, birth), or null for any other actor. */
async function acting(u: User): Promise<Me | null> {
  const a = await actingLogin(u);
  if (!a) return null;
  const person = await getPerson(a.pid);
  return person ? { pid: a.pid, email: a.email, bornAt: a.bornAt, person, born: person.createdAt } : null;
}

const REF = z.string().regex(/^[0-9a-f]{16}$/);
const NAME = z.string().max(200);
const PROOF = { password: z.string().max(1024).optional(), code: z.string().max(64).optional() };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register-options"), ...PROOF }),
  z.object({ action: z.literal("register-verify"), response: z.unknown(), name: NAME }),
  z.object({ action: z.literal("rename"), ref: REF, name: NAME }),
  z.object({ action: z.literal("remove"), ref: REF, ...PROOF }),
]);

/**
 * Fresh re-authentication for adding and removing (rules 2410, 2411): a TOTP or recovery code when two-step sign-in is
 * on, else the login's own password; a person with neither gets 403 `reauth_unavailable`. Every try counts in
 * `pkpw:{login}` before the compare, and a right one is given back. Null when the proof holds.
 */
async function freshProof(req: Request, u: User, me: Me, b: { password?: string; code?: string }): Promise<NextResponse | null> {
  const mfa = await mfaActive(me.email, me.bornAt);
  if (!mfa && !me.person.passHash) return no(403, "reauth_unavailable");
  const bucket = accountKey.passkeyProofBucket(me.email);
  if (!(await allow(bucket, PROOF_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (mfa) {
    const code = await checkMfaCode(req, me.email, me.bornAt, b.code, { recovery: true });
    if (!code.ok) return code.res;
  } else if (!(await ownPasswordMatches(u, b.password))) return no(401, "wrong_password");
  await giveBack(bucket);
  return null;
}

/** `YYYY-MM-DD HH:MM` in Asia/Riyadh, the zone the card shows dates in; the copy labels it as Riyadh time. */
function riyadhTime(d: Date): string {
  const parts = Object.fromEntries(
    dateFormat("en", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "Asia/Riyadh")
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * The notice after an add (rule 2415): one email in the person's language naming the passkey and the time (Asia/Riyadh, labelled), pointing to
 * Security settings, without credential data. Called after the person lock is released; a failure is logged without
 * values and never undoes the add.
 */
async function passkeyNotice(me: Me, name: string): Promise<void> {
  try {
    const lang: Lang = me.person.lang === "en" ? "en" : "ar";
    const c = COPY[lang].passkey;
    const time = riyadhTime(new Date());
    // Function replacements: a name holding `$&` or `$1` is kept as typed.
    const paragraphs = [c.body.replace("{name}", () => name), c.when.replace("{time}", () => time), c.notYou];
    const href = `${appOrigin()}/${lang}/app/settings/security`;
    const sent = await sendEmail({ to: me.email, subject: c.title, text: [...paragraphs, href].join("\n\n"), template: "notice", context: { title: c.title, paragraphs, cta: { label: c.action, href } }, locale: lang });
    if (!sent) log.warn("passkey notice failed");
  } catch {
    log.warn("passkey notice failed");
  }
}

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const refused = forbid(u, "passkeys.manage");
  if (refused) return refused;
  const me = await acting(u);
  if (!me) return FORBIDDEN();
  const [items, mfa, enabled] = await Promise.all([listPasskeys(me.pid, me.born), mfaActive(me.email, me.bornAt), passkeysOn()]);
  const proof = mfa ? "code" : me.person.passHash ? "password" : "none";
  return NextResponse.json({ ok: true, items, max: PASSKEYS_MAX, enabled, proof });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const refused = forbid(u, "passkeys.manage");
  if (refused) return refused;
  const me = await acting(u);
  if (!me) return FORBIDDEN();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return no(400, "bad_request");
  const b = parsed.data;
  try {
    if (b.action === "register-options") {
      if (!(await passkeysOn())) return no(404, "unavailable");
      const set = await readSet(me.pid, me.born);
      if ((set?.creds.length ?? 0) >= PASSKEYS_MAX) return no(409, "limit");
      const sess = await currentSessionKey();
      if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
      const proof = await freshProof(req, u, me, b);
      if (proof) return proof;
      const own = await ensureUid(me.pid, me.born);
      if (own === "invalid") return no(400, "invalid");
      // A set read before `ensureUid` that did not fit is replaced by an empty one, so its credentials are not excluded.
      const exclude = (set?.creds ?? []).map((c) => ({ id: c.id, transports: c.transports }));
      const { options, challenge } = await registrationOptions({ uid: own.uid, userName: me.email, displayName: me.person.name || me.email, exclude });
      await db.set(personKey.passkeyReg(me.pid), { challenge, sess: sha256(sess), at: Date.now() } satisfies RegChallenge, PASSKEY_CHALLENGE_TTL);
      return NextResponse.json({ ok: true, options });
    }
    if (b.action === "register-verify") {
      if (!(await passkeysOn())) return no(404, "unavailable");
      const [sess, ch] = await Promise.all([currentSessionKey(), db.getdel<RegChallenge>(personKey.passkeyReg(me.pid))]);
      const fresh = !!ch && typeof ch.challenge === "string" && typeof ch.sess === "string" && typeof ch.at === "number" && Date.now() - ch.at <= CHALLENGE_MS;
      if (!fresh || !sess || !sameSecret(ch.sess, sha256(sess))) return no(410, "expired");
      const v = await verifyRegistration(b.response, ch.challenge);
      if (!v.ok) return no(400, "invalid");
      const added = await addPasskey(me.pid, me.born, v.cred, b.name);
      if (added === "limit") return no(409, "limit");
      if (added === "credential_taken") return no(409, "credential_taken");
      if (added === "invalid") return no(400, "invalid");
      // After the person lock (addPasskey released it): the mail never holds the lock and never undoes the add.
      await passkeyNotice(me, added.item.name);
      return NextResponse.json({ ok: true, item: added.item });
    }
    if (b.action === "rename") {
      const r = await renamePasskey(me.pid, me.born, b.ref, b.name);
      if (r === "invalid") return no(400, "invalid");
      return r === "ok" ? NextResponse.json({ ok: true }) : no(404, "not_found");
    }
    // An unknown ref is 404 before the proof, so a stale ref never spends a recovery code or a try. Refs are looked up in
    // the caller's own set only, so this says nothing about anyone else's; the locked remove stays the authority.
    if (!(await listPasskeys(me.pid, me.born)).some((p) => p.ref === b.ref)) return no(404, "not_found");
    const proof = await freshProof(req, u, me, b);
    if (proof) return proof;
    return (await removePasskey(me.pid, me.born, b.ref)) === "ok" ? NextResponse.json({ ok: true }) : no(404, "not_found");
  } catch (e) {
    if (isPersonLockTimeout(e)) return no(409, "busy");
    throw e;
  }
}
