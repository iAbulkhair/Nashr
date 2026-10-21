import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { PUSH_CALLS_PER_HOUR, pushLogin, pushText } from "@/lib/push";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/push/latest (rule 2567): what a woken worker (public/sw.js) shows, read with the device's own session. The
 * title is the app's name and the body one agent's name and state, in the person's language; never a draft, a brand
 * or a count. A 401 tells the worker the device has no session any more, so it unsubscribes (rule 2563).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  const login = pushLogin(u.actor);
  if (!login) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (!(await allow(accountKey.pushBucket(login), PUSH_CALLS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const lang = u.actor?.lang === "en" ? "en" : "ar";
  const last = await db.get<unknown>(accountKey.pushLast(login));
  return NextResponse.json({ ok: true, ...pushText(last, lang) }, { headers: NO_STORE });
}
