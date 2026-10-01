import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { adminActor, createSession, getUser, isAdmin, keyImpBinding, revokeSessions, revokeTeamSessions, saveUser, normalizeEmail, sessionCookie } from "@/lib/auth";
import { revokeAllMcp } from "@/lib/mcp";
import { getBrand, listTasks } from "@/lib/brand";
import { getUsage } from "@/lib/usage";
import { listConnections } from "@/lib/connectors/store";
import { listBrands, scopeFor } from "@/lib/brands";
import { listConversations } from "@/lib/conversations";
import { withUserLock } from "@/lib/credits";
import { wipeAccount } from "@/lib/account";
import { CAPS, db, pushCapped } from "@/lib/db";
import { listActivity } from "@/lib/activity";
import { cookies } from "next/headers";
import { forceRemoveMember, getMember, onRoster } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const { email } = await ctx.params;
  const u = await getUser(decodeURIComponent(email));
  if (!u) {
    // Member logins never enter users:all, so the list cannot show them: an address is looked up here instead, which is
    // how support finds (and can remove, below) a member login holding an address its real owner wants to sign up with.
    const m = await getMember(decodeURIComponent(email));
    if (!m) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const [owner, listed] = await Promise.all([getUser(m.memberOf), onRoster(m.memberOf, m.email)]);
    return NextResponse.json({
      ok: true, kind: "member",
      member: { email: m.email, name: m.name, role: m.role, memberOf: m.memberOf, invitedBy: m.invitedBy, acceptedAt: m.acceptedAt, disabled: m.disabled ?? null, ownerExists: !!owner, onRoster: listed },
    });
  }
  const brands = await listBrands(u.email);
  const scopes = brands.map((b) => scopeFor(u.email, b.id));
  const tasks = (await Promise.all(scopes.map((s) => listTasks(s)))).flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const [brand, usage, connections, convs, referrals, activity] = await Promise.all([
    getBrand(u.email),
    getUsage(u.email),
    listConnections(u.email),
    Promise.all(scopes.map((s) => listConversations(s))).then((x) => x.flat().length),
    db.lrange(`referrals:${u.email}`, 0, 99).then((x) => x.length),
    // The latest 100 activity rows of each brand, every brand in parallel (the scopes come from the account's own list).
    Promise.all(brands.map((b, i) => listActivity(scopes[i], { limit: 100 }).then((p) => ({ brand: b.id, name: b.name, rows: p.rows })))),
  ]);
  const scores = tasks.filter((t) => t.quality).map((t) => t.quality!.score);
  const { passHash: _omit, ...safe } = u;
  void _omit;
  return NextResponse.json({
    ok: true, user: safe, brand, tasks, usage, connections, brands, conversations: convs, referrals, activity,
    avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
  });
}

type Action = { action: "suspend" | "unsuspend" | "extendTrial" | "resetPassword" | "delete" | "impersonate" | "setLang" | "removeMember"; days?: number; lang?: "ar" | "en"; reason?: string };

/** POST actions on one user. Every action is logged to admin:log with WHO did it: the founder's email, or "key". */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const { email: raw } = await ctx.params;
  const email = normalizeEmail(decodeURIComponent(raw)); // the same normalized key for lookup, locks and deletion
  const u = await getUser(email);
  const b = (await req.json().catch(() => ({}))) as Action;
  const log = (what: string, extra: Record<string, unknown> = {}) => pushCapped("admin:log", JSON.stringify({ actor: who, email, what, reason: (b.reason ?? "").slice(0, 200) || undefined, ...extra, at: new Date().toISOString() }), CAPS.adminLog);
  if (!u) {
    // A member login: the one action is removing it (the owner's own removal, done by support), which frees the address.
    const m = await getMember(email);
    if (!m) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    if (b.action !== "removeMember") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
    if (!(await forceRemoveMember(email))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await log("removeMember", { memberOf: m.memberOf, role: m.role });
    return NextResponse.json({ ok: true });
  }

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
      // The owner's sessions and every member's: a founder reset answers "someone else has this account".
      await withUserLock(email, async (x) => { x.passHash = await bcrypt.hash(temp, 10); revokeSessions(x); revokeTeamSessions(x); await saveUser(x); });
      await revokeAllMcp(email);
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
      if (mine) jar.set("nashr_return", mine, await sessionCookie(60 * 60 * 2));
      jar.set("nashr_impersonate", email, await sessionCookie(60 * 60 * 2));
      // The session record carries the founder (`imp`): it resolves to actor kind "founder", which never passes the
      // founder console and is refused account delete, password change, invites, role changes, MCP tokens and OAuth.
      // Opened with the console key: the session is tied to that key and key session, so "End key session" and a key
      // rotation end it too (rule 319).
      const bind = who === "key" ? await keyImpBinding() : null;
      await createSession(email, 60 * 60 * 2, { imp: who, ...(bind ?? {}) });
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
