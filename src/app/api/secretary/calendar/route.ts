import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { SEC_KEYS, SEC_READS_PER_HOUR, audit, usableCalendar, withLock, zoneFor, type Who } from "@/lib/secretary";
import { calendarView, parseCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import type { Zone } from "@/lib/zones";

/**
 * The brand's Working days, for the signed-in account's active brand (`sc(u)`): `sec:cal:{scope}`, one `SecCalendar`
 * (src/lib/secretary-calendar.ts). The weekend, Ramadan chasing hours, the owner's Eid sightings and the holidays he adds
 * or removes decide when Reem suggests chasing someone. Nothing here is reachable from chat or MCP.
 * GET: `{ ok, calendar, effective, upcoming, eids }`: the saved settings (null when there are none, or the stored value is not
 * settings the calendar can be built from: the defaults then apply, ruling R13), what is in force (`effective`: the
 * country, the brand's zone, the weekend, the zone's own default weekend that the page marks, the week's first day, the
 * Ramadan hours), the next 365 days of quiet days with their reason and name and the next Ramadan (`upcoming`), and
 * this and next Hijri year's Eid with the `hijriFix` value each "a day earlier / later" button saves (`eids`)
 * (`read`, any member, rate `sec:read`).
 * PUT: the whole settings object, which is what GET returns under `calendar` (its `v`, `updatedAt` and `updatedBy` are
 * replaced) (`brand.write`, admin and owner, rate `sec:cal` 30 an hour). It authenticates, then checks the role, then the
 * rate limit, then reads the body. Under `withLock(scope, "cal")` it reads the stored settings and `parseCalendar` checks
 * the body field by field against them: a field it does not know (a `scope`, an `email`) is refused, not ignored (400
 * with the error and the field); a day turned off that is already stored is kept even when no default produces it any
 * more (ruling R28: an Eid moved, the zone changed), so the page never locks. The write leaves one `calendar` audit line
 * with the login, and the answer is GET's, for the new settings.
 */
const refused = (r: { error: string; field?: string; status: number }) => NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
const badRequest = () => NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
/** The lock id under `sec:lock:{scope}:…`: item ids start with "s" and 16 hex characters, so it names no item. */
const LOCK = "cal";

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const b: unknown = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** What GET gives for a stored value, read at `now` in the brand's `zone`: the page's own view (`calendarView`). */
const viewOf = (stored: unknown, zone: Zone, now: number) => ({ ok: true, ...calendarView(usableCalendar(stored, zone, now), zone, now) });

/** One short line for the audit: the settings as saved (weekdays, clock times, years and counts only). */
const summary = (c: SecCalendar) =>
  `weekend=${c.weekend === null ? "default" : `[${c.weekend}]`}; ramadanHours=${c.ramadanHours === null ? "default" : c.ramadanHours.map((w) => `${w.from}-${w.to}`).join(",") || "none"}; hijriFix=${Object.keys(c.hijriFix).join(",") || "none"}; holidays +${c.holidays.add.length} -${c.holidays.remove.length}${c.workHours ? `; workHours=${c.workHours.from}-${c.workHours.to}` : ""}`;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return retryLater({ ok: false, error: "too_many" }, 3600);
  const scope = sc(u);
  const now = Date.now();
  const [zone, stored] = await Promise.all([zoneFor(scope), db.get<unknown>(SEC_KEYS.cal(scope))]);
  return NextResponse.json(viewOf(stored, zone, now));
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "brand.write");
  if (no) return no;
  if (!(await allow(`sec:cal:${u.email}`, 30, 3600))) return retryLater({ ok: false, error: "too_many" }, 3600);
  const b = await bodyOf(req);
  if (!b) return badRequest();
  const scope = sc(u);
  const now = Date.now();
  const zone = await zoneFor(scope);
  // `u` is the account: who saved is the acting login, from the session (fail closed above: no actor, no role).
  const login = u.actor?.email ?? u.email;
  const who: Who = { actor: "owner", via: "web", login };
  const r = await withLock(scope, LOCK, async () => {
    // The stored record, as GET reads it (ruling R13: one the calendar cannot be built from is none), so a removal it
    // already holds is kept (ruling R28).
    const stored = usableCalendar(await db.get<unknown>(SEC_KEYS.cal(scope)), zone, now);
    const p = parseCalendar(b, now, zone, login, stored);
    if (!p.ok) return p;
    await Promise.all([db.set(SEC_KEYS.cal(scope), p.cal), audit(scope, who, "calendar", "-", summary(p.cal))]);
    return p;
  });
  if (!r.ok) return refused(r);
  return NextResponse.json(viewOf(r.cal, zone, now));
}
