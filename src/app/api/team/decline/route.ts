import { getUser } from "@/lib/auth";
import { globalKey } from "@/lib/keys";
import { notifyItem } from "@/lib/notifications";
import { allow, clientIp } from "@/lib/rate";
import { declineInvite, isTeamLockTimeout, type TeamRole } from "@/lib/team";
import { busy, rateLimited, teamFail } from "../respond";
import { acct } from "@/lib/account-id";
import type { AccountId } from "@/lib/keys";

/** Per IP, per 15 minutes, as accepting (`ACCEPTS` in ../accept/route.ts). The token is 256 bits: this bounds noise, not guessing. */
const DECLINES = 10;
const WINDOW_S = 900;

/** The owner's bell (rule 3122). Never fails the request: the invite is already gone. */
async function tellOwner(d: { aid: AccountId; email: string; role: TeamRole }) {
  try {
    const owner = await getUser(d.aid);
    if (!owner) return;
    const ar = owner.lang === "ar";
    const role = ar ? (d.role === "admin" ? "مدير" : "عضو") : d.role;
    await notifyItem(acct(owner), owner.lang, {
      kind: "info",
      title: ar ? `${d.email} رفض الدعوة` : `${d.email} declined your invitation`,
      body: ar ? `لن ينضم ${d.email} بصفة ${role}، وأصبح المقعد متاحًا. تدير الأعضاء والدعوات من صفحة «الأعضاء».` : `${d.email} will not join as ${role}, and the seat is free again. Manage members and invitations on the Members page.`,
      href: "team",
    });
  } catch (e) {
    console.error("team decline notification failed", e);
  }
}

/**
 * POST /api/team/decline {token} (rules 3119-3122). Public, like accept: the invite token IS the credential, read from
 * the body (the join page takes it from the link's fragment), never from a URL, and the invite is found from its hash
 * alone (`declineInvite`), never from an account, an address or an id in the request. A signed-in person may decline
 * too; the session plays no part and is left as it is.
 *
 * Per IP, 10 an IP per 15 minutes (`rate:team:decline:ip:{ip}`, 429 `rate_limited`). A token that is malformed, unknown,
 * expired, already used or being accepted right now answers 400 `invalid` with nothing changed; a team lock that stays
 * taken answers 409 `busy`. On success the invite is gone (record, index, inbox), the team log has one `invite_declined`
 * row, and the owner's bell says who declined. The answer is `{ok:true}`: nothing about the account reaches the browser.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof b.token === "string" ? b.token : "";
  if (!(await allow(globalKey.inviteDeclineBucket(clientIp(req)), DECLINES, WINDOW_S))) return rateLimited(WINDOW_S);
  let res: Awaited<ReturnType<typeof declineInvite>>;
  try {
    res = await declineInvite(token);
  } catch (e) {
    if (isTeamLockTimeout(e)) return busy();
    throw e;
  }
  if (!res.ok) return teamFail(res);
  await tellOwner(res.declined);
  return Response.json({ ok: true });
}
