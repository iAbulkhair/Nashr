import { getLogin, normalizeEmail } from "./auth";
import { listBrands, scopeFor } from "./brands";
import type { FeedRecord } from "./feed-token";
import { listOpenItems } from "./secretary";
import { addDays, partyName, zoneDay, type SecItem } from "./secretary-agenda";
import type { Zone } from "./zones";

/**
 * The calendar file of one brand's open dated to-dos (Reem phase 3 B1, spec section 2 and 7), and `feedHolds`, the
 * validity check the route (feed/[token]) runs on a link's record before anything is read. Only title, due date, all-day flag, direction, party name, `rev` and
 * `updatedAt` of an item are read; notes, description, phone and inbox links never reach the file.
 */

const DAY_MS = 864e5;
const BEFORE_MS = 14 * DAY_MS;
const AFTER_MS = 365 * DAY_MS;
const MAX_EVENTS = 500;
const EVENT_MS = 30 * 60_000;

/** Line breaks (including Unicode ones) are read as a space, so a title can never start a new property line. */
const BREAKS = new RegExp("\\r\\n|[\\r\\n\\x85" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
/** Control characters and the bidi overrides, isolates and marks; the same cleaning an item's title got on create. */
const UNSAFE = new RegExp("[\\x00-\\x1f\\x7f-\\x9f" + [[0x202a, 0x202e], [0x2066, 0x2069], [0x200e, 0x200f]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("") + "]", "g");

const clean = (s: string): string => s.replace(BREAKS, " ").replace(UNSAFE, "");
/** One RFC 5545 TEXT value: cleaned of line breaks, control and direction characters, then `\`, `;` and `,` escaped. */
export const icsEscape = (s: string): string => clean(s).replace(/[\\;,]/g, (c) => `\\${c}`);

/** Fold a content line at 75 octets (the leading space of a continuation counts); a UTF-8 sequence is never split. */
export const icsFold = (line: string): string => {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > 75) {
      out.push(cur);
      cur = " ";
      size = 1;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n");
};

/** Open items with a due date from 14 days before `now` to 365 days after, nearest first, at most 500. */
export async function feedItems(scope: string, now: number): Promise<SecItem[]> {
  const open = await listOpenItems(scope);
  return open
    .filter((it) => {
      const t = it.dueAt ? Date.parse(it.dueAt) : NaN;
      return Number.isFinite(t) && t >= now - BEFORE_MS && t <= now + AFTER_MS;
    })
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_EVENTS);
}

/** The brand id `scope` names in `owner`'s account (`owner` itself is "default", `owner#{id}` is `id`), else null. */
const brandIdOf = (scope: string, owner: string): string | null => {
  if (scope === owner) return "default";
  if (!scope.startsWith(`${owner}#`)) return null;
  const id = scope.slice(owner.length + 1);
  return id && id !== "default" && scopeFor(owner, id) === scope ? id : null;
};

/**
 * Whether a feed record still holds, read fresh on every fetch (the session-free half of `resolveSession` in auth.ts):
 * the login exists and is active, and `rec.scope` is one of its account's active brands. An owner must not be suspended.
 * A member must be on the owner's roster (`getLogin` checks it), not disabled, an admin or member, joined after the owner
 * record was made, and the owner must exist and not be suspended. The scope is compared with the owner's stored email
 * exactly, as `sc(u)` builds it: a member's own address, another account or an archived brand is never a scope here.
 */
export async function feedHolds(rec: FeedRecord): Promise<boolean> {
  const login = await getLogin(rec.login);
  if (!login) return false;
  let owner: string;
  if (login.kind === "owner") {
    if (login.user.suspended) return false;
    owner = login.user.email;
  } else {
    const { member: m, owner: u } = login;
    if (!u || u.suspended || m.disabled) return false;
    if (m.role !== "admin" && m.role !== "member") return false;
    if (typeof m.memberOf !== "string" || !m.memberOf || m.memberOf === normalizeEmail(rec.login)) return false;
    // NaN on either side (a malformed date) refuses too.
    if (!(new Date(m.acceptedAt).getTime() >= new Date(u.createdAt).getTime())) return false;
    owner = u.email;
  }
  const id = brandIdOf(rec.scope, owner);
  if (!id) return false;
  return (await listBrands(owner)).some((b) => b.id === id && b.status === "active");
}

/** `YYYYMMDDTHHMMSSZ` of an instant. */
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const compactDay = (day: string) => day.replace(/-/g, "");

/** The whole calendar, `BEGIN:VCALENDAR` to `END:VCALENDAR`, every line folded and ended with CRLF. */
export function buildIcs(items: SecItem[], o: { lang: "ar" | "en"; zone: Zone; origin: string; now: number }): string {
  const ar = o.lang === "ar";
  // The origin is caller-supplied: cleaned like a text value, but not escaped, since `URL` is a URI.
  const url = clean(`${o.origin}/${o.lang}/app/todo`);
  const out: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Thakeen//Reem//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(ar ? "ذكين: مهامي" : "Thakeen: my to-dos")}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const it of items) {
    const due = Date.parse(it.dueAt!);
    // A value that does not parse must not fail the whole feed: fall back to the due time, then to now.
    const updated = [Date.parse(it.updatedAt), due, o.now].find((t) => Number.isFinite(t))!;
    const stamp = utc(updated);
    const who =
      it.owedBy === "owner" ? (ar ? "عليّ أنا" : "Mine") : `${ar ? "ننتظر" : "Waiting on"} ${partyName(it.owedBy, o.lang)}`;
    out.push("BEGIN:VEVENT", `UID:${it.id}@thakeen`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `SEQUENCE:${Number.isFinite(it.rev) ? it.rev : 0}`);
    if (it.allDay) {
      const day = zoneDay(due, o.zone);
      out.push(`DTSTART;VALUE=DATE:${compactDay(day)}`, `DTEND;VALUE=DATE:${compactDay(addDays(day, 1))}`);
    } else {
      out.push(`DTSTART:${utc(due)}`, `DTEND:${utc(due + EVENT_MS)}`);
    }
    out.push(`SUMMARY:${icsEscape(it.title)}`, `DESCRIPTION:${icsEscape(`${who} - ${url}`)}`, `URL:${url}`, "STATUS:CONFIRMED", "END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.map(icsFold).join("\r\n") + "\r\n";
}
