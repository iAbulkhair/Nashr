import { z } from "zod";
import { log } from "./log";

/**
 * Read validation for stored shapes (rules 2035-2039, docs/system/flows.md section 82).
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
