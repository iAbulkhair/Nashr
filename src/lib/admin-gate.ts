/**
 * The founder console's sections and links (rules 870-873). It lives at /{lang}/admin, its own route tree with its own
 * layout, never inside the customer app's layout. Client-safe: no runtime imports, so the admin sidebar and the
 * customer account menu can both use it. The gate itself is server code: src/lib/admin-gate-server.ts.
 */
export const ADMIN_SECTIONS = ["overview", "users", "leads", "usage", "billing", "partners", "quality", "wishlist", "log"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** `/{lang}/admin` for the overview, `/{lang}/admin/{section}` for the others. */
export const adminHref = (lang: "ar" | "en", s: AdminSection) => (s === "overview" ? `/${lang}/admin` : `/${lang}/admin/${s}`);

/** Fired on `window` when the Leads section has shown the new leads, so the sidebar badge clears. */
export const ADMIN_LEADS_SEEN = "admin:leads-seen";
