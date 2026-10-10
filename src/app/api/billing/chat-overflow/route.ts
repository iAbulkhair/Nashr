import { NextResponse } from "next/server";
import { currentUser, saveUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { withUserLock } from "@/lib/credits";
import { chatStatus, overflowAvailable } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { allow, retryLater } from "@/lib/rate";

/**
 * POST {on: boolean}: the owner's choice for when the month's chat messages run out (src/lib/chat-allowance.ts). Off
 * (the default) pauses chat until the next month; on continues on credits while the balance covers
 * `chatOverflowHold()` credits, each message billed its metered cost at the floor rate, at most that. Owner only (`billing`): it decides how the
 * account's credits are spent. A real boolean only; never on a trial (409 `trial`). Written under the user lock, so it
 * cannot undo a balance change saved at the same time. Answers the chat status after the change.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "billing");
  if (no) return no;
  if (!(await allow(`chatovf:${u.email}`, 30, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { on?: unknown };
  if (typeof b.on !== "boolean") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (!overflowAvailable(u)) return NextResponse.json({ ok: false, error: "trial" }, { status: 409 });
  const on = b.on;
  const saved = await withUserLock(u.email, async (acc) => {
    if (on) acc.chatOverflow = true;
    else delete acc.chatOverflow;
    await saveUser(acc);
    return acc;
  });
  return NextResponse.json({ ok: true, chat: await chatStatus(saved, route("chat").model) });
}
