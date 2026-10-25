import { appDict } from "./app-i18n";
import { isPersonSuspended, isSuspended } from "./suspension";
import { emailVerified, getAccount, getLogin, normalizeEmail, type User } from "./auth";
// Straight from the pure module, not through auth.ts: the public feed route may reach auth.ts only by the names
// tests/csrf.test.ts allows (no cookie, no session).
import { accountOfScope, acct } from "./account-id";
import { listBrands, scopeFor } from "./brands";
import { linkIds, type FeedRecord, type LinkOwner } from "./feed-token";
import type { AccountId, PersonId } from "./keys";
import { aidOf, getMembership, memberExtras, membershipHolds, roleIn, type Membership } from "./membership";
import { memberPid, pidFrom } from "./team";
import { getPerson } from "./person";
import { fill } from "./fill";
import { listOpenItems } from "./secretary";
import { addDays, isSnoozed, partyName, zoneDay, type SecItem } from "./secretary-agenda";
import type { Zone } from "./zones";
import { appHref } from "@/lib/ws-path";

/**
 * The calendar file of one brand's open dated to-dos (Reem phase 3 B1, spec section 2 and 7), and `feedHolds`, the
 * validity check the route (feed/[token]) runs on a link's record before anything is read. Only title, due date, all-day
 * flag, who owes it (`owedBy`, for the party's name), `id`, `rev` and `updatedAt` of an item are read; notes,
 * description, phone and inbox links never reach the file.
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

/** Open items with a due date from 14 days before `now` to 365 days after, nearest first, at most 500. Items snoozed now are left out, as the to-do page hides them (`isSnoozed`). */
export async function feedItems(scope: string, now: number): Promise<SecItem[]> {
  const open = await listOpenItems(scope);
  return open
    .filter((it) => {
      const t = it.dueAt ? Date.parse(it.dueAt) : NaN;
      return Number.isFinite(t) && t >= now - BEFORE_MS && t <= now + AFTER_MS && !isSnoozed(it, now);
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

/** Whether `recAt` is strictly before `lifeAt`. A missing or unparsable date on either side is not older. */
const olderThan = (recAt: unknown, lifeAt: unknown): boolean => {
  if (typeof recAt !== "string" || typeof lifeAt !== "string") return false;
  const r = Date.parse(recAt);
  const l = Date.parse(lifeAt);
  return Number.isFinite(r) && Number.isFinite(l) && r < l;
};

/**
 * Whom a link made on this request belongs to (rules 2119, 2132): the acting person (`u.actor.pid`) and the ACTIVE
 * account (`aidOf(u)`, the session's account, re-checked on every request), never a value from the request. `login` is
 * the acting address as R1 named the legacy pointer (the member's own address, the account address for an owner), and
 * `home` the actor's: only the home account writes and reads the legacy per-login pointer. Null without an actor (every
 * role check has already refused then).
 */
export function linkOwner(u: User): LinkOwner | null {
  const a = u.actor;
  if (!a) return null;
  return { pid: a.pid, aid: aidOf(u), login: a.kind === "member" ? a.email : u.email, home: a.home };
}

/**
 * Whether a link record still holds, read fresh on every fetch (the session-free half of `resolveSession` in auth.ts).
 * A record made from M1 names its person and account (`pid`, `aid`): `personHolds`. A record made before M1 names a
 * login only and keeps R1's check through `getLogin` (its home account only): `legacyHolds`. A record with one of the two
 * ids and not the other is refused. Any record with a login, a scope and a creation time can ask (the booking links of
 * B2a do); `feedHolds` is the feed's name for it.
 */
export async function loginHolds(rec: Pick<FeedRecord, "login" | "scope" | "createdAt" | "pid" | "aid">): Promise<boolean> {
  if (typeof rec.scope !== "string") return false;
  const ids = linkIds(rec);
  if (ids === null) return false;
  return ids === "legacy" ? legacyHolds(rec) : personHolds(rec, ids.pid, ids.aid);
}

/**
 * A record M1 made for `pid` in `aid` (rules 2119, 2131). Before any read the scope must be one of `aid`'s
 * (`accountOfScope`): a link never reaches another account's brand. Then ONE round: the person (`getPerson`), the account
 * (`getAccount`), the membership (`getMembership`) and the account's brands. It holds when the person is not suspended
 * (rule 2131: a person suspension ends every link of the person, an account suspension only that account's); the account
 * exists under `aid`, is not suspended and is verified (rule 756); `roleIn` gives the person a role there (the owner by
 * `ownerOf`, else a live membership that `membershipHolds`: admin or member, not paused, accepted no earlier than the
 * account was made); the record is not older than the person's `sessionsAfter` and birth, than the account's `createdAt`
 * for the owner, or than the membership's `acceptedAt` and the account's `teamSessionsAfter` for a member; and the scope
 * is one of the account's active brands, and, for a member narrowed to some brands, one of them (rule 3772). Removing the
 * membership, or the brand from its scope, therefore ends the link at read time even when the revoke never ran (rule 2119). A missing or unparsable date on either side of a "not older than" is not a reason to
 * refuse. "Sign out other devices" never ends a link (rule 1170: its stamp is not read here).
 */
async function personHolds(rec: Pick<FeedRecord, "scope" | "createdAt">, pid: PersonId, aid: AccountId): Promise<boolean> {
  if (accountOfScope(rec.scope) !== aid) return false;
  const [person, account, membership, brands] = await Promise.all([getPerson(pid), getAccount(aid), getMembership(aid, pid), listBrands(aid)]);
  if (!person || isPersonSuspended(person)) return false;
  if (!account || acct(account) !== aid || isSuspended(account) || !emailVerified(account)) return false;
  const role = roleIn(account, pid, membership);
  if (!role) return false;
  if (olderThan(rec.createdAt, person.sessionsAfter) || olderThan(rec.createdAt, person.createdAt)) return false;
  if (role === "owner") {
    if (olderThan(rec.createdAt, account.createdAt)) return false;
  } else {
    if (!membership || !membershipHolds(account, membership)) return false;
    if (olderThan(rec.createdAt, membership.acceptedAt) || olderThan(rec.createdAt, account.teamSessionsAfter)) return false;
  }
  const id = brandIdOf(rec.scope, aid);
  return !!id && brands.some((b) => b.id === id && b.status === "active") && (role === "owner" || inScope(membership, id));
}

/** Whether a membership's brand scope (rule 3756) allows brand `id`: no scope is every brand. */
const inScope = (m: Pick<Membership, "brands"> | null, id: string): boolean => {
  const brands = memberExtras(m).brands;
  return brands === undefined || brands.includes(id);
};

/**
 * A record made before M1 (no `pid`), R1's check plus the person suspension (rule 2131): the login exists and is active,
 * its person is not suspended, and `rec.scope` is one of its account's active brands. An owner must not be suspended
 * and must have verified the address (rule 756), and the same holds for the owner behind a member.
 * A member must be on the owner's roster (`getLogin` checks it), not disabled, an admin, member (or its contract name
 * "editor") or viewer as `resolveLegacy` reads the record (rule 3772: a Viewer's link holds), joined after the owner
 * record was made, and, when the membership (`getMembership`) narrows them to some brands, hold the scope's brand; the
 * owner must exist and not be suspended. The scope is compared with the owner's stored email
 * exactly, as `sc(u)` builds it: a member's own address, another account or an archived brand is never a scope here.
 * A record made before the login's current life began (a member's `acceptedAt`, an owner's `createdAt`) is stale: the
 * login was removed or deleted and the address taken again, so a link that outlived its revoke does not carry over. A
 * missing or unparsable date on either side is not a reason to refuse (existing links keep working).
 * The password events that sign a login out also end its links at read time (B1-R15), so a revoke that failed after the
 * password was saved cannot leave a link working: a record older than the owner's `sessionsAfter` (a password change or
 * reset), or, for a member, older than the member's own `sessionsAfter` or the owner's `teamSessionsAfter` (an owner or
 * founder reset signs the whole team out). An owner's password change stamps only `sessionsAfter`, so it ends the
 * owner's link and leaves the members' alone.
 */
async function legacyHolds(rec: Pick<FeedRecord, "login" | "scope" | "createdAt">): Promise<boolean> {
  const login = await getLogin(rec.login);
  if (!login) return false;
  // Rule 2131: a person suspension ends every link, a link made before M1 too (`getLogin` already read the person).
  if (isPersonSuspended(login.person)) return false;
  let owner: string;
  let membership: Promise<Membership | null> = Promise.resolve(null);
  if (login.kind === "owner") {
    if (isSuspended(login.user) || !emailVerified(login.user)) return false;
    if (olderThan(rec.createdAt, login.user.createdAt)) return false;
    if (olderThan(rec.createdAt, login.user.sessionsAfter)) return false;
    // The account id, not the address: an owner whose address moved in place keeps the id (rule 3817).
    owner = acct(login.user);
  } else {
    const { member: m, owner: u } = login;
    // A person known only through membership rows (multi-workspace M1, test persons only) holds no legacy link.
    if (!m || !u || isSuspended(u) || !emailVerified(u) || m.disabled) return false;
    // The record's own role, read as `resolveLegacy` reads it (rule 3751: "editor" is the contract release's "member").
    const legacyRole = (m.role as string) === "editor" ? "member" : m.role;
    if (legacyRole !== "admin" && legacyRole !== "member" && legacyRole !== "viewer") return false;
    if (typeof m.memberOf !== "string" || !m.memberOf || m.memberOf === normalizeEmail(rec.login)) return false;
    // NaN on either side (a malformed date) refuses too.
    if (!(new Date(m.acceptedAt).getTime() >= new Date(u.createdAt).getTime())) return false;
    if (olderThan(rec.createdAt, m.acceptedAt)) return false;
    if (olderThan(rec.createdAt, m.sessionsAfter) || olderThan(rec.createdAt, u.teamSessionsAfter)) return false;
    owner = acct(u);
    membership = getMembership(aidOf(u), pidFrom(memberPid(m)));
  }
  const id = brandIdOf(rec.scope, owner);
  if (!id) return false;
  const [brands, ms] = await Promise.all([listBrands(owner), membership]);
  if (login.kind !== "owner" && !inScope(ms, id)) return false;
  return brands.some((b) => b.id === id && b.status === "active");
}

/** The calendar feed's validity check; `loginHolds` under its B1 name. */
export const feedHolds = (rec: FeedRecord): Promise<boolean> => loginHolds(rec);

/** `YYYYMMDDTHHMMSSZ` of an instant. */
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const compactDay = (day: string) => day.replace(/-/g, "");

/** The whole calendar, `BEGIN:VCALENDAR` to `END:VCALENDAR`, every line folded and ended with CRLF. */
export function buildIcs(items: SecItem[], o: { lang: "ar" | "en"; zone: Zone; origin: string; now: number; brand?: string | null }): string {
  const ar = o.lang === "ar";
  // The two "who acts" phrases are the page's words (`todo.feed`), one source for the card and the file.
  const feedWords = appDict[o.lang].todo.feed;
  // The origin is caller-supplied: cleaned like a text value, but not escaped, since `URL` is a URI.
  // The feed's own brand (rule 894): `brand` is `brandOfScope(rec.scope)`, read from the stored feed record.
  const url = clean(`${o.origin}${appHref(o.lang, "/todo", null, o.brand)}`);
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
      it.owedBy === "owner" ? feedWords.mine : fill(feedWords.waiting, { name: partyName(it.owedBy, o.lang) });
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
