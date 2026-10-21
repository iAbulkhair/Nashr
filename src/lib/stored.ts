import { z } from "zod";
import { log } from "./log";
import { PASSKEY_NAME_MAX, PASSKEYS_MAX } from "./passkey-limits";

/**
 * Read validation for stored shapes (rules 2035-2039, docs/system/flows.md section 83).
 *
 * `db.get` hands back whatever JSON sits under a key, typed only by the caller's `<T>`. A record written by an older
 * release, by a bug, or by hand can miss a field the code relies on, and the reader then throws far from the cause (a
 * connection without `enc` fails inside `decrypt`). The few shapes below are checked when they are read: a record that
 * does not fit is logged once (`stored shape invalid`, with the shape's name, each failing field's path and zod's issue
 * code, never the key, the account or a value) and the reader gets a safe default instead of an exception.
 *
 * Each schema accepts every shape this app has written (expand-then-contract, rule 679): fields added later are
 * optional or take the default the code already assumed, and `looseObject` keeps fields it does not name, so a
 * read-modify-write never strips a field a newer release added.
 */

/** The checked value, or `fallback` (absent record, or one that does not fit; the latter is logged without values). */
export function parseStored<S extends z.ZodType, F>(shape: string, schema: S, raw: unknown, fallback: F): z.output<S> | F {
  if (raw === null || raw === undefined) return fallback;
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  log.warn("stored shape invalid", { shape, issues: r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code })) });
  return fallback;
}

/**
 * Rule 2036: one row of `brands:{email}` (`BrandMeta`). Only `id` is required: a row without one cannot name a scope.
 * `status` absent reads as active (rows written before archiving existed), `name` and `createdAt` absent read as "".
 */
export const BrandRow = z.looseObject({
  id: z.string().min(1),
  name: z.string().catch(""),
  createdAt: z.string().catch(""),
  status: z.enum(["active", "archived"]).catch("active"),
});

/**
 * Rule 2036: the rows of `brands:{email}`, checked one by one. A value that is not a list reads as no rows; a row that
 * does not fit is left out (logged), the others are kept, so one bad row never hides the account's other brands.
 */
export function brandRows(raw: unknown): z.output<typeof BrandRow>[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return parseStored("brands", z.array(BrandRow), raw, [] as z.output<typeof BrandRow>[]);
  return raw.flatMap((row) => {
    const r = parseStored("brands.row", BrandRow.nullable(), row, null);
    return r ? [r] : [];
  });
}

/**
 * Rule 2037: `activebrand:{login}`, a brand id. The Redis client reads a stored value that looks like a number back as
 * a number (a brand id is eight base-36 characters, so "12345678" can happen), so a number is turned back into its text.
 */
export const ActiveBrandId = z.union([z.string().min(1), z.number().transform((n) => String(n))]);

/**
 * Rule 2038: `conn:{scope}:{provider}`, one connection with its credentials sealed in `enc`. `provider` and `enc` are
 * required (without `enc` there is nothing to open); `kid` is absent on records sealed before key versions (rule 1351).
 * A display field of the wrong type reads as absent rather than losing the connection.
 */
export const StoredConnection = z.looseObject({
  provider: z.string().min(1),
  enc: z.string().min(1),
  kid: z.string().optional().catch(undefined),
  meta: z.record(z.string(), z.string()).optional().catch(undefined),
  connectedAt: z.string().catch(""),
  expiresAt: z.string().optional().catch(undefined),
  needsReconnect: z.string().optional().catch(undefined),
});

/**
 * Rule 2039: `conv:{scope}:{id}`, a conversation record. `id` is required; `count` absent reads as 0, the times and the
 * title as "". `agent` and `model` are optional (`model` is absent before 2026-10-08) and checked as text only: the
 * code that uses them checks the value against its own list.
 */
export const ConversationRecord = z.looseObject({
  id: z.string().min(1),
  title: z.string().catch(""),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
  count: z.number().catch(0),
  agent: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
});

/**
 * Multi-workspace membership (docs/specs/2026-10-18-multi-org.md section 6, release M1 "expand", rules 2110-2139). Read
 * through `parseStored`; every schema is a `looseObject`, so a read-modify-write never strips a field a later release adds.
 * No code reads or writes these shapes before the adapter of the later M1 tasks.
 */

/**
 * Rule 2134: `person:{pid}`, the credentials and profile of one person. `pid` and `email` (the normalized sign-in
 * address) are required; `name` absent reads as "" and `lang` as "ar". `passHash` is absent for a Google-only person.
 * `suspended` is person-level (section 14): `true`, or `{ until }`.
 */
