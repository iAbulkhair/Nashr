import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** POST /api/admin/impersonate (stop): restore the founder's own session saved when impersonation started. */
export async function POST(req: Request) {
  const lang = (await req.formData().catch(() => null))?.get("lang") === "en" ? "en" : "ar";
  const jar = await cookies();
  const back = jar.get("nashr_return")?.value;
  const who = jar.get("nashr_impersonate")?.value;
  // Burn the impersonated session so it cannot be reused after the founder returns.
  const temp = jar.get("nashr_session")?.value;
  if (who && temp && temp !== back) await db.del(`session:${temp}`);
  if (back && (await db.get(`session:${back}`))) jar.set("nashr_session", back, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  else jar.delete("nashr_session");
  jar.delete("nashr_return");
  jar.delete("nashr_impersonate");
  if (who) await db.lpush("admin:log", JSON.stringify({ actor: "founder", email: who, what: "impersonate:stop", at: new Date().toISOString() }));
  return NextResponse.redirect(new URL(`/${lang}/app/admin`, req.url), 303);
}
