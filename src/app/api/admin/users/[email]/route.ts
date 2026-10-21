import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { ADMIN_SESSION_IDLE, adminActor, createSession, emailVerified, getLogin, getUser, isAdmin, keyImpBinding, revokeTeamSessions, saveUser, normalizeEmail, sessionCookie, sessionRecord, viaOf, actorInfo } from "@/lib/auth";
import { sha } from "@/lib/staff";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { revokeAllMcp } from "@/lib/mcp";
import { revokeBooks } from "@/lib/booking-token";
import { IMPERSONATE_COOKIE, RETURN_COOKIE, SESSION_COOKIE, readCookie } from "@/lib/cookie-names";
import { revokeFeeds } from "@/lib/feed-token";
import { revokeCalendarLinks } from "@/lib/secretary-gcal";
import { getBrand, listTasks } from "@/lib/brand";
import { getUsage } from "@/lib/usage";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { entitlementView } from "@/lib/entitlements";
import { chatUsdPerMessage } from "@/lib/admin-stats";
import { listConnections } from "@/lib/connectors/store";
import { listBrands, scopeFor } from "@/lib/brands";
import { listConversations } from "@/lib/conversations";
import { withUserLock } from "@/lib/credits";
import { isPersonLockTimeout, updatePerson, withPersonLock } from "@/lib/person";
import { wipeAccount } from "@/lib/account";
import { db } from "@/lib/db";
import { listActivity } from "@/lib/activity";
import { cookies } from "next/headers";
import { forceRemoveMember, getMember, isTeamLockTimeout, membersKey, onRoster } from "@/lib/team";
import { unfinishedRefunds } from "@/lib/partners";
import { sendVerifyCode, verifySendRefusal, VERIFY } from "@/lib/verify-email";
import { TRIAL_EXTEND_MAX_DAYS, parseImpersonateMinutes } from "@/lib/admin-input";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";
import { isSuspended, parseSuspendFor, suspensionEnd, suspensionExpired } from "@/lib/suspension";
import { endExpiredSuspension } from "@/lib/suspension-server";
import { accountKey } from "@/lib/keys";
import { acct } from "@/lib/account-id";
import { aidOf, getMembership, ownerOf } from "@/lib/membership";
import { appHref } from "@/lib/ws-path";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const { email } = await ctx.params;
  // The console names an owner by its sign-in address: resolved as a login (rule 1982), never read as an account key.
  const login = await getLogin(decodeURIComponent(email));
  let u = login?.kind === "owner" ? login.user : null;
  // A suspension whose end date passed is cleared and logged when staff open the account (rule 2073), then read again.
  if (u && suspensionExpired(u) && (await endExpiredSuspension(acct(u)))) u = (await getUser(acct(u))) ?? u;
  if (!u) {
    // Member logins never enter users:all, so the list cannot show them: an address is looked up here instead, which is
    // how support finds (and can remove, below) a member login holding an address its real owner wants to sign up with.
    const m = await getMember(decodeURIComponent(email));
    if (!m) {
      // A person known only through membership rows (multi-workspace M1: test persons; real ones from M2) has no member
      // record: shown from the person and the membership sign-in would open, read only. Its person id and its
      // inviter's are never shown (a `p_` id is not an address).
      if (login?.kind !== "member" || !login.acct) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      const ms = await getMembership(login.acct, login.pid);
      return NextResponse.json({
        ok: true, kind: "member",
        member: { email: login.person.email, name: login.person.name, role: ms?.role ?? null, memberOf: login.acct, invitedBy: "", acceptedAt: ms?.acceptedAt ?? "", disabled: ms?.disabled ?? null, ownerExists: !!login.owner, onRoster: !!ms },
      });
    }
    const [owner, listed] = await Promise.all([getUser(m.memberOf), onRoster(m.memberOf, m.email)]);
    return NextResponse.json({
      ok: true, kind: "member",
      member: { email: m.email, name: m.name, role: m.role, memberOf: m.memberOf, invitedBy: m.invitedBy, acceptedAt: m.acceptedAt, disabled: m.disabled ?? null, ownerExists: !!owner, onRoster: listed },
    });
  }
  const brands = await listBrands(acct(u));
  const scopes = brands.map((b) => scopeFor(acct(u), b.id));
  const tasks = (await Promise.all(scopes.map((s) => listTasks(s)))).flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const [brand, usage, chat, connections, convs, referrals, activity, unfinished, ent] = await Promise.all([
    getBrand(acct(u)),
    getUsage(acct(u)),
    // The chat allowance (a trial's for the whole trial, which the month's usage does not keep): the raw count
    // (`counted`), the messages continued on credits this month and the credits they were billed. Rule 316.
    chatStatus(u, route("chat").model),
    listConnections(acct(u)),
    Promise.all(scopes.map((s) => listConversations(s))).then((x) => x.flat().length),
    db.lrange(accountKey.referrals(acct(u)), 0, 99).then((x) => x.length),
    // The latest 100 activity rows of each brand, every brand in parallel (the scopes come from the account's own list).
    Promise.all(brands.map((b, i) => listActivity(scopes[i], { limit: 100 }).then((p) => ({ brand: b.id, name: b.name, rows: p.rows })))),
    // Packs whose refund is not on their payment yet: the Top-ups block offers "Finish refund" on them (rule 465).
    unfinishedRefunds(u),
    // What the plan includes, what the account used, when it resets and the video grant marked expired or not (rule 784). It
    // reads the chat status again (once above for `chat`, once in the view; accepted), in this same `Promise.all`.
    entitlementView(u),
  ]);
  const scores = tasks.filter((t) => t.quality).map((t) => t.quality!.score);
  const { passHash: _omit, suspended: _stored, ...rest } = u;
  void _omit;
  void _stored;
  // The console reads the state as it is now (rule 2074): `suspended` true only while it blocks, and its end date, if any.
  const safe = { ...rest, suspended: isSuspended(u), suspendedUntil: isSuspended(u) ? suspensionEnd(u) : null };
  return NextResponse.json({
    ok: true, user: safe, brand, tasks, usage, chat, connections, brands, conversations: convs, referrals, activity, unfinishedRefunds: unfinished, entitlements: ent,
    // What one chat message cost this month, over every message sent (the raw count and those on credits), as the list shows.
    chatUsdPerMsg: chatUsdPerMessage(usage.byKind.chat?.usd ?? 0, chat),
    avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
  });
}

