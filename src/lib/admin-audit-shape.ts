/**
 * The audit log's client-safe half (rule 1179): the section names and the before/after diff the Log page shows. No
 * imports, so the console can use them without pulling the store into the browser bundle; `admin-audit.ts` (the only
 * writer, server only) re-exports the section names from here.
 */

/** Where a row came from, for the Log page's filter. */
export const AUDIT_SECTIONS = ["users", "billing", "partners", "quality", "wishlist", "system", "data"] as const;
export type AuditSection = (typeof AUDIT_SECTIONS)[number];

/** One changed value: its key (empty for a value that is not an object), and the value before and after as text. */
export type AuditChange = { key: string; before: string; after: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A value as one line of text: text as it is, nothing as an empty string, anything else as JSON. */
export const auditText = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * The keys whose value changed between `before` and `after`, in the order they first appear (rule 1179). Two objects
 * compare key by key, one level deep (a nested value is compared and shown as JSON); anything else is one change with an
 * empty key. Nothing changed, or no before and after at all, is an empty list. A row written before the change shows
 * the same way: its `before` and `after` were already plain values.
 */
export function auditDiff(before: unknown, after: unknown): AuditChange[] {
  if (before === undefined && after === undefined) return [];
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => ({ key: k, before: auditText(before[k]), after: auditText(after[k]) }));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ key: "", before: auditText(before), after: auditText(after) }];
}
