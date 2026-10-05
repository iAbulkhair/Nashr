import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { getBrand } from "@/lib/brand";
import { proofOf } from "@/lib/secretary-cal-proof";
import { getLink, putLink } from "@/lib/secretary-cal-link";
import { freshAccess, listOwnCalendars, loseLink, withCalLock } from "@/lib/secretary-gcal";
import { calLimit, refuse } from "@/lib/secretary-cal-routes";

/**
 * The calendars the linked account owns, live from the provider (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §5):
 * `{ ok, calendars: [{ choice, name }], needsDeclaration }`, at most 50. Owner only (`calendar.link`), rate `cal:list:{login}` 30
 * an hour, the scope from the session. Under `withCalLock(scope)` (ruling R8) the token is refreshed if it is about to end, the list is
 * read, and the ids and names are kept on the link as `choices` for 10 minutes: the answer gives indexes, never a provider id,
 * and PUT picks only from what is stored. `needsDeclaration` is whether the domain the provider proved at the callback matches
 * the brand's website; PUT proves it again and decides. No link, or one in `reconnect`, is 404 `not_linked`; a provider failure
 * is 502 `provider_error` with no provider text, a busy lock is 503 `provider_error`, and `invalid_grant` or a 401 from the calendar list marks the link `reconnect` (ruling R9).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return refuse("unauthorized", 401);
  const no = forbid(u, "calendar.link");
  if (no) return no;
  const g = await calLimit(u, "list");
  if (g instanceof Response) return g;
  const { scope, login } = g;
  const now = Date.now();
  const website = (await getBrand(scope))?.website;
  const r = await withCalLock(scope, async (): Promise<{ ok: true; calendars: { choice: number; name: string }[]; needsDeclaration: boolean } | { ok: false; error: string; status: number }> => {
    const link = await getLink(scope);
    if (!link || link.state === "reconnect") return { ok: false, error: "not_linked", status: 404 };
    const fresh = await freshAccess(scope, link, now);
    if (!fresh.ok) {
      if ("lost" in fresh) await loseLink(scope, link, login);
      return { ok: false, error: "provider_error", status: 502 };
    }
    let owned: { id: string; name: string }[];
    try {
      owned = await listOwnCalendars(link.provider, fresh.access, fresh.link.account);
    } catch (e) {
      if ((e as { status?: unknown }).status === 401) await loseLink(scope, fresh.link, login);
      else console.error("cal list failed", e instanceof Error ? e.name : "error");
      return { ok: false, error: "provider_error", status: 502 };
    }
    await putLink(scope, { ...fresh.link, choices: { ids: owned.map((c) => c.id), names: owned.map((c) => c.name), until: now + 600_000 } });
    return { ok: true, calendars: owned.map((c, i) => ({ choice: i, name: c.name })), needsDeclaration: proofOf(fresh.link.accountDomain ?? null, website) !== "domain" };
  });
  if (!r.ok) return refuse(r.error, r.status);
  return NextResponse.json({ ok: true, calendars: r.calendars, needsDeclaration: r.needsDeclaration });
}