type Action = { action: "suspend" | "unsuspend" | "extendTrial" | "resetPassword" | "delete" | "impersonate" | "setLang" | "removeMember" | "resendVerification"; days?: number; lang?: "ar" | "en"; reason?: string; minutes?: unknown; for?: unknown; date?: unknown };

/**
 * Run a write that takes the person lock: a lock held for the whole wait answers 409 `busy` (the lock is taken before the
 * first write, so nothing was written); null when the write ran.
 */
async function personWrite(fn: () => Promise<unknown>): Promise<NextResponse | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (isPersonLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
}

/** POST actions on one user. Every action is logged to admin:log with WHO did it: the founder's email, or "key". */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const { email: raw } = await ctx.params;
  const email = normalizeEmail(decodeURIComponent(raw)); // the same normalized key for lookup, locks and deletion
  const login = await getLogin(email);
  const u = login?.kind === "owner" ? login.user : null;
  const b = (await req.json().catch(() => ({}))) as Action;
  // Every action here asks a reason in the console, so the server asks it too (rule 1185).
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const log = (what: string, extra: Record<string, unknown> = {}) => {
    const { before, after, action, ...rest } = extra;
    return adminAudit({ actor: who, via: viaOf(req), section: "users", target: email, what, reason: b.reason, before, after, ...(typeof action === "string" ? { action } : {}), ...(Object.keys(rest).length ? { extra: rest } : {}) });
  };
  if (!u) {
    // A member login: the one action is removing it (the owner's own removal, done by support), which frees the address.
    // A person with no member record (multi-workspace M1, rule 2130) is the membership the login resolves to, as GET shows
    // it: the record and that membership are read in ONE round.
    const [m, ms] = await Promise.all([getMember(email), login?.kind === "member" && login.acct ? getMembership(login.acct, login.pid) : null]);
    const at = m ? { memberOf: m.memberOf, role: m.role } : ms ? { memberOf: ms.aid, role: ms.role } : null;
    if (!at) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    if (b.action !== "removeMember") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
    // The person left with nothing is deleted under `lock:person:{pid}` (multi-workspace M1): a person, login or member
    // lock timeout is a 409, and a retry finishes the clean-up (every step is a delete). Not `personWrite`: the membership
    // may be gone already.
    let removed: boolean;
    try {
      removed = await forceRemoveMember(email);
    } catch (e) {
      if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
      throw e;
    }
    if (!removed) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    await log("removeMember", at);
    return NextResponse.json({ ok: true });
  }

  // The account the address signs in to (rule 1980): every account key below, never the address from the path.
  const id = acct(u);
  switch (b.action) {
    case "suspend":
    case "unsuspend": {
      // Rule 2070: staff pick no end date, 7 days, 30 days or a date; a request without `for` keeps the old meaning (none).
      const pick = b.action === "suspend" ? parseSuspendFor(b.for, b.date) : null;
      if (pick && !pick.ok) return NextResponse.json({ ok: false, error: pick.error }, { status: 400 });
      const state = (x: { suspended?: unknown }) => ({ suspended: isSuspended(x), until: isSuspended(x) ? suspensionEnd(x) : null });
      const before = state(u);
      // Unsuspend writes `false`; suspend writes `true` or `{ until }`, the whole field, never a stale end date (rule 2070).
      const user = await withUserLock(id, async (x) => { x.suspended = pick?.ok ? pick.value : false; await saveUser(x); return x; });
      const after = state(user);
      await log(b.action, { before, after });
      return NextResponse.json({ ok: true, suspended: after.suspended, suspendedUntil: after.until });
    }
    case "extendTrial": {
      const days = Math.max(1, Math.min(TRIAL_EXTEND_MAX_DAYS, Math.trunc(b.days ?? 7)));
      const prevTrial = String(u.trialEnds);
      const user = await withUserLock(id, async (x) => {
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
      // The password and the owner's session stamp are the owner PERSON's (multi-workspace M1, rule 2132: `updatePerson`,
      // mirrored to a legacy owner's account); the team stamp is the account's. Person lock, then user lock (rule 2139).
      const pid = ownerOf(u);
      const passHash = await bcrypt.hash(temp, 10);
      const held = await personWrite(() => withPersonLock(pid, () => withUserLock(id, async (x) => {
        revokeTeamSessions(x);
        await saveUser(x);
        await updatePerson(pid, { passHash, sessionsAfter: new Date().toISOString() }, { personLocked: true, userLocked: aidOf(x) });
      })));
      if (held) return held;
      // The owner's calendar feed and booking links and every member's, as every member's session just ended.
      const roster = await db.smembers(membersKey(id));
      await Promise.all([revokeAllMcp(id), revokeFeeds([u.email, ...roster]), revokeBooks([u.email, ...roster]), revokeCalendarLinks(id)]);
      await log("resetPassword");
      // Shown once to the admin; never stored in clear.
      return NextResponse.json({ ok: true, tempPassword: temp });
    }
    case "setLang": {
      if (b.lang !== "ar" && b.lang !== "en") return NextResponse.json({ ok: false, error: "bad_lang" }, { status: 400 });
      const was = u.lang;
      // The account's language and its owner person's (rule 2132), person lock first (rule 2139).
      const pid = ownerOf(u);
      const lang = b.lang;
      const held = await personWrite(() => withPersonLock(pid, () => withUserLock(id, async (x) => {
        x.lang = lang;
        await saveUser(x);
        await updatePerson(pid, { lang }, { personLocked: true, userLocked: aidOf(x) });
      })));
      if (held) return held;
      await log(`setLang ${b.lang}`, { before: { lang: was }, after: { lang: b.lang } });
      return NextResponse.json({ ok: true });
    }
    case "impersonate": {
      // The founder picks 15, 60 or 120 minutes in the console (rule 1177); a request without `minutes` keeps the old
      // two hours. The session record, its cookie and the helper cookies all end at that moment.
      const minutes = parseImpersonateMinutes(b.minutes);
      if (!minutes) return NextResponse.json({ ok: false, error: "bad_minutes" }, { status: 400 });
      const ttl = minutes * 60;
      // One view at a time (rule 1350, C-015). While this browser already shows a customer's account, its `thakeen_session`
      // is that impersonation: a second one would save it as `thakeen_return`, and "Stop" would hand the founder the first
      // customer's session instead of their own. Refused before the audit row, so a refused start logs nothing.
      const jar = await cookies();
      const mine = readCookie(jar, SESSION_COOKIE);
      const current = mine ? await sessionRecord(mine) : null;
      if (current && typeof current === "object" && current.imp) return NextResponse.json({ ok: false, error: "impersonation_active" }, { status: 409 });
      // Opened with the console key: the session is tied to that key and key session, so "End key session" and a key
      // rotation end it too (rule 429).
      const bind = who === "key" ? await keyImpBinding() : null;
      // Opened from a staff session (rule 1648): the view carries that session's hash and ends with it.
      const staffCookie = viaOf(req) === "staff" ? actorInfo(req)?.staffCookie : undefined;
      const ss = staffCookie ? sha(staffCookie) : undefined;
      // The audit row is written BEFORE the session exists (rule 1187): when the log cannot be written, no view of the
      // account opens. `minutes` at most; one opened from a key session also ends with it: after 15 minutes without a
      // request on either side (customer-side requests renew it, `keyImpLive`), at "End key session" or at a key rotation.
      await log("impersonate", { action: "impersonate.start", expiresInMin: minutes, ...(bind?.as ? { idleMin: ADMIN_SESSION_IDLE / 60, endsWithKeySession: true } : {}), ...(ss ? { endsWithStaffSession: true } : {}) });
      if (mine) jar.set(RETURN_COOKIE, mine, await sessionCookie(ttl));
      jar.set(IMPERSONATE_COOKIE, email, await sessionCookie(ttl));
      // The session record carries the founder (`imp`): it resolves to actor kind "founder", which never passes the
      // founder console and is refused account delete, password change, invites, role changes, MCP tokens and OAuth.
      await createSession(email, ttl, { imp: who, ...(bind ?? {}), ...(ss ? { ss } : {}) });
      // The redirect is built from a fixed list, never from the stored value as it is (rule 1188).
      return NextResponse.json({ ok: true, redirect: appHref(u.lang === "en" ? "en" : "ar") });
    }
    case "resendVerification": {
      // Rule 777: support mails a fresh code to the account's own address, through the same refusals as the owner's
      // resend (one a minute, five an hour, ten a day per address), so the console never floods an inbox. The code is
      // never in the response, not even on a test deploy: only the owner's own routes hand it back there (rule 766).
      if (emailVerified(u)) return NextResponse.json({ ok: false, error: "already_verified" }, { status: 409 });
      const refused = await verifySendRefusal(email, req);
      if (refused) return refused;
      const { sent } = await sendVerifyCode(u);
      await log("resendVerification", { sent });
      if (!sent) return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
      return NextResponse.json({ ok: true, resendIn: VERIFY.gap });
    }
    case "delete": {
      // Members left with nothing are deleted under `lock:person:{pid}` (`wipeMemberships`): a person, login or member lock timeout is a 409 with the owner's account still whole, a retry runs it again.
      try {
        await wipeAccount(id);
      } catch (e) {
        if (isPersonLockTimeout(e) || isTeamLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
        throw e;
      }
      await log("delete");
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  }
}
