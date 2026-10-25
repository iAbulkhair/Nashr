import { NextResponse } from "next/server";
import { currentUser, saveUser } from "@/lib/auth";
import { withUserLock } from "@/lib/credits";
import { forbid } from "@/lib/roles";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW, WORKSPACE_RENAMES_PER_HOUR } from "@/lib/rate";
import { cleanWorkspaceName } from "@/lib/workspace-name";

/**
 * PUT {name}: rename the session's workspace (rules 3115-3118). Owner only, checked here (`profile.account`, the same
 * gate as the account's phone and language), never only by the settings page hiding the card: an admin or a member gets
 * 403 and nothing is written. The account is the session's (`acct(u)`); nothing in the body names an account, and the
 * workspace handle (`w/{handle}`, derived from the account id) does not change.
 *
 * The name is cleaned by `cleanWorkspaceName` (control and bidi override characters removed, spaces folded, trimmed):
 * empty is 400 `required`, over 80 characters 400 `too_long`, both before any count or write. Then a bucket of 10
 * renames per account an hour (`rate:wsname:{acct}`, 429 `slow_down` with `Retry-After`), and the write under
 * `lock:user:{acct}` on the record as it is now (a whole-record save of the copy read at request start would put back a
 * stale balance, permissions.md section 5 item 18). A lock that stays taken answers 409 `busy` before anything is written.
 * The answer is the stored name.
 */
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "profile.account");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { name?: unknown };
  const checked = cleanWorkspaceName(b.name);
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  const aid = acct(u);
  if (!(await allow(accountKey.workspaceNameBucket(aid), WORKSPACE_RENAMES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  try {
    const name = await withUserLock(aid, async (x) => {
      x.workspaceName = checked.name;
      await saveUser(x);
      return x.workspaceName;
    });
    return NextResponse.json({ ok: true, name });
  } catch (e) {
    if (e instanceof Error && e.message === "user_lock_timeout") return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
}
