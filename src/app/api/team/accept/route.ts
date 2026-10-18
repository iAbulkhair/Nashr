import { createSession, destroySession, getUser } from "@/lib/auth";
import { notifyItem } from "@/lib/notifications";
import { allow, clientIp } from "@/lib/rate";
import { acceptInvite, peekInvite, type Member } from "@/lib/team";
import { rateLimited, teamFail } from "../respond";
import { acct } from "@/lib/account-id";

/** Per IP, per 15 minutes. The token is 256 bits, so these bound load and noise, not guessing. */
const PEEKS = 30;
const ACCEPTS = 10;

/** The owner's bell. Never fails the request: the member already exists and is signed in. */
async function tellOwner(m: Member) {
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
 * Never creates an owner account: no trial credits, no referral code, no signup tracking.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: unknown; name?: unknown; password?: unknown; lang?: unknown };
  const token = typeof b.token === "string" ? b.token : "";
  const ip = clientIp(req);

  if (b.name === undefined && b.password === undefined) {
    if (!(await allow(`team:peek:ip:${ip}`, PEEKS, 900))) return rateLimited(900);
    const preview = await peekInvite(token);
    if (!preview) return Response.json({ error: "invalid" }, { status: 400 });
    return Response.json({ preview });
  }

  if (!(await allow(`team:accept:ip:${ip}`, ACCEPTS, 900))) return rateLimited(900);
  const res = await acceptInvite(token, { name: b.name, password: b.password, lang: b.lang });
  if (!res.ok) return teamFail(res);
  // Whoever was signed in on this device is signed out: from here the browser is the new member.
  await destroySession();
  await createSession(res.member.email);
  await tellOwner(res.member);
  return Response.json({ ok: true });
}
