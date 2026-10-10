import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CAPS, db, pushCapped } from "@/lib/db";
import { sessionCookie, type Session } from "@/lib/auth";
import { appOrigin } from "@/lib/origin";
import { allow, clientIp, IMPERSONATE_STOP_PER_IP, IMPERSONATE_STOP_WINDOW, retryLater } from "@/lib/rate";

/**
 * POST /api/admin/impersonate (stop): restore the founder's own session saved when impersonation started.
 *
 * Public by necessity (the impersonated session is a customer's, not an admin's), so it acts only on the caller's own
 * cookies and trusts none of their values. The founder audit log (`admin:log`) is written only when the session being
 * burned is a real impersonation session: its server record carries `imp` (the founder, written by the console), and
 * the entry names that founder and the record's own email. The `nashr_impersonate` cookie is a display hint and is
 * never logged, so a visitor who sets it cannot push rows into the capped log and wipe the real ones. Rules 540-542. The redirect goes to `appOrigin()`, never
 * `req.url`, which is the internal address behind the Hostinger proxy (rule 904).
 */
export async function POST(req: Request) {
  if (!(await allow(`impstop:ip:${clientIp(req)}`, IMPERSONATE_STOP_PER_IP, IMPERSONATE_STOP_WINDOW))) {
    return retryLater({ error: "slow_down" }, IMPERSONATE_STOP_WINDOW);
  }
  const lang = (await req.formData().catch(() => null))?.get("lang") === "en" ? "en" : "ar";
  const jar = await cookies();
  const back = jar.get("nashr_return")?.value;
  const who = jar.get("nashr_impersonate")?.value;
  // Burn the impersonated session so it cannot be reused after the founder returns. Its record names the founder (`imp`).
  const temp = jar.get("nashr_session")?.value;
  const rec = temp && temp !== back ? await db.get<string | Session>(`session:${temp}`) : null;
  const imp = rec && typeof rec === "object" && typeof rec.imp === "string" && rec.imp ? rec : null;
  if (temp && temp !== back && (imp || who)) await db.del(`session:${temp}`);
  if (back && (await db.get(`session:${back}`))) jar.set("nashr_session", back, await sessionCookie(60 * 60 * 24 * 30));
  else jar.delete("nashr_session");
  jar.delete("nashr_return");
  jar.delete("nashr_impersonate");
  if (imp) await pushCapped("admin:log", JSON.stringify({ actor: imp.imp, email: imp.email, what: "impersonate:stop", at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.redirect(new URL(`/${lang}/admin/users`, appOrigin()), 303);
}
