import { createSession, currentPerson, destroySession, getUser } from "@/lib/auth";
import { notifyItem } from "@/lib/notifications";
import { isPersonLockTimeout } from "@/lib/person";
import { allow, clientIp } from "@/lib/rate";
import { acceptInvite, isTeamLockTimeout, peekInvite, type Member } from "@/lib/team";
import { acceptInviteAsPerson } from "@/lib/workspaces";
import { MULTI_ORG } from "@/lib/multi-org";
import { appHref } from "@/lib/ws-path";
import { busy, rateLimited, teamFail, unauthorized } from "../respond";
import { acct } from "@/lib/account-id";

/** Per IP, per 15 minutes. The token is 256 bits, so these bound load and noise, not guessing. */
const PEEKS = 30;
const ACCEPTS = 10;
/** One accept bucket per IP for both ways to accept (a new person's password, or the signed-in person's join). */
const acceptBucket = (ip: string) => `team:accept:ip:${ip}`;

/** The owner's bell. Never fails the request: the member already exists and is signed in. */
async function tellOwner(m: Pick<Member, "memberOf" | "name" | "email" | "role">) {
  try {
    const owner = await getUser(m.memberOf);
    if (!owner) return;
    const ar = owner.lang === "ar";
    const role = ar ? (m.role === "admin" ? "مدير" : "عضو") : m.role;
    await notifyItem(acct(owner), owner.lang, {
      kind: "info",
      title: ar ? `${m.name} انضم إلى الأعضاء` : `${m.name} joined your members`,
      body: ar ? `قبل ${m.email} الدعوة بصفة ${role}. تدير الأعضاء والمقاعد من صفحة «الأعضاء».` : `${m.email} accepted the invitation as ${role}. Manage members and seats on the Members page.`,
      href: "team",
    });
  } catch (e) {
    console.error("team accept notification failed", e);
  }
}

/**
 * POST /api/team/accept. Public: the invite token IS the credential, taken from the body (the join page reads it from
 * the link's fragment), never from a URL.
 *   {token}                        → {preview:{team, inviter, email, role, expiresAt}}; consumes nothing.
 *   {token, name, password, lang?} → creates the member login (single use, re-checked under locks in src/lib/team.ts
 *                                    `acceptInvite`), ends any session on this device and signs the new member in.
 *   {token, join: true, lang?}     → only while `MULTI_ORG` is on (multi-workspace M2, rule 2116): the signed-in person
 *                                    (`currentPerson()`, 401 without one) joins with their own verified address, which
 *                                    must be the invite's (`acceptInviteAsPerson`); their session moves to the account
 *                                    and the answer is its link. No password, no new session.
 * Never creates an owner account: no trial credits, no referral code, no signup tracking.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: unknown; name?: unknown; password?: unknown; lang?: unknown; join?: unknown };
  const token = typeof b.token === "string" ? b.token : "";
  const ip = clientIp(req);

  if (MULTI_ORG && b.join === true) {
    const me = await currentPerson();
    if (!me) return unauthorized();
    if (!(await allow(acceptBucket(ip), ACCEPTS, 900))) return rateLimited(900);
    let joined: Awaited<ReturnType<typeof acceptInviteAsPerson>>;
    try {
      joined = await acceptInviteAsPerson(token, me.person);
    } catch (e) {
      if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return busy();
      throw e;
    }
    if (!joined.ok) return teamFail(joined);
    await tellOwner(joined.member);
    const lang = b.lang === "en" || b.lang === "ar" ? b.lang : me.person.lang === "en" ? "en" : "ar";
    return Response.json({ ok: true, href: appHref(lang, "", joined.handle) });
  }

  if (b.name === undefined && b.password === undefined) {
    if (!(await allow(`team:peek:ip:${ip}`, PEEKS, 900))) return rateLimited(900);
    const preview = await peekInvite(token);
    if (!preview) return Response.json({ error: "invalid" }, { status: 400 });
    return Response.json({ preview });
  }

  if (!(await allow(acceptBucket(ip), ACCEPTS, 900))) return rateLimited(900);
  // The new person is written under `lock:team:{aid}` → `lock:person:{pid}` (multi-workspace M1, rule 2139): a timeout on
  // either, taken before the first write, is a 409 "try again", not a 500.
  let res: Awaited<ReturnType<typeof acceptInvite>>;
  try {
    res = await acceptInvite(token, { name: b.name, password: b.password, lang: b.lang });
  } catch (e) {
    if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return busy();
    throw e;
  }
  if (!res.ok) return teamFail(res);
  // Whoever was signed in on this device is signed out: from here the browser is the new member.
  await destroySession();
  await createSession(res.member.email);
  await tellOwner(res.member);
  return Response.json({ ok: true });
}
