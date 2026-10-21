import type { Lang } from "./app";

/**
 * The route inventory, as data. Every marketing route pattern the app serves, with the assertion that proves the right
 * page loaded rather than a generic shell. `unique` is matched against the page's own text.
 */
export type PublicRoute = {
  /** Path without the language prefix, "" for the home page. */
  path: string;
  /** A distinctive string the page renders. Taken from the real page, not invented. */
  unique: Record<Lang, string>;
  /** The page is expected to carry its own <title>, distinct from the site default. */
  ownTitle: boolean;
};

/** The title the root layout applies when a page exports no metadata of its own. */
export const DEFAULT_TITLE: Record<Lang, string> = {
  // The founder's slogan (2026-10-01), as the homepage h1 shows it: src/lib/page-meta.ts `SITE_DEFAULT`.
  en: "Thakeen. Smart. Steadfast.",
  ar: "ذكين. الذكي المكين.",
};

export const PUBLIC_ROUTES: PublicRoute[] = [
  // The cover's offer line (src/lib/home.ts `HERO.offer`, rule 516).
  { path: "", unique: { en: "Eight agents who know your brand.", ar: "ثمانية وكلاء يعرفون علامتك." }, ownTitle: false },
  { path: "/pricing", unique: { en: "SAR", ar: "ريال" }, ownTitle: true },
  { path: "/tools", unique: { en: "free Arabic marketing tools", ar: "أداة تسويق مجانية" }, ownTitle: true },
  { path: "/agents", unique: { en: "Eight agents", ar: "ثمانية وكلاء" }, ownTitle: true },
  { path: "/blog", unique: { en: "Blog", ar: "المدونة" }, ownTitle: true },
  { path: "/help", unique: { en: "Help center", ar: "مركز المساعدة" }, ownTitle: true },
  { path: "/privacy", unique: { en: "Privacy Policy", ar: "سياسة الخصوصية" }, ownTitle: true },
  { path: "/terms", unique: { en: "Terms of Service", ar: "شروط الاستخدام" }, ownTitle: true },
  { path: "/customers", unique: { en: "Who Thakeen is built for", ar: "لمن بُني ذكين" }, ownTitle: true },
  { path: "/enterprise", unique: { en: "Many brands, one team", ar: "عدة علامات، فريق واحد" }, ownTitle: true },
  { path: "/resources", unique: { en: "Learn, try and compare", ar: "تعلّم، جرّب، وقارن" }, ownTitle: true },
  { path: "/updates", unique: { en: "What we shipped, and what we build next", ar: "ما أطلقناه، وما نبنيه بعده" }, ownTitle: true },
  { path: "/affiliates", unique: { en: "Earn 15% of every payment", ar: "اكسب 15% من كل دفعة" }, ownTitle: true },
  { path: "/affiliates/terms", unique: { en: "Partner programme terms", ar: "شروط برنامج الشركاء" }, ownTitle: true },
  { path: "/ai-marketing-agent", unique: { en: "What is an AI Marketing Agent?", ar: "ما هو وكيل التسويق" }, ownTitle: true },
  { path: "/agents/noor", unique: { en: "Noor", ar: "نور" }, ownTitle: true },
  { path: "/tools/hook-generator", unique: { en: "Hook Generator", ar: "مولّد هوكات" }, ownTitle: true },
  { path: "/for/ecommerce", unique: { en: "store", ar: "متجرك يبي محتوى" }, ownTitle: true },
  { path: "/compare", unique: { en: "Thakeen compared with the alternatives", ar: "ذكين مقارنةً بالبدائل" }, ownTitle: true },
  { path: "/blog/ramadan-marketing-guide-2026", unique: { en: "Ramadan Marketing", ar: "تسويق رمضان" }, ownTitle: true },
];

/**
 * The authenticated route patterns under /[lang]/app. `heading` is the page's own first-level heading, taken from the
 * running app, and is what proves the named page loaded rather than the shell around it.
 */
/**
 * `ownerGoesTo`: the page sends the signed-in, seeded owner elsewhere instead of rendering. `/app/start` is the
 * first-login game, shown only to an owner without a brand file (rule 524); the seeded owner has one.
 */
export type AppRoute = { path: string; heading: Partial<Record<Lang, string>> & { en: string }; ownerGoesTo?: string };

/** Reachable only with a session. Every one of these redirects a signed-out visitor to the login page. */
export const APP_ROUTES: AppRoute[] = [
  // The brand pages live under /app/b/{id} (rule 885); the seeded owner's brand is "default". `/app` itself goes there.
  { path: "/app", heading: { en: "Approval inbox" }, ownerGoesTo: "/app/b/default" },
  { path: "/app/b/default", heading: { en: "Approval inbox" } },
  { path: "/app/b/default/todo", heading: { en: "My to-dos" } },
  { path: "/app/b/default/tasks", heading: { en: "Scheduled tasks" } },
  { path: "/app/b/default/calendar", heading: { en: "Calendar" } },
  { path: "/app/b/default/chat", heading: { en: "Noor" } },
  { path: "/app/b/default/conversations", heading: { en: "Chat history" } },
  { path: "/app/b/default/generate", heading: { en: "What do you need from Noor today?" } },
  { path: "/app/b/default/reports", heading: { en: "Performance" } },
  { path: "/app/b/default/files", heading: { en: "Files" } },
  // The settings area (UI/UX phase 3, rule 1140); the old paths answer a 307 to these for one release.
  { path: "/app/settings", heading: { en: "Settings" } },
  { path: "/app/settings/account", heading: { en: "Account" } },
  { path: "/app/settings/security", heading: { en: "Security" } },
  { path: "/app/b/default/settings/notifications", heading: { en: "Notifications" } },
  { path: "/app/settings/brands", heading: { en: "Brands" } },
  { path: "/app/b/default/settings/governance", heading: { en: "Governance" } },
  { path: "/app/settings/danger", heading: { en: "Danger zone" } },
  { path: "/app/b/default/activity", heading: { en: "Activity" } },
  { path: "/app/settings/members", heading: { en: "Members" } },
  { path: "/app/b/default/settings/connections", heading: { en: "Integrations" } },
  { path: "/app/b/default/inspo", heading: { en: "Gulf inspiration" } },
  { path: "/app/notifications", heading: { en: "Notifications" } },
  { path: "/app/b/default/settings/brand", heading: { en: "Introduce Noor to your brand" } },
  { path: "/app/refer", heading: { en: "Earn credits" } },
  { path: "/app/partner", heading: { en: "Partner" } },
  { path: "/app/mcp", heading: { en: "Noor inside Claude and ChatGPT (MCP)" } },
  { path: "/app/help", heading: { en: "Help center" } },
  { path: "/app/settings/billing", heading: { en: "Subscription" } },
  { path: "/app/b/default/start", heading: { en: "The Thakeen Dictionary" }, ownerGoesTo: "/app/b/default" },
];

/** Reachable without a session: the layout's PUBLIC list. */
/** `/app/join` accepts a team invite; its token travels in the URL fragment, so a plain visit shows "link incomplete". */
export const APP_PUBLIC_ROUTES = ["/app/login", "/app/signup", "/app/forgot", "/app/reset", "/app/admin", "/app/join"];
