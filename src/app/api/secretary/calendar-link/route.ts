import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { db } from "@/lib/db";
import { getBrand } from "@/lib/brand";
import { SEC_KEYS, audit, withLock } from "@/lib/secretary";
import { CAL_DECLARATION_V, proofOf } from "@/lib/secretary-cal-proof";
import { dropLink, getLink, putLink, scheduleSync, type CalLink } from "@/lib/secretary-cal-link";
import { LOCK_TTL_S, freshAccess, listOwnCalendars, loseLink, reproof } from "@/lib/secretary-gcal";
import { calLimit, linkView, refuse } from "@/lib/secretary-cal-routes";

/**
 * The brand's one linked calendar, for the owner's active brand (`sc(u)`), spec 2026-10-05-secretary-reem-b3-calendar-read-design.md
 * §4-§5. Owner only (`calendar.link`); every handler authenticates, checks the role, takes the rate limit, then the scope from
 * the session. Never a token, a calendar id or the declaration in an answer.
 * GET: `{ ok, link: { provider, account, calendarName?, proof, state, lostReason?, lastSyncAt?, rev, today } | null }`, `today` being
 * the kept meetings of the brand's local day as `HH:mm` and a title (`cal:read:{login}` 120 an hour).
 * PUT `{ choice, declare?, rev }`, strict keys: picks from the choices GET calendars stored (10 minutes), under `withLock(scope,
 * "cal")`: the stored `rev` must match (409 `stale`), the choices must be alive (409 `choices_expired`), then (P3) the token is
 * refreshed, the proof is read again (a Google refresh without an `id_token` keeps the stored domain, ruling R3; Outlook asks
 * Graph every time), a save whose proof is not `domain` needs `declare: true` (400 `declaration_required`), and the live list of
 * owned calendars must still hold the choice (400 `not_owned`). Saves state `ok`, bumps `rev`, clears the choices and the old
 * calendar's events, schedules the first sync now and audits `cal_choose`; answers GET's (`cal:write:{login}` 30 an hour).
 * DELETE: drops the link, its events and its sync entry, audits `cal_unlink`. Nashr never calls a provider's revoke endpoint
 * (ruling R7); the owner removes access in their Google or Microsoft account (`cal:write:{login}`).
 * A provider failure is 502 `provider_error` with no provider text; a refresh refused as `invalid_grant` or 401 also marks the
 * link `reconnect` (`cal_lost`). A brand with no link, or one in `reconnect`, is 404 `not_linked` for PUT and the list.
 */
const LOCK = "cal";
type Out = { ok: true; link: CalLink } | { ok: false; error: string; status: number };
const CHOOSE_KEYS = new Set(["choice", "declare", "rev"]);

