/**
 * Readable workspace slugs (rules 3504-3505), after Supastarter's organization slug: a short, unique, lowercase name made
 * from the workspace's name ("متجر الورد" → `mtjr-alwrd`, "Café Noir" → `cafe-noir`), with a random fallback.
 *
 * Unique by one atomic claim, never a scan: `SET NX wsslug:{slug} = {account id}`. The candidates (the base, the base
 * with two random suffixes, a random `ws-` name) are claimed in ONE round (`Promise.all`, no `await` in a loop); the first
 * one won in that order is kept and any other won is released at once. A name that is reserved (a route folder, a
 * locale, a brand or abuse word), too short or not Latin after transliteration goes straight to the random name.
 *
 * Display only (this release): links and the request selector stay the `w_` handle (rule 2114). The slug is stored on
 * the account (`User.workspaceSlug`) and `wsslug:{slug}` is deleted with the account (`wipeAccount`).
 */
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { globalKey } from "./keys";

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;
/** A slug: lowercase Latin letters and digits, single hyphens inside, 3 to 32 characters. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/;

/**
 * Rule 3505: never a slug. Every top-level route folder of src/app, src/app/[lang] and src/app/[lang]/app (a test reads
 * the folders and fails when one is missing), the locales, the short path segments of the app (`w`, `b`, `m`, `p`), our
 * own names, and words that would let a workspace pass for us or for staff.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // src/app
  "api", "fonts", "m", "oauth", "p", "llms", "llms-full",
  // src/app/[lang]
  "admin", "affiliates", "agents", "ai-marketing-agent", "app", "blog", "compare", "customers", "enterprise", "for", "help",
  "pricing", "privacy", "resources", "staging-access", "terms", "tools", "updates",
  // src/app/[lang]/app
  "b", "forgot", "join", "login", "mcp", "notifications", "partner", "refer", "reset", "settings", "signup", "verify", "workspaces",
  // path segments and locales
  "w", "ar", "en", "www", "static", "assets", "public", "_next", "next", "cdn", "mail", "smtp", "ftp", "status", "docs",
  "dashboard", "account", "accounts", "billing", "auth", "logout", "signin", "sign-in", "sign-up", "register", "new", "edit",
  "overview", "start", "home", "index", "about", "contact", "legal", "security", "team", "teams", "org", "orgs", "workspace",
  "brand", "brands", "media", "files", "tasks", "chat", "inbox", "calendar", "reports", "health", "cron", "webhook", "webhooks",
  // our own names
  "thakeen", "zakeen", "nashr", "thakeen-ai", "zakeen-ai", "thek", "anthropic", "claude",
  // staff and abuse
  "support", "official", "staff", "root", "system", "sysadmin", "administrator", "moderator", "owner", "founder", "billing-team",
  "help-desk", "helpdesk", "abuse", "noreply", "no-reply", "postmaster", "hostmaster", "webmaster", "test", "null", "undefined",
]);

/** Arabic letters to Latin, by sound. Diacritics and tatweel are dropped before this map is read. */
const AR: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ء": "", "ؤ": "u", "ئ": "i", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h",
  "خ": "kh", "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a",
  "غ": "gh", "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "a", "و": "w", "ي": "y", "ى": "a",
  "پ": "p", "چ": "ch", "گ": "g", "ک": "k", "ی": "y",
};

/** Rule 3504: a name in Latin letters. Arabic by sound, Arabic-Indic digits as digits, Latin accents dropped. */
export function transliterate(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0600-\u06ff]/g, (c) => AR[c] ?? " ");
}

/** Rule 3504: the base slug of a name, or "" when nothing usable is left. Cut at a hyphen when it is too long. */
export function slugify(name: string): string {
  let s = transliterate(String(name ?? "").slice(0, 200))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX);
    const cut = s.lastIndexOf("-");
    s = (cut >= SLUG_MIN ? s.slice(0, cut) : s).replace(/-+$/g, "");
  }
  return SLUG_RE.test(s) ? s : "";
}

/** Rule 3505: a slug that may be claimed. */
export const slugAllowed = (s: string) => SLUG_RE.test(s) && !RESERVED_SLUGS.has(s);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n: number) => [...randomBytes(n)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
/** The base cut to leave room for `-` and a 4-character suffix. */
const withSuffix = (base: string) => `${base.slice(0, SLUG_MAX - 5).replace(/-+$/g, "")}-${rand(4)}`;

/** The candidates in order of preference: the base, two suffixed, one random (always last). */
export function slugCandidates(name: string): string[] {
  const base = slugify(name);
  const random = `ws-${rand(6)}`;
  return slugAllowed(base) ? [base, withSuffix(base), withSuffix(base), random] : [random, `ws-${rand(8)}`];
}

/**
 * Rule 3504: claim a unique slug for account `aid` (our own id, never one from a request). One round of SET NX for every
 * candidate, the first won kept, the rest released. Null only when every candidate was taken (the caller saves no slug).
 */
export async function claimSlug(name: string, aid: string): Promise<string | null> {
  const cands = slugCandidates(name);
  const won = await Promise.all(cands.map((s) => db.setNx(globalKey.wsSlug(s), aid)));
  const first = won.indexOf(true);
  const extra = cands.filter((s, i) => won[i] && i !== first);
  if (extra.length) await Promise.all(extra.map((s) => db.del(globalKey.wsSlug(s))));
  return first === -1 ? null : cands[first];
}

/** Release a slug, only while it still names this account. */
export async function releaseSlug(slug: string | undefined, aid: string): Promise<void> {
  if (!slug || !SLUG_RE.test(slug)) return;
  if ((await db.get<string>(globalKey.wsSlug(slug))) === aid) await db.del(globalKey.wsSlug(slug));
}
