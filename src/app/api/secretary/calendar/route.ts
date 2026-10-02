import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { SEC_KEYS, SEC_READS_PER_HOUR, audit, usableCalendar, withLock, zoneFor, type Who } from "@/lib/secretary";
import { countryOf, parseCalendar, upcomingQuiet, workCalendar, type SecCalendar } from "@/lib/secretary-calendar";
import type { Zone } from "@/lib/zones";

/**
 * The brand's Working days, for the signed-in account's active brand (`sc(u)`): `sec:cal:{scope}`, one `SecCalendar`
 * (src/lib/secretary-calendar.ts). The weekend, Ramadan chasing hours, the owner's Eid sightings and the holidays he adds
 * or removes decide when Reem suggests chasing someone. Nothing here is reachable from chat or MCP.
 * GET: `{ ok, calendar, effective, upcoming }`: the saved settings (null when there are none, or the stored value is not
 * settings the calendar can be built from: the defaults then apply, ruling R13), what is in force (`effective`: the
 * country, the weekend, the week's first day, the Ramadan hours) and the next 365 days of quiet days with their reason
 * and name and the next Ramadan (`upcoming`) (`read`, any member, rate `sec:read`).
 * PUT: the whole settings object, which is what GET returns under `calendar` (its `v`, `updatedAt` and `updatedBy` are
 * replaced) (`brand.write`, admin and owner, rate `sec:cal` 30 an hour). It authenticates, then checks the role, then the
 * rate limit, then reads the body, which `parseCalendar` checks field by field: a field it does not know (a `scope`, an
 * `email`) is refused, not ignored (400 with the error and the field). The write runs under `withLock(scope, "cal")` and
 * leaves one `calendar` audit line with the login, and the answer is GET's, for the new settings.
 */
const refused = (r: { error: string; field?: string; status: number }) => NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
const badRequest = () => NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
/** The lock id under `sec:lock:{scope}:…`: item ids start with "s" and 16 hex characters, so it names no item. */
const LOCK = "cal";

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const b: unknown = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** What GET gives for a stored value, read at `now` in the brand's `zone`. */
function viewOf(stored: unknown, zone: Zone, now: number) {
  const calendar = usableCalendar(stored, zone, now);
  const data = workCalendar(calendar, zone, now);
  return {
    ok: true,
    calendar,
    effective: { country: countryOf(zone), weekend: data.weekend, weekStart: data.weekStart, ramadanHours: data.ramadanHours },
    upcoming: upcomingQuiet(calendar, zone, now),
  };
}

/** One short line for the audit: the settings as saved (weekdays, clock times, years and counts only). */
const summary = (c: SecCalendar) =>
  `weekend=${c.weekend === null ? "default" : `[${c.weekend}]`}; ramadanHours=${c.ramadanHours === null ? "default" : c.ramadanHours.map((w) => `${w.from}-${w.to}`).join(",") || "none"}; hijriFix=${Object.keys(c.hijriFix).join(",") || "none"}; holidays +${c.holidays.add.length} -${c.holidays.remove.length}`;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
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
  if (!(await allow(`sec:cal:${u.email}`, 30, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const b = await bodyOf(req);
  if (!b) return badRequest();
  const scope = sc(u);
  const now = Date.now();
  const zone = await zoneFor(scope);
  // `u` is the account: who saved is the acting login, from the session (fail closed above: no actor, no role).
  const login = u.actor?.email ?? u.email;
  const p = parseCalendar(b, now, zone, login);
  if (!p.ok) return refused(p);
  const who: Who = { actor: "owner", via: "web", login };
  const r = await withLock(scope, LOCK, async () => {
    await Promise.all([db.set(SEC_KEYS.cal(scope), p.cal), audit(scope, who, "calendar", "-", summary(p.cal))]);
    return { ok: true as const };
  });
  if (!r.ok) return refused(r);
  return NextResponse.json(viewOf(p.cal, zone, now));
}
