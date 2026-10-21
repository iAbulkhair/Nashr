import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { freshProof } from "@/lib/fresh-proof";
import { MULTI_ORG } from "@/lib/multi-org";
import { mailReady, sendEmail } from "@/lib/notify";
import { appOrigin } from "@/lib/origin";
import { actingLogin } from "@/lib/own-password";
import { personKey } from "@/lib/keys";
import { getPerson } from "@/lib/person";
import { allow } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { isTeamLockTimeout } from "@/lib/team";
import { cancelTransfer, offerTransfer, withdrawOffer } from "@/lib/transfer";
import { handleOf } from "@/lib/ws-handle";
import { busy, rateLimited, unauthorized } from "../respond";

export const dynamic = "force-dynamic";

/** Offers per owner per day: each one mails a stranger-facing link from the product's domain. */
const OFFERS_PER_DAY = 5;

/**
 * The offer mail, in the receiving admin's language. Fixed text: the only value the sender chose is their own validated
 * address, never a workspace or brand name (free text that would turn the mail into a relay, as for invites). The token
 * rides in the link's fragment, so it never reaches a server or edge log.
 */
function offerMail(lang: "ar" | "en", from: string) {
  if (lang === "ar") {
    const title = "عرض نقل ملكية مساحة عمل في ذكين";
    const paragraphs = [
      `يعرض عليك ${from} أن تصبح مالك مساحة عمل أنت مشرف فيها على ذكين.`,
      "سجّل دخولك بحسابك ثم افتح الرابط خلال 7 أيام واضغط «اقبل». بعد القبول تصبح أنت المالك المسؤول عن الخطة والدفع، ويبقى المالك الحالي مشرفاً.",
      "إذا لم تتوقع هذا العرض فتجاهل الرسالة، ولن يتغير شيء.",
    ];
    return { subject: title, title, paragraphs, label: "افتح العرض" };
  }
  const title = "An offer to take over a workspace on Thakeen";
  const paragraphs = [
    `${from} offers to make you the owner of a workspace on Thakeen where you are an admin.`,
    "Sign in with your own login, then open the link within 7 days and press Accept. Once you accept you own the plan and the payments, and the current owner stays on as an admin.",
    "If you did not expect this offer, ignore this email and nothing changes.",
  ];
  return { subject: title, title, paragraphs, label: "Open the offer" };
}

const fail = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST /api/team/transfer {email, password, code?} → {ok, offer: {email, expiresAt}} (multi-workspace M3, rules 2128,
 * 2750): the owner offers the account to one of its enabled admins. The owner's own session only (`team.transfer`:
 * never an impersonation or an AI client's token), their own password and, while two-step sign-in is on, a fresh
 * authenticator code (a recovery code is refused here). The mailed link is the only copy of the token: a send that fails
 * withdraws the offer (502 `send_failed`), and without mail set up nothing is offered (409 `mail_unavailable`). With
 * `MULTI_ORG` off, 404.
 */
export async function POST(req: Request) {
  if (!MULTI_ORG) return fail("not_found", 404);
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.transfer");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me || me.kind !== "owner") return fail("forbidden", 403);
  if (!(await allow(personKey.xferOfferBucket(me.pid), OFFERS_PER_DAY, 86400))) return rateLimited(86400);
  if (!mailReady()) return fail("mail_unavailable", 409);
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown; code?: unknown };
  const person = await getPerson(me.pid);
  if (!person) return fail("forbidden", 403);
  const proof = await freshProof(req, person, me.bornAt, b, { recovery: false });
  if (proof) return proof;
  try {
    const r = await offerTransfer(u, me.pid, b.email);
    if (!r.ok) return fail(r.error, r.error === "invalid_email" ? 400 : r.error === "forbidden" ? 403 : 409);
    const link = `${appOrigin()}/${r.to.lang}/app/workspaces#xfer=${handleOf(u)}.${r.token}`;
    const m = offerMail(r.to.lang, me.email);
    const sent = await sendEmail({ to: r.to.email, subject: m.subject, text: [...m.paragraphs, link].join("\n\n"), template: "notice", context: { title: m.title, paragraphs: m.paragraphs, cta: { label: m.label, href: link } }, locale: r.to.lang }).catch(() => false);
    if (!sent) {
      await withdrawOffer(u, r.token);
      return fail("send_failed", 502);
    }
    return NextResponse.json({ ok: true, offer: { email: r.to.email, expiresAt: r.expiresAt } });
  } catch (e) {
    if (isTeamLockTimeout(e)) return busy();
    throw e;
  }
}

/** DELETE /api/team/transfer → {ok, cancelled}: the owner withdraws the pending offer; its mailed link stops working. */
export async function DELETE() {
  if (!MULTI_ORG) return fail("not_found", 404);
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "team.transfer");
  if (no) return no;
  try {
    return NextResponse.json({ ok: true, cancelled: await cancelTransfer(u) });
  } catch (e) {
    if (isTeamLockTimeout(e)) return busy();
    throw e;
  }
}
