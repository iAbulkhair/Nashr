import type { Lang } from "./i18n";
import { appHref, isBrandPath } from "./brand-path";

/**
 * The settings area (UI/UX phase 3, rules 1140-1142): one place for the account, its security, notifications, the brand
 * file, brands, members, billing, connections, governance and the danger zone, at /{lang}/app/settings/{section}. Pure
 * data, no React and no server import, so the proxy, the server layout and the client nav all read the same list.
 */
export const SETTINGS_SECTIONS = ["account", "security", "notifications", "brand", "brands", "members", "billing", "usage", "connections", "governance", "danger"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * The sections in two groups (rule 2006): what is yours alone (your account, its security, what reaches you) and what the
 * workspace shares (the brand, its people, plan, connections, limits, and the danger zone). Groups only label the list:
 * every section keeps its path, and together the groups hold each section once, in `SETTINGS_SECTIONS` order.
 */
export const SETTINGS_GROUPS = [
  { id: "you", sections: ["account", "security", "notifications"] },
  { id: "workspace", sections: ["brand", "brands", "members", "billing", "usage", "connections", "governance", "danger"] },
] as const satisfies readonly { id: string; sections: readonly SettingsSection[] }[];
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

/** The group a section sits in. */
export const groupOf = (s: SettingsSection): SettingsGroup => SETTINGS_GROUPS.find((g) => (g.sections as readonly string[]).includes(s))!.id;

export const isSettingsSection = (v: unknown): v is SettingsSection => typeof v === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(v);

/**
 * A section whose page shows or saves the brand's data (`sc(u)`), so it lives under `/{lang}/app/b/{id}/settings/{section}`
 * (R-C6, R-C10: brand, connections, governance, notifications). It asks `isBrandPath`, which reads the one list of brand
 * sections in brand-path.ts, so the two cannot drift.
 */
export const isBrandSettings = (s: SettingsSection): boolean => isBrandPath(`/settings/${s}`);

/** `/settings` or one section of it, what follows `/app`. */
export const settingsPath = (section?: SettingsSection) => `/settings${section ? `/${section}` : ""}`;

/**
 * The link to the settings area or one section, made by the caller's app-link builder (`useAppLink`, `useBrandHref`,
 * `pageHref`), which carries the workspace and the brand: a brand section with a brand is
 * `/{lang}/app[/w/{handle}]/b/{brand}/settings/{section}`; without a brand it is the old path, which the `[...legacy]`
 * page sends to the session's brand (one 307). An account section ignores the brand.
 */
export const settingsHref = (href: (path: string) => string, section?: SettingsSection) => href(settingsPath(section));

/**
 * The old scattered routes and the section that replaced each (rule 1141). Expand step: for one release the proxy
 * answers each old path with a temporary redirect (307, so a rollback finds its old pages again and no browser caches the
 * move for good) to the new one, keeping the query string, because emails already sent, bell entries already stored and
 * bookmarks still name them. Contract step (a later release, docs/system/tests/1140-uiux-phase3.md): drop entries here
 * once nothing new links to them; `billing` and `profile` stay longest, since lifecycle and billing emails named them.
 * `/app/notifications` is not here: it stays the notification feed (the bell's "see all"); its preferences moved.
 * The entries whose section is a brand section (rule 891) are answered by the `[...legacy]` page, not the proxy.
 */
export const LEGACY_SETTINGS: Readonly<Record<string, SettingsSection>> = {
  profile: "account",
  team: "members",
  brands: "brands",
  billing: "billing",
  onboarding: "brand",
  integrations: "connections",
  governance: "governance",
};

/**
 * The old names the proxy answers. `onboarding`, `integrations` and `governance` now land on brand sections, whose path
 * needs the session's brand id, which the proxy does not read: those three go on to the `[...legacy]` page
 * (src/app/[lang]/app/[...legacy]/page.tsx), which signs in and sends them to `/b/{id}/settings/{section}` in one hop.
 */
const PROXY_LEGACY = Object.keys(LEGACY_SETTINGS).filter((k) => !isBrandSettings(LEGACY_SETTINGS[k]));
const LEGACY_PATH = new RegExp(`^/(ar|en)/app/(${PROXY_LEGACY.join("|")})/?$`);

/** The settings path an old account route moved to, or null for any other path (a brand one included). Only the exact page path matches. */
export function legacySettingsPath(pathname: string): string | null {
  const m = LEGACY_PATH.exec(pathname);
  if (!m) return null;
  return settingsHref((p) => appHref(m[1] as Lang, p), LEGACY_SETTINGS[m[2]]);
}

/** Each section's name and one line of what it holds, in both languages. */
export const SETTINGS_COPY: Record<Lang, { title: string; sub: string; back: string; nav: string; prefsLink: string; groups: Record<SettingsGroup, string>; sections: Record<SettingsSection, { name: string; sub: string }> }> = {
  ar: {
    title: "الإعدادات",
    sub: "حسابك وأمانه وتنبيهاته، وملف علامتك وفريقك واشتراكك، كلها هنا.",
    back: "كل الإعدادات",
    nav: "أقسام الإعدادات",
    prefsLink: "تفضيلات التنبيهات",
    groups: { you: "أنت", workspace: "مساحة العمل" },
    sections: {
      account: { name: "الحساب", sub: "اسمك ولغتك ورقم الجوال." },
      security: { name: "الأمان", sub: "كلمة المرور والخروج من الأجهزة الأخرى." },
      notifications: { name: "التنبيهات", sub: "ما يصلك داخل التطبيق وبالبريد." },
      brand: { name: "ملف العلامة", sub: "ما تعرفه نور وفريقها عن علامتك." },
      brands: { name: "العلامات", sub: "أضف علامة أو بدّل بينها." },
      members: { name: "الأعضاء", sub: "من يشارك الحساب وأدوارهم." },
      billing: { name: "الاشتراك", sub: "خطتك ورصيدك وطرق الدفع." },
      usage: { name: "استخدام الذكاء", sub: "طلبات هذا الشهر حسب الشخص والعلامة والوكيل واليوم." },
      connections: { name: "التكاملات", sub: "المتجر والحسابات المربوطة." },
      governance: { name: "الحوكمة", sub: "حدود الوكلاء والموافقة التلقائية." },
      danger: { name: "منطقة الخطر", sub: "تنزيل بياناتك، أو حذف الحساب، أو مغادرة الفريق." },
    },
  },
  en: {
    title: "Settings",
    sub: "Your account, its security and notifications, your brand file, team and plan, all in one place.",
    back: "All settings",
    nav: "Settings sections",
    prefsLink: "Notification preferences",
    groups: { you: "You", workspace: "Workspace" },
    sections: {
      account: { name: "Account", sub: "Your name, language and phone." },
      security: { name: "Security", sub: "Password and signing out other devices." },
      notifications: { name: "Notifications", sub: "What reaches you in the app and by email." },
      brand: { name: "Brand file", sub: "What Noor and the team know about your brand." },
      brands: { name: "Brands", sub: "Add a brand or switch between them." },
      members: { name: "Members", sub: "Who shares the account, and their roles." },
      billing: { name: "Billing", sub: "Your plan, credits and how you pay." },
      usage: { name: "AI usage", sub: "This month's requests by person, brand, agent and day." },
      connections: { name: "Integrations", sub: "Your store and linked accounts." },
      governance: { name: "Governance", sub: "Agent limits and auto-approval." },
      danger: { name: "Danger zone", sub: "Download your data, delete the account or leave the team." },
    },
  },
};
