/**
 * The founder console's sections and links (rules 870-873). It lives at /{lang}/admin, its own route tree with its own
 * layout, never inside the customer app's layout. Client-safe: no runtime imports, so the admin sidebar and the
 * customer account menu can both use it. The gate itself is server code: src/lib/admin-gate-server.ts.
 */
export const ADMIN_SECTIONS = ["overview", "users", "leads", "usage", "billing", "partners", "quality", "skills", "integrations", "mail", "wishlist", "log"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** Each section's name: the admin sidebar's link and the page's `<title>` (src/lib/screen-titles.ts). */
export const ADMIN_LABEL: Record<"en" | "ar", Record<AdminSection, string>> = {
  en: { overview: "Overview", users: "Users", leads: "Leads", usage: "Usage", billing: "Billing", partners: "Partners", quality: "Quality", skills: "Agent skills", integrations: "Integrations", mail: "Mail preview", wishlist: "Wishlist", log: "Audit log" },
  ar: { overview: "نظرة عامة", users: "المستخدمون", leads: "العملاء المحتملون", usage: "الاستخدام", billing: "الفوترة", partners: "الشركاء", quality: "الجودة", skills: "مهارات الوكلاء", integrations: "التكاملات", mail: "معاينة الرسائل", wishlist: "الأمنيات", log: "سجل الإجراءات" },
};

/** `/{lang}/admin` for the overview, `/{lang}/admin/{section}` for the others. */
export const adminHref = (lang: "ar" | "en", s: AdminSection) => (s === "overview" ? `/${lang}/admin` : `/${lang}/admin/${s}`);

/**
 * Whether /{lang}/admin?login=1 shows the key form (rules 870, 2230). Only a staff session or a live key session skip
 * it: the founder's customer session (rule 1649) opens the console too, but it is not a key session, and the founder
 * banner sends it here to open one so the first staff login can be created (rule 1639). Gating on "any console
 * session" sent that link back to the overview in a loop.
 */
export const showKeyForm = (login: string | undefined, id: { staff: unknown; keySession: boolean }) => login === "1" && !id.staff && !id.keySession;

/** Fired on `window` when the Leads section has shown the new leads, so the sidebar badge clears. */
export const ADMIN_LEADS_SEEN = "admin:leads-seen";
