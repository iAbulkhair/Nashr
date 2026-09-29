import { createHash } from "crypto";
import { currentUser, normalizeEmail, validEmail, type User } from "@/lib/auth";
import { notifyItem } from "@/lib/notifications";
import { mailReady, sendEmail } from "@/lib/notify";
import { ORIGIN } from "@/lib/oauth";
import { allow, clientIp } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { cancelInvite, createInvite, discardInvite, type Invite } from "@/lib/team";
import { rateLimited, teamFail, unauthorized } from "../respond";

/**
 * Invites per account per day (lower on a free trial, which anyone can open with one signup), per IP per hour, and per
 * invited address per day across ALL accounts. Each answer says whether an address is free, and each emailed invite is
 * mail from the product's own domain to a stranger's address, so all four are metered.
 */
const PER_ACCOUNT_DAY = 20;
const PER_TRIAL_ACCOUNT_DAY = 5;
const PER_IP_HOUR = 30;
const PER_ADDRESS_DAY = 5;

const ROLE = { ar: { admin: "مدير", member: "عضو" }, en: { admin: "admin", member: "member" } } as const;

/**
 * The invitation email, in the invite's language. A fixed template: the only thing in it the sender chose is the
 * address of the login that sent it (a validated email, no spaces or line breaks). No display name and no brand name:
 * both are free text anyone can set at signup or on the brand form, and they would turn this email, sent from the
 * product's own verified domain to any address, into a relay for whatever text the sender wanted to put in it.
 */
function inviteMail(inv: Invite, inviterEmail: string, link: string) {
  if (inv.lang === "ar") {
    return {
      subject: "دعوة للانضمام إلى فريق في نشر",
      text: `مرحباً،\n\nدعاك مستخدم نشر ${inviterEmail} للانضمام إلى حسابه في نشر بصفة ${ROLE.ar[inv.role]}.\n\nافتح الرابط التالي خلال 7 أيام لتختار اسمك وكلمة مرورك:\n\n${link}\n\nالدعوة لهذا البريد وحده. إذا لم تتوقعها فتجاهل هذه الرسالة، ولن يتغير شيء.`,
    };
  }
  return {
    subject: "You are invited to join a team on Nashr",
    text: `Hello,\n\nThe Nashr user ${inviterEmail} invited you to join their account on Nashr as ${inv.role === "admin" ? "an admin" : "a member"}.\n\nOpen this link within 7 days to choose your name and password:\n\n${link}\n\nThe invitation is for this email address only. If you did not expect it, ignore this email and nothing changes.`,
  };
}

/**
 * The account's bell. Never fails the request: the invite already exists. The bell is shared by every login of the
 * account, and pending invites are for admins and the owner (`team.invites.view`), so the notice names neither the
 * invited address nor the role: the Members page shows them to whoever may see them. It says whether an email went out,
 * so nobody is told an invitation was sent when only a link was made.
 */
async function tellOwner(u: User, inviter: string, emailed: boolean) {
  const ar = u.lang === "ar";
  try {
    await notifyItem(u.email, u.lang, {
      kind: "info",
      title: emailed ? (ar ? "أُرسلت دعوة جديدة" : "A new invitation was sent") : ar ? "أُنشئ رابط دعوة جديد" : "A new invitation link was created",
      body: emailed
        ? ar ? `أرسل ${inviter} دعوة بالبريد. تنتهي خلال 7 أيام، وتفاصيلها في صفحة «الأعضاء».` : `${inviter} emailed an invitation. It expires in 7 days; the details are on the Members page.`
        : ar ? `أنشأ ${inviter} رابط دعوة ليرسله بنفسه، فالبريد غير مفعّل. ينتهي خلال 7 أيام، وتفاصيله في صفحة «الأعضاء».` : `${inviter} created an invitation link to pass on by hand, because email is not set up. It expires in 7 days; the details are on the Members page.`,
      href: "team",
    });
  } catch (e) {
    console.error("team invite notification failed", e);
  }
}

/**
 * POST /api/team/invite {email, role, lang?} → {ok, invite, emailed, link?}. The owner may invite either role, an admin
 * plain members only. The link carries the token in its fragment (`/{lang}/app/join#t=…`), so it never reaches a server
 * or edge log. When mail can reach a customer the link goes ONLY to the invited address: if that send fails, the invite
 * is withdrawn and the answer is 502 {error:"send_failed"}, never the link, so an inviter cannot accept an invite for an
 * address they do not control by making the send fail. When mail is not set up at all, the link is returned once to the
 * inviter to pass on (spec §6). Only the token's SHA-256 is stored, so it can never be shown again.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.invite.member");
  if (no) return no;
  const a = u.actor!;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; role?: unknown; lang?: unknown };
  const to = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const [perAccount, perIp, perAddress] = await Promise.all([
    allow(`team:invite:acct:${u.email}`, u.plan === "trial" ? PER_TRIAL_ACCOUNT_DAY : PER_ACCOUNT_DAY, 86400),
    allow(`team:invite:ip:${clientIp(req)}`, PER_IP_HOUR, 3600),
    // Keyed by a hash: the counter is about the address, and the address itself never becomes part of a key.
    validEmail(to) ? allow(`team:invite:to:${createHash("sha256").update(to).digest("hex")}`, PER_ADDRESS_DAY, 86400) : Promise.resolve(true),
  ]);
  if (!perAccount || !perIp || !perAddress) return rateLimited();
  const lang = b.lang === "ar" || b.lang === "en" ? b.lang : a.lang;
  // Decided once, before anything is created: with mail on, the link must reach the invited address or nobody.
  const byEmail = mailReady();
  const res = await createInvite(u, a, to, typeof b.role === "string" ? b.role : "", lang);
  if (!res.ok) return teamFail(res);

  const inv = res.invite;
  const link = `${ORIGIN()}/${inv.lang}/app/join#t=${res.token}`;
  if (byEmail) {
    const mail = inviteMail(inv, normalizeEmail(a.email), link);
    if (!(await sendEmail(inv.email, mail.subject, mail.text))) {
      await discardInvite(u.email, res.id);
      return Response.json({ error: "send_failed" }, { status: 502 });
    }
  }
  await tellOwner(u, a.name || a.email, byEmail);
  return Response.json({ ok: true, invite: { id: res.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt }, emailed: byEmail, ...(byEmail ? {} : { link }) });
}

/** DELETE /api/team/invite {id} → {ok}. `id` is the invite's SHA-256 from GET /api/team. Admins cancel member invites only. */
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.invite.cancel");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { id?: unknown };
  const res = await cancelInvite(u, u.actor!, typeof b.id === "string" ? b.id : "");
  if (!res.ok) return teamFail(res);
  return Response.json({ ok: true });
}
