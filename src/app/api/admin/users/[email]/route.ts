import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { createSession, getUser, isAdmin, saveUser } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";
import { getUsage } from "@/lib/usage";
import { listConnections } from "@/lib/connectors/store";
import { listBrands, scopeFor } from "@/lib/brands";
import { listConversations } from "@/lib/conversations";
import { withUserLock } from "@/lib/credits";
import { wipeAccount } from "@/lib/account";
import { db } from "@/lib/db";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const { email } = await ctx.params;
  const u = await getUser(decodeURIComponent(email));
  if (!u) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const brands = await listBrands(u.email);
  const scopes = brands.map((b) => scopeFor(u.email, b.id));
  const tasks = (await Promise.all(scopes.map((s) => listTasks(s)))).flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const [brand, usage, connections, convs, referrals] = await Promise.all([
    getBrand(u.email),
    getUsage(u.email),
    listConnections(u.email),
    Promise.all(scopes.map((s) => listConversations(s))).then((x) => x.flat().length),
    db.lrange(`referrals:${u.email}`, 0, 99).then((x) => x.length),
  ]);
  const scores = tasks.filter((t) => t.quality).map((t) => t.quality!.score);
  const { passHash: _omit, ...safe } = u;
  void _omit;
  return NextResponse.json({
    ok: true, user: safe, brand, tasks, usage, connections, brands, conversations: convs, referrals,
    avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
  });
}

type Action = { action: "suspend" | "unsuspend" | "extendTrial" | "resetPassword" | "delete" | "impersonate" | "setLang"; days?: number; lang?: "ar" | "en"; reason?: string };

/** POST actions on one user. Every action is logged to admin:log. */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const { email: raw } = await ctx.params;
  const email = decodeURIComponent(raw);
  const u = await getUser(email);
  if (!u) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Action;
  const log = (what: string, extra: Record<string, unknown> = {}) => db.lpush("admin:log", JSON.stringify({ actor: "founder", email, what, reason: (b.reason ?? "").slice(0, 200) || undefined, ...extra, at: new Date().toISOString() }));

  switch (b.action) {
    case "suspend":
    case "unsuspend": {
      const user = await withUserLock(email, async (x) => { x.suspended = b.action === "suspend"; await saveUser(x); return x; });
      await log(b.action);
      return NextResponse.json({ ok: true, suspended: !!user.suspended });
    }
    case "extendTrial": {
      const days = Math.max(1, Math.min(90, Math.trunc(b.days ?? 7)));
      const prevTrial = String(u.trialEnds);
      const user = await withUserLock(email, async (x) => {
        const base = new Date(x.trialEnds).getTime() > Date.now() ? new Date(x.trialEnds) : new Date();
        x.trialEnds = new Date(base.getTime() + days * 864e5).toISOString();
        await saveUser(x);
        return x;
      });
      await log(`extendTrial ${days}d`, { before: prevTrial, after: user.trialEnds });
      return NextResponse.json({ ok: true, trialEnds: user.trialEnds });
    }
    case "resetPassword": {
      const temp = randomBytes(6).toString("base64url").slice(0, 10) + "!";
      await withUserLock(email, async (x) => { x.passHash = await bcrypt.hash(temp, 10); await saveUser(x); });
      await log("resetPassword");
      // Shown once to the admin; never stored in clear.
      return NextResponse.json({ ok: true, tempPassword: temp });
    }
    case "setLang": {
      if (b.lang !== "ar" && b.lang !== "en") return NextResponse.json({ ok: false, error: "bad_lang" }, { status: 400 });
      await withUserLock(email, async (x) => { x.lang = b.lang!; await saveUser(x); });
      return NextResponse.json({ ok: true });
    }
    case "impersonate": {
      const jar = await cookies();
      const mine = jar.get("nashr_session")?.value;
      if (mine) jar.set("nashr_return", mine, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 2 });
      jar.set("nashr_impersonate", email, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 2 });
      await createSession(email);
      await log("impersonate", { expiresInMin: 120 });
      return NextResponse.json({ ok: true, redirect: `/${u.lang}/app` });
    }
    case "delete": {
      await wipeAccount(email);
      await log("delete");
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  }
}