export const PersonRow = z.looseObject({
  pid: z.string().min(1),
  email: z.string().min(3),
  name: z.string().catch(""),
  lang: z.enum(["ar", "en"]).catch("ar"),
  passHash: z.string().optional(),
  emailVerifiedAt: z.string().optional(),
  sessionsAfter: z.string().optional(),
  devicesAfter: z.string().optional(),
  suspended: z.union([z.literal(true), z.looseObject({ until: z.string() })]).optional(),
  trialUsedAt: z.string().optional(),
  /**
   * Multi-workspace M2 (spec section 10, decision 3): how many accounts this person may own, set by the founder for one
   * person; absent reads as `OWNED_CAP` (src/lib/workspaces.ts). Optional and new (expand): older code ignores it.
   */
  ownedCap: z.number().int().min(1).max(50).optional(),
  createdAt: z.string().catch(""),
});
export type PersonRowValue = z.output<typeof PersonRow>;

/**
 * Rules 2115, 2134: `mbr:{aid}:{pid}`, one person's membership in one account. `role` is `admin` or `member`, never
 * `owner` (the owner is named only by `ownerOf`): a row claiming `owner` does not parse, `parseStored` logs the shape
 * without values, and the reader gets "no membership", which grants nothing. `invitedBy` is a PersonId, "" when unknown.
 */
export const MembershipRow = z.looseObject({
  aid: z.string().min(1),
  pid: z.string().min(1),
  role: z.enum(["admin", "member"]),
  acceptedAt: z.string().min(1),
  invitedBy: z.string().catch(""),
  disabled: z.literal("seats").optional(),
});
export type MembershipValue = z.output<typeof MembershipRow>;

/** The membership events of `teamlog:{aid}` (spec section 13). */
export const TEAM_LOG_KINDS = [
  "invited",
  "invite_cancelled",
  "joined",
  "role_changed",
  "removed",
  "left",
  "paused_for_seats",
  "resumed",
  "ownership_offered",
  "ownership_transferred",
  "workspace_created",
] as const;

/**
 * Rule 2129: one row of `teamlog:{aid}`. `actor` and `target` carry the person id and the address of the day; the row
 * never holds a token, an invite id or a password, and for a console action `via` is `console` and staff are not named.
 */
export const TeamLogRow = z.looseObject({
  at: z.string().min(1),
  kind: z.enum(TEAM_LOG_KINDS),
  actor: z.looseObject({ pid: z.string(), email: z.string() }),
  target: z.looseObject({ pid: z.string().optional(), email: z.string() }),
  /** The role the event gave or concerned (`TeamRole`). Tightened in multi-workspace M1 (2026-10-19): nothing read the log before it. */
  role: z.enum(["admin", "member"]).optional(),
  via: z.enum(["web", "console", "system"]),
});
export type TeamLogRowValue = z.output<typeof TeamLogRow>;

/**
 * Customer passkeys (docs/specs/2026-10-20-passkeys.md "Data shapes and keys", release step expand, rules 2400-2429).
 * Rule 2401: one credential of a passkey set. `id` is the credential id as the authenticator gave it (base64url, never
 * `+` or `/`), `pk` the COSE public key (base64url). `transports` (at most 8 of at most 20 characters) and `pk` (at most
 * 2048 characters) also bound what the WebAuthn library hands back, so the store checks a new credential against this
 * shape before it writes it. `name` is the cleaned label, 1-40 characters. `lastUsedAt` is absent until the first
 * sign-in; `backedUp` is shown as "synced".
 */
export const PasskeyCred = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,1366}$/),
  pk: z.string().min(1).max(2048),
  counter: z.number().int().min(0),
  transports: z.array(z.string().max(20)).max(8).default([]),
  name: z.string().min(1).max(PASSKEY_NAME_MAX),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  aaguid: z.string().max(36).default(""),
  backedUp: z.boolean().optional(),
});
export type PasskeyCredValue = z.output<typeof PasskeyCred>;

/**
 * Rules 2401-2403: `passkeys:{pid}`, one person's passkeys. `uid` is the WebAuthn user handle (32 random bytes,
 * base64url), never the pid or the address, kept across address moves. `born` is the person's `createdAt` when the set
 * was created (`getPerson(pid).createdAt`, rule 2402): a set whose `born` differs from the person's is ignored. At most
 * 10 credentials. A record that does not fit reads as "no passkeys" (fail closed) and is logged by shape only.
 */
export const PasskeySet = z.looseObject({
  v: z.literal(1),
  uid: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  born: z.string().optional(),
  creds: z.array(PasskeyCred).max(PASSKEYS_MAX),
});
export type PasskeySetValue = z.output<typeof PasskeySet>;
