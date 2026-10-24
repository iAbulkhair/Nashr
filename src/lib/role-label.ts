/**
 * One place that turns a member's role into words for the founder console (customers list and workspace page, rule 3740).
 * Client-safe, no imports. It does not depend on the `Role` type of src/lib/auth.ts: the customer-roles phase adds `editor`
 * and `viewer` there, and a role this file has never heard of (a later one, a hand-edited row) must still show, as the
 * stored word, never as "undefined" or a crash. Names for the known ones are written out, so the console reads the same
 * before and after that phase lands.
 */
export type RoleLang = "ar" | "en";

const KNOWN: Record<string, Record<RoleLang, string>> = {
  owner: { ar: "المالك", en: "Owner" },
  admin: { ar: "مدير", en: "Admin" },
  member: { ar: "عضو", en: "Member" },
  editor: { ar: "محرّر", en: "Editor" },
  viewer: { ar: "مشاهد", en: "Viewer" },
};

/** A role as words. An unknown one is shown as the stored word (cut to 24 characters); a missing one as a dash. */
export function roleLabel(role: unknown, lang: RoleLang): string {
  if (typeof role !== "string" || !role) return "—";
  const known = Object.prototype.hasOwnProperty.call(KNOWN, role) ? KNOWN[role] : null;
  return known ? known[lang] : role.slice(0, 24);
}
