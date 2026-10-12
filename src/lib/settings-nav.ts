import type { Lang } from "./i18n";

/**
 * The settings area (UI/UX phase 3, rules 1140-1142): one place for the account, its security, notifications, the brand
 * file, brands, members, billing, connections, governance and the danger zone, at /{lang}/app/settings/{section}. Pure
 * data, no React and no server import, so the proxy, the server layout and the client nav all read the same list.
 */
export const SETTINGS_SECTIONS = ["account", "security", "notifications", "brand", "brands", "members", "billing", "connections", "governance", "danger"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const isSettingsSection = (v: unknown): v is SettingsSection => typeof v === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(v);

/** `/{lang}/app/settings` or one section of it. */
export const settingsHref = (lang: Lang, section?: SettingsSection) => `/${lang}/app/settings${section ? `/${section}` : ""}`;

/**
 * The old scattered routes and the section that replaced each (rule 1141). Expand step: for one release the proxy
 * answers each old path with a temporary redirect (307, so a rollback finds its old pages again and no browser caches the
 * move for good) to the new one, keeping the query string, because emails already sent, bell entries already stored and
 * bookmarks still name them. Contract step (a later release, docs/system/tests/1140-uiux-phase3.md): drop entries here
 * once nothing new links to them; `billing` and `profile` stay longest, since lifecycle and billing emails named them.
 * `/app/notifications` is not here: it stays the notification feed (the bell's "see all"); its preferences moved.
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

const LEGACY_PATH = new RegExp(`^/(ar|en)/app/(${Object.keys(LEGACY_SETTINGS).join("|")})/?$`);

/** The settings path an old route moved to, or null for any other path. Only the exact page path matches. */
export function legacySettingsPath(pathname: string): string | null {
  const m = LEGACY_PATH.exec(pathname);
  if (!m) return null;
  return settingsHref(m[1] as Lang, LEGACY_SETTINGS[m[2]]);
}

/** Each section's name and one line of what it holds, in both languages. */
export const SETTINGS_COPY: Record<Lang, { title: string; sub: string; back: string; nav: string; prefsLink: string; sections: Record<SettingsSection, { name: string; sub: string }> }> = {
  ar: {
    title: "الإعدادات",
    sub: "حسابك وأمانه وتنبيهاته، وملف علامتك وفريقك واشتراكك، كلها هنا.",
    back: "كل الإعدادات",
    nav: "أقسام الإعدادات",
    prefsLink: "تفضيلات التنبيهات",
    sections: {
      account: { name: "الحساب", sub: "اسمك ولغتك ورقم الجوال." },
      security: { name: "الأمان", sub: "كلمة المرور والخروج من الأجهزة الأخرى." },
      notifications: { name: "التنبيهات", sub: "ما يصلك داخل التطبيق وبالبريد." },
      brand: { name: "ملف العلامة", sub: "ما تعرفه نور وفريقها عن علامتك." },
      brands: { name: "العلامات", sub: "أضف علامة أو بدّل بينها." },
      members: { name: "الأعضاء", sub: "من يشارك الحساب وأدوارهم." },
      billing: { name: "الاشتراك", sub: "خطتك ورصيدك وطرق الدفع." },
      connections: { name: "التكاملات", sub: "المتجر والحسابات المربوطة." },
      governance: { name: "الحوكمة", sub: "حدود الوكلاء والموافقة التلقائية." },
      danger: { name: "منطقة الخطر", sub: "حذف الحساب أو مغادرة الفريق." },
    },
  },
  en: {
    title: "Settings",
    sub: "Your account, its security and notifications, your brand file, team and plan, all in one place.",
    back: "All settings",
    nav: "Settings sections",
    prefsLink: "Notification preferences",
    sections: {
      account: { name: "Account", sub: "Your name, language and phone." },
      security: { name: "Security", sub: "Password and signing out other devices." },
      notifications: { name: "Notifications", sub: "What reaches you in the app and by email." },
      brand: { name: "Brand file", sub: "What Noor and the team know about your brand." },
      brands: { name: "Brands", sub: "Add a brand or switch between them." },
      members: { name: "Members", sub: "Who shares the account, and their roles." },
      billing: { name: "Billing", sub: "Your plan, credits and how you pay." },
      connections: { name: "Integrations", sub: "Your store and linked accounts." },
      governance: { name: "Governance", sub: "Agent limits and auto-approval." },
      danger: { name: "Danger zone", sub: "Delete the account or leave the team." },
    },
  },
};
