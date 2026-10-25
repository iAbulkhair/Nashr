import { NextResponse } from "next/server";
import { allow, clientIp, sameSecret, retryLater } from "@/lib/rate";
import { createAdminSession, destroyAdminSession } from "@/lib/auth";
import { checkCode, openStepUp, secondFactorStatus } from "@/lib/admin-2fa";
import { adminAudit } from "@/lib/admin-audit";
import { consoleWriteRefusal } from "@/lib/console-origin";

/**
 * The founder console's key form: break-glass only once staff logins exist (rules 1645, 1646). A right key opens a
 * server-side key session (src/lib/auth.ts `createAdminSession`) that ends after 15 minutes without an admin request
 * and 12 hours after the key entry at most: the cookie carries a random id, never the key. DELETE ends it on the server.
 *
 * Once the console code (`admin:2fa`) is enrolled, the same submit needs the key AND `code`: the 6 digits from the
 * console's authenticator (which also opens a step-up for the new session), or the recovery code, which, as before,
 * removes the enrolment. A wrong or missing code is the same 401 as a wrong key, so the form never tells a right key
 * apart. Every sign-in here writes a `key.login` row. The `x-admin-key` header is for scripts and never opens a session.
 * The typed key and the stored one are compared with surrounding spaces trimmed (rule 3705).
 */
export async function POST(req: Request) {
  const foreign = consoleWriteRefusal(req);
  if (foreign) return foreign;
  // Five attempts per 15 minutes per IP: the key must not be guessable by brute force.
  if (!(await allow(`adminkey:${clientIp(req)}`, 5, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const { key, code } = (await req.json().catch(() => ({}))) as { key?: unknown; code?: unknown };
  // Rule 3705: spaces around a pasted key (and around the stored value) never make a right key wrong.
  if (typeof key !== "string" || !sameSecret(key.trim(), process.env.WAITLIST_ADMIN_KEY?.trim())) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let factor: "none" | "totp" | "recovery" = "none";
  if ((await secondFactorStatus()).enrolled) {
    const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
    if (!typed) return NextResponse.json({ ok: false }, { status: 401 });
    const r = await checkCode(req, typed);
    if (!r.ok) return r.res.status === 429 ? r.res : NextResponse.json({ ok: false }, { status: 401 });
    factor = r.via;
  }
  const id = await createAdminSession();
  if (factor === "totp") await openStepUp("key", undefined, id);
  await adminAudit({ actor: "key", via: "key", section: "system", action: "key.login", target: "console", what: `key:login (break-glass, factor ${factor})`, extra: { factor } });
  return NextResponse.json({ ok: true, ...(factor === "recovery" ? { recovered: true } : {}) });
}

export async function DELETE() {
  await destroyAdminSession();
  return NextResponse.json({ ok: true });
}
