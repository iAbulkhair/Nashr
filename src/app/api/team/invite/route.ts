import { createHash } from "crypto";
import { currentUser, normalizeEmail, validEmail, type User } from "@/lib/auth";
import { notifyItem } from "@/lib/notifications";
import { mailReady, sendEmail } from "@/lib/notify";
import { appOrigin } from "@/lib/origin";
import { allow, clientIp } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { cancelInvite, createInvite, discardInvite, type Invite } from "@/lib/team";
import { rateLimited, teamFail, unauthorized } from "../respond";
import { acct } from "@/lib/account-id";

/**
 * Invites per account per day (lower on a free trial, which anyone can open with one signup), per IP per hour, and per
 * invited address per day across ALL accounts. Each answer says whether an address is free, and each emailed invite is
 * mail from the product's own domain to a stranger's address, so all four are metered.
 */
const PER_ACCOUNT_DAY = 20;
const PER_TRIAL_ACCOUNT_DAY = 5;
const PER_IP_HOUR = 30;
const PER_ADDRESS_DAY = 5;

/** The Editor role is stored as "member" until the contract release (rule 3751). */
const ROLE = { ar: { admin: "مدير", member: "محرر", viewer: "مشاهد" }, en: { admin: "an admin", member: "an editor", viewer: "a viewer" } } as const;

/**
 * The invitation email, in the invite's language. A fixed template: the only thing in it the sender chose is the
 * address of the login that sent it (a validated email, no spaces or line breaks). No display name and no brand name:
 * both are free text anyone can set at signup or on the brand form, and they would turn this email, sent from the
 * product's own verified domain to any address, into a relay for whatever text the sender wanted to put in it. The HTML
 * part (src/emails/team-invite.ts) takes the same three values and nothing else (rule 688); `sendEmail` renders it from
 * `context` (rule 1962).
 */
function inviteMail(inv: Invite, inviterEmail: string, link: string) {
  const context = { inviterEmail, role: inv.role, link };
  if (inv.lang === "ar") {
    return {
      subject: "دعوة للانضمام إلى فريق في ذكين",
      text: `مرحباً،\n\nدعاك مستخدم ذكين ${inviterEmail} للانضمام إلى حسابه في ذكين بصفة ${ROLE.ar[inv.role]}.\n\nافتح الرابط التالي خلال 7 أيام لتختار اسمك وكلمة مرورك:\n\n${link}\n\nالدعوة لهذا البريد وحده. إذا لم تتوقعها فتجاهل هذه الرسالة، ولن يتغير شيء.`,
      context,
    };
  }
  return {
    subject: "You are invited to join a team on Thakeen",
    text: `Hello,\n\nThe Thakeen user ${inviterEmail} invited you to join their account on Thakeen as ${ROLE.en[inv.role]}.\n\nOpen this link within 7 days to choose your name and password:\n\n${link}\n\nThe invitation is for this email address only. If you did not expect it, ignore this email and nothing changes.`,
    context,
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
    await notifyItem(acct(u), u.lang, {
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
 * POST /api/team/invite {email, role, lang?, brands?, approves?, addSeat?, seatHalalas?} → {ok, invite, emailed, link?, seatAdded?}. The
 * owner may invite any role, an admin editors and viewers only (role "editor" is the Editor, stored "member", rule 3751).
 * `brands` (a list of the account's own active brand ids, absent = every brand) and `approves` need `team.access` (rules
 * 3756, 3760). Over the seat limit the answer is 409 {error:"seats", used, limit, included, extra, unitSar, canBuy}; the
 * owner confirms and sends addSeat:true (paid seats, rules 3366-3369). On an active yearly subscription the 409 also carries
 * `charge` {months, baseHalalas, totalHalalas}, charged on the saved card when the owner confirms, before the seat exists
 * (rules 4040-4047), and only when the confirm sent that `totalHalalas` back as `seatHalalas` (rule 4050): 402 seat_declined, 502 seat_failed, 409 seat_busy / seat_pending / seat_changed, and `refunded: true`
 * on an answer whose paid seat was refunded; without a saved-card charge `canBuy` is false with `blocked` (rule 4049). The link carries the token in its fragment (`/{lang}/app/join#t=…`), so it never reaches a server
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
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; role?: unknown; lang?: unknown; brands?: unknown; approves?: unknown; addSeat?: unknown; seatHalalas?: unknown };
  const to = normalizeEmail(typeof b.email === "string" ? b.email : "");
  const [perAccount, perIp, perAddress] = await Promise.all([
    allow(`team:invite:acct:${u.email}`, u.plan === "trial" ? PER_TRIAL_ACCOUNT_DAY : PER_ACCOUNT_DAY, 86400),
    allow(`team:invite:ip:${clientIp(req)}`, PER_IP_HOUR, 3600),
    // Keyed by a hash: the counter is about the address, and the address itself never becomes part of a key.
    validEmail(to) ? allow(`team:invite:to:${createHash("sha256").update(to).digest("hex")}`, PER_ADDRESS_DAY, 86400) : Promise.resolve(true),
  ]);
  // The window of the bucket that refused, the day when a daily one did.
  if (!perAccount || !perIp || !perAddress) return rateLimited(!perAccount || !perAddress ? 86400 : 3600);
  const lang = b.lang === "ar" || b.lang === "en" ? b.lang : a.lang;
  // Decided once, before anything is created: with mail on, the link must reach the invited address or nobody.
  const byEmail = mailReady();
  // `addSeat: true` is the owner's confirmation of one paid seat (rules 3366-3369): only the literal true counts, and
  // createInvite still checks who acts, the plan and the count under the team lock. Without it, over the limit is a 409.
  const res = await createInvite(u, a, to, typeof b.role === "string" ? b.role : "", lang, { brands: b.brands, approves: b.approves }, { addSeat: b.addSeat === true, ...(typeof b.seatHalalas === "number" ? { seatHalalas: b.seatHalalas } : {}) });
  if (!res.ok) return teamFail(res);

  const inv = res.invite;
  const link = `${appOrigin()}/${inv.lang}/app/join#t=${res.token}`;
  if (byEmail) {
    const mail = inviteMail(inv, normalizeEmail(a.email), link);
    if (!(await sendEmail({ to: inv.email, subject: mail.subject, text: mail.text, template: "teamInvite", context: mail.context, locale: inv.lang }))) {
      await discardInvite(acct(u), res.id);
      return Response.json({ error: "send_failed" }, { status: 502 });
    }
  }
  await tellOwner(u, a.name || a.email, byEmail);
  return Response.json({ ok: true, invite: { id: res.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt }, emailed: byEmail, ...(byEmail ? {} : { link }), ...(res.seatAdded ? { seatAdded: true } : {}) });
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
