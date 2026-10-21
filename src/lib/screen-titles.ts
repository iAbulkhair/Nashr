import type { Metadata } from "next";
import { ADMIN_LABEL, type AdminSection } from "./admin-gate";
import { appDict } from "./app-i18n";
import { dict, isLang, type Lang } from "./i18n";
import { SETTINGS_COPY, type SettingsSection } from "./settings-nav";
import { SW } from "./staff-words";

/**
 * Every app and founder-console screen's own `<title>` (rule 961, WCAG 2.4.2): «الشاشة · ذكين» / "Screen · Thakeen".
 * Before this, all 31 app and 9 admin pages shared the site's default title, so the browser tab, the history list and
 * Next's route announcer (which reads the new title to a screen reader after a client navigation) said the same thing on
 * every screen. Names come from the app dictionary's sidebar labels where the sidebar names the screen, so the tab and
 * the link that opened it agree; the founder console uses its own sidebar labels (`ADMIN_LABEL`).
 */
export const APP_SCREENS = [
  "home", "activity", "admin", "calendar", "chat", "conversations", "files", "forgot", "generate", "help", "inspo",
  "instructions", "join", "login", "mcp", "notifications", "partner", "refer", "reports", "reset", "settings", "signup", "start", "tasks",
  "todo", "verify", "workspaces",
] as const;
export type AppScreen = (typeof APP_SCREENS)[number];

const nav = (lang: Lang) => appDict[lang].nav;

/** The screen's name in each language. */
export const APP_SCREEN_NAME: Record<Lang, Record<AppScreen, string>> = {
  ar: {
    home: nav("ar").inbox, activity: nav("ar").activity, admin: nav("ar").adminPanel, calendar: nav("ar").calendar,
    chat: nav("ar").chat, conversations: nav("ar").history, files: nav("ar").files, forgot: "نسيت كلمة المرور",
    generate: nav("ar").generate, help: nav("ar").help, inspo: nav("ar").inspo, instructions: nav("ar").instructions, join: "الانضمام إلى فريق",
    login: "تسجيل الدخول", mcp: "ربط مساعدك الذكي", notifications: nav("ar").notifications, partner: "برنامج الشركاء",
    refer: nav("ar").refer, reports: nav("ar").reports, reset: "كلمة مرور جديدة", settings: nav("ar").settings,
    signup: "إنشاء حساب", start: "ابدأ", tasks: nav("ar").tasks, todo: nav("ar").todo, verify: "تأكيد البريد", workspaces: appDict.ar.workspaces.title,
  },
  en: {
    home: nav("en").inbox, activity: nav("en").activity, admin: nav("en").adminPanel, calendar: nav("en").calendar,
    chat: nav("en").chat, conversations: nav("en").history, files: nav("en").files, forgot: "Forgot password",
    generate: nav("en").generate, help: nav("en").help, inspo: nav("en").inspo, instructions: nav("en").instructions, join: "Join a team",
    login: "Log in", mcp: "Connect your AI assistant", notifications: nav("en").notifications, partner: "Partner programme",
    refer: nav("en").refer, reports: nav("en").reports, reset: "New password", settings: nav("en").settings,
    signup: "Sign up", start: "Get started", tasks: nav("en").tasks, todo: "My to-dos", verify: "Verify your email", workspaces: appDict.en.workspaces.title,
  },
};

/** «اسم الشاشة · ذكين». The brand word comes last so the tab still names the screen when it is cut short. */
export const screenTitle = (lang: Lang, name: string) => `${name} · ${dict[lang].brand}`;

type LangParams = { params: Promise<{ lang: string }> };

/** `export const generateMetadata = appScreenMeta("chat");` in a page under /{lang}/app. */
export const appScreenMeta = (screen: AppScreen) => async ({ params }: LangParams): Promise<Metadata> => {
  const { lang } = await params;
  return isLang(lang) ? { title: screenTitle(lang, APP_SCREEN_NAME[lang][screen]) } : {};
};

/**
 * A settings section under /{lang}/app/settings (rule 1140): «الأمان · الإعدادات · ذكين». The section's name comes
 * first, then the area's, so the notification feed («التنبيهات · ذكين») and its preferences never share a title.
 */
export const settingsScreenMeta = (section: SettingsSection) => async ({ params }: LangParams): Promise<Metadata> => {
  const { lang } = await params;
  return isLang(lang) ? { title: screenTitle(lang, `${SETTINGS_COPY[lang].sections[section].name} · ${SETTINGS_COPY[lang].title}`) } : {};
};

/** The same for a founder console section under /{lang}/admin. */
export const adminScreenMeta = (section: AdminSection) => async ({ params }: LangParams): Promise<Metadata> => {
  const { lang } = await params;
  return isLang(lang) ? { title: screenTitle(lang, ADMIN_LABEL[lang][section]) } : {};
};

/** The staff pages under /{lang}/admin (rules 1631, 1638): sign-in, setup, staff list, own account. */
export type StaffScreen = "login" | "setup" | "staff" | "account";
const STAFF_SCREEN_WORD = { login: "signInTitle", setup: "setupTitle", staff: "staffTitle", account: "accountTitle" } as const;

/**
 * `export const generateMetadata = staffScreenMeta("login");` in a staff page: its title, and never indexed (rule
 * 1653; the console layout says the same, and src/proxy.ts adds `x-robots-tag` and `Cache-Control: no-store`).
 */
export const staffScreenMeta = (screen: StaffScreen) => async ({ params }: LangParams): Promise<Metadata> => {
  const { lang } = await params;
  return { robots: { index: false, follow: false }, ...(isLang(lang) ? { title: screenTitle(lang, SW[lang][STAFF_SCREEN_WORD[screen]]) } : {}) };
};

/** The skip link's words (rule 968): the first focusable thing in the app and console shells, to `<main id="main">`. */
export const SKIP_TO_CONTENT: Record<Lang, string> = { ar: "تخطَّ إلى المحتوى", en: "Skip to content" };
