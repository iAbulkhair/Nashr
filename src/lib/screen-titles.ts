import type { Metadata } from "next";
import { ADMIN_LABEL, type AdminSection } from "./admin-gate";
import { appDict } from "./app-i18n";
import { dict, isLang, type Lang } from "./i18n";

/**
 * Every app and founder-console screen's own `<title>` (rule 961, WCAG 2.4.2): «الشاشة · ذكين» / "Screen · Thakeen".
 * Before this, all 31 app and 9 admin pages shared the site's default title, so the browser tab, the history list and
 * Next's route announcer (which reads the new title to a screen reader after a client navigation) said the same thing on
 * every screen. Names come from the app dictionary's sidebar labels where the sidebar names the screen, so the tab and
 * the link that opened it agree; the founder console uses its own sidebar labels (`ADMIN_LABEL`).
 */
export const APP_SCREENS = [
  "home", "activity", "admin", "billing", "brands", "calendar", "chat", "conversations", "files", "forgot", "generate",
  "governance", "help", "inspo", "integrations", "join", "login", "mcp", "notifications", "onboarding", "partner",
  "profile", "refer", "reports", "reset", "signup", "start", "tasks", "team", "todo", "verify",
] as const;
export type AppScreen = (typeof APP_SCREENS)[number];

const nav = (lang: Lang) => appDict[lang].nav;

/** The screen's name in each language. */
export const APP_SCREEN_NAME: Record<Lang, Record<AppScreen, string>> = {
  ar: {
    home: nav("ar").inbox, activity: nav("ar").activity, admin: nav("ar").adminPanel, billing: nav("ar").billing,
    brands: nav("ar").brands, calendar: nav("ar").calendar, chat: nav("ar").chat, conversations: nav("ar").history,
    files: nav("ar").files, forgot: "نسيت كلمة المرور", generate: nav("ar").generate, governance: nav("ar").governance,
    help: nav("ar").help, inspo: nav("ar").inspo, integrations: nav("ar").integrations, join: "الانضمام إلى فريق",
    login: "تسجيل الدخول", mcp: "ربط مساعدك الذكي", notifications: nav("ar").notifications, onboarding: nav("ar").brand,
    partner: "برنامج الشركاء", profile: nav("ar").profile, refer: nav("ar").refer, reports: nav("ar").reports,
    reset: "كلمة مرور جديدة", signup: "إنشاء حساب", start: "ابدأ", tasks: nav("ar").tasks, team: nav("ar").members,
    todo: nav("ar").todo, verify: "تأكيد البريد",
  },
  en: {
    home: nav("en").inbox, activity: nav("en").activity, admin: nav("en").adminPanel, billing: nav("en").billing,
    brands: nav("en").brands, calendar: nav("en").calendar, chat: nav("en").chat, conversations: nav("en").history,
    files: nav("en").files, forgot: "Forgot password", generate: nav("en").generate, governance: nav("en").governance,
    help: nav("en").help, inspo: nav("en").inspo, integrations: nav("en").integrations, join: "Join a team",
    login: "Log in", mcp: "Connect your AI assistant", notifications: nav("en").notifications, onboarding: nav("en").brand,
    partner: "Partner programme", profile: nav("en").profile, refer: nav("en").refer, reports: nav("en").reports,
    reset: "New password", signup: "Sign up", start: "Get started", tasks: nav("en").tasks, team: nav("en").members,
    todo: "My to-dos", verify: "Verify your email",
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

/** The same for a founder console section under /{lang}/admin. */
export const adminScreenMeta = (section: AdminSection) => async ({ params }: LangParams): Promise<Metadata> => {
  const { lang } = await params;
  return isLang(lang) ? { title: screenTitle(lang, ADMIN_LABEL[lang][section]) } : {};
};

/** The skip link's words (rule 968): the first focusable thing in the app and console shells, to `<main id="main">`. */
export const SKIP_TO_CONTENT: Record<Lang, string> = { ar: "تخطَّ إلى المحتوى", en: "Skip to content" };