export async function GET() {
  const u = await currentUser();
  if (!u) return refuse("unauthorized", 401);
  const no = forbid(u, "calendar.link");
  if (no) return no;
  const g = await calLimit(u, "read");
  if (g instanceof Response) return g;
  const now = Date.now();
  const link = await getLink(g.scope);
  if (!link) return NextResponse.json({ ok: true, link: null });
  return NextResponse.json({ ok: true, link: await linkView(g.scope, link, g.lang, now) });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return refuse("unauthorized", 401);
  const no = forbid(u, "calendar.link");
  if (no) return no;
  const g = await calLimit(u, "write");
  if (g instanceof Response) return g;
  const raw: unknown = await req.json().catch(() => null);
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b || Object.keys(b).some((k) => !CHOOSE_KEYS.has(k))) return refuse("bad_request", 400);
  const { choice, declare, rev } = b;
  if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 0 || typeof rev !== "number" || !Number.isInteger(rev) || (declare !== undefined && declare !== true)) return refuse("bad_request", 400);
  const { scope, login } = g;
  const now = Date.now();
  const website = (await getBrand(scope))?.website;
  const r = await withLock(scope, LOCK, async (): Promise<Out> => {
    const link = await getLink(scope);
    if (!link || link.state === "reconnect") return { ok: false, error: "not_linked", status: 404 };
    if (link.rev !== rev) return { ok: false, error: "stale", status: 409 };
    const ch = link.choices;
    if (!ch || !Array.isArray(ch.ids) || !(ch.until >= now)) return { ok: false, error: "choices_expired", status: 409 };
    const id = ch.ids[choice];
    if (typeof id !== "string") return { ok: false, error: "bad_request", status: 400 };
    const fresh = await freshAccess(scope, link, now);
    if (!fresh.ok) {
      if ("lost" in fresh) await loseLink(scope, link, login);
      return { ok: false, error: "provider_error", status: 502 };
    }
    let who: { account: string; accountDomain: string | null };
    try {
      who = await reproof(fresh.link, fresh.data, fresh.access);
    } catch (e) {
      console.error("cal proof failed", e instanceof Error ? e.name : "error");
      return { ok: false, error: "provider_error", status: 502 };
    }
    // What the provider just proved is kept even when this save is refused below, so the next try cannot fall back to an older domain.
    let known: CalLink = fresh.link;
    if (who.account !== known.account || (who.accountDomain ?? null) !== (known.accountDomain ?? null)) {
      known = { ...known, account: who.account };
      delete known.accountDomain;
      if (who.accountDomain) known.accountDomain = who.accountDomain;
      await putLink(scope, known);
    }
    const proven = proofOf(who.accountDomain, website) === "domain";
    if (!proven && declare !== true) return { ok: false, error: "declaration_required", status: 400 };
    let owned: { id: string; name: string }[];
    try {
      owned = await listOwnCalendars(link.provider, fresh.access, who.account);
    } catch (e) {
      if ((e as { status?: unknown }).status === 401) {
        await loseLink(scope, known, login);
      } else {
        console.error("cal list failed", e instanceof Error ? e.name : "error");
      }
      return { ok: false, error: "provider_error", status: 502 };
    }
    const hit = owned.find((c) => c.id === id);
    if (!hit) return { ok: false, error: "not_owned", status: 400 };
    const saved: CalLink = {
      ...known,
      proof: proven ? "domain" : "declaration",
      calendarId: hit.id,
      calendarName: hit.name,
      state: "ok",
      rev: link.rev + 1,
    };
    // Nothing of the earlier choice, calendar or proof survives into the new save.
    delete saved.choices;
    delete saved.lostReason;
    delete saved.lastSyncAt;
    delete saved.declaration;
    if (!proven) saved.declaration = { by: login, at: new Date(now).toISOString(), v: CAL_DECLARATION_V };
    await Promise.all([
      putLink(scope, saved),
      // The earlier calendar's events must not be served as this calendar's.
      db.del(SEC_KEYS.calEvents(scope)),
      scheduleSync(scope, now),
      audit(scope, { actor: "owner", via: "web", login }, "cal_choose", "-", `provider=${saved.provider}`),
    ]);
    return { ok: true, link: saved };
  }, LOCK_TTL_S);
  if (!r.ok) return refuse(r.error, r.status);
  return NextResponse.json({ ok: true, link: await linkView(scope, r.link, g.lang, now) });
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return refuse("unauthorized", 401);
  const no = forbid(u, "calendar.link");
  if (no) return no;
  const g = await calLimit(u, "write");
  if (g instanceof Response) return g;
  const { scope, login } = g;
  const r = await withLock(scope, LOCK, async (): Promise<{ ok: true } | { ok: false; error: string; status: number }> => {
    const link = await getLink(scope);
    if (!link) return { ok: false, error: "not_linked", status: 404 };
    await dropLink(scope);
    await audit(scope, { actor: "owner", via: "web", login }, "cal_unlink", "-", `provider=${link.provider}`);
    return { ok: true };
  }, LOCK_TTL_S);
  if (!r.ok) return refuse(r.error, r.status);
  return NextResponse.json({ ok: true });
}
