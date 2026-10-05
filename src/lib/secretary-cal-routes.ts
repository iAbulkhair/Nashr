/**
 * Reem B3: what the two calendar-link routes share (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §5): the
 * rate limit and scope every handler takes after its own session and role checks, the refusal answer, and the link's view for the page.
 * Importers: `src/app/api/secretary/calendar-link/route.ts` and `src/app/api/secretary/calendar-link/calendars/route.ts`.
 * Nothing here returns a token, a calendar id or the declaration; the scope is always `sc(u)`.
 */
import { NextResponse } from "next/server";
import { sc, type User } from "./auth";
import { allow } from "./rate";
import { zoneFor } from "./secretary";
import { zoneLocalInput } from "./secretary-agenda";
import { meetingsNow, type CalLink } from "./secretary-cal-link";
import { meetingTitle, todayMeetings } from "./secretary-meetings";

/** Per owner login and hour, by what the route does (spec §5). PUT and DELETE share `write`. */
const LIMITS = { read: 120, list: 30, write: 30 } as const;

export const refuse = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });

/**
 * The rate limit every handler takes after its own session (401) and `forbid(u, "calendar.link")` (403) checks, which stay
 * in the handler: then the scope from the session, never from the request. Returns the 429 to send, or who is calling.
 */
export async function calLimit(u: User, kind: keyof typeof LIMITS): Promise<Response | { scope: string; login: string; lang: "ar" | "en" }> {
  const login = u.actor?.email ?? u.email;
  if (!(await allow(`cal:${kind}:${login}`, LIMITS[kind], 3600))) return refuse("too_many", 429);
  return { scope: sc(u), login, lang: u.actor?.lang ?? u.lang };
}

/** The link as the page sees it: no token, no calendar id, no declaration, and today's kept meetings as local clock times. */
export async function linkView(scope: string, link: CalLink, lang: "ar" | "en", now: number) {
  const [zone, meetings] = await Promise.all([zoneFor(scope), meetingsNow(scope, now)]);
  const clock = (iso: string) => zoneLocalInput(Date.parse(iso), zone).slice(11, 16);
  return {
    provider: link.provider,
    account: link.account,
    ...(link.calendarName ? { calendarName: link.calendarName } : {}),
    proof: link.proof,
    state: link.state,
    ...(link.lostReason ? { lostReason: link.lostReason } : {}),
    ...(link.lastSyncAt ? { lastSyncAt: link.lastSyncAt } : {}),
    /** The save's `rev`: a PUT must send the one it saw. */
    rev: link.rev,
    today: todayMeetings(meetings, zone, now).map((m) => ({ start: clock(m.start), end: clock(m.end), title: meetingTitle(m, lang) })),
  };
}
