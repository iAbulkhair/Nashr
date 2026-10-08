/**
 * Installing Thakeen to the home screen (PWA, rules 681-684, spec docs/superpowers/specs/2026-10-08-pwa-install-design.md).
 * One manifest (src/app/manifest.ts), the apple-web-app tags in src/app/[lang]/layout.tsx and the install hint in the app
 * shell (src/components/app/InstallHint.tsx) all read from here. There is no service worker: nothing is cached on the
 * device, so a signed-in page is only ever what the server sends (rule 683). Push is phase 2.
 */

/** Public name per the official-name decision: Arabic first, English second. */
export const PWA_NAME = "ذكين | Thakeen";
export const PWA_SHORT_NAME = "ذكين";

/**
 * `/app` is answered by src/proxy.ts with a 307 to `/{lang}/app` (cookie `nashr_lang`, then Accept-Language, default
 * Arabic), so one manifest opens the app in the language the person uses. The app layout sends anyone signed out to login.
 */
export const PWA_START = "/app";

/**
 * The manifest's colours, as design-token names (assets/design-tokens.json; no hex in src/, rule 513): the mobile app
 * header is paper, the page behind it ground.
 */
export const PWA_THEME_TOKEN = "paper";
export const PWA_BACKGROUND_TOKEN = "ground";

/**
 * PLACEHOLDER: the icons are a drawn «ذ» letter mark, lemon on ink (scripts/make-pwa-icons.mjs), not the brand logo. The wordmark is set
 * in Thmanyah Serif Display, whose licence covers the website build only, so it is not rendered into image files. Replace
 * the four PNGs with the founder's logo at the same paths and sizes; the manifest and tests need no change.
 */
export const PWA_ICONS_ARE_PLACEHOLDER = true;

export const PWA_ICONS = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
] as const;

/** Served by the `apple-icon` file convention, which writes the `apple-touch-icon` link. */
export const APPLE_ICON_FILE = "src/app/apple-icon.png";

export type InstallWay = "ios" | "prompt" | "none";

/**
 * Which hint fits this browser. Already running from the home screen: none. iPhone and iPad Safari have no install event,
 * so they get the Share-menu steps (iPadOS reports a Mac with touch). Other iOS browsers and in-app views are skipped
 * because the steps differ there. Everywhere else the hint waits for `beforeinstallprompt` (`hasPrompt`).
 */
export function installWay(ua: string, opts: { standalone: boolean; hasPrompt: boolean; touchPoints?: number }): InstallWay {
  if (opts.standalone) return "none";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (opts.touchPoints ?? 0) > 1);
  if (ios) {
    const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV|Line\/|Snapchat|TikTok/.test(ua);
    return safari ? "ios" : "none";
  }
  return opts.hasPrompt ? "prompt" : "none";
}

/** localStorage key; the value is the dismissal time in ms. */
export const INSTALL_DISMISS_KEY = "nashr_install_hint_dismissed";

type Store = Pick<Storage, "getItem" | "setItem">;

/** Storage that throws (private mode, blocked site data) counts as not dismissed: the hint shows, nothing breaks. */
export function hintDismissed(store: Store | undefined): boolean {
  try { return !!store?.getItem(INSTALL_DISMISS_KEY); } catch { return false; }
}

export function dismissHint(store: Store | undefined, now: number = Date.now()): void {
  try { store?.setItem(INSTALL_DISMISS_KEY, String(now)); } catch { /* private window: the hint comes back next visit */ }
}

/** The hint's words. Steps and what installing does, nothing more: no speed, offline or notification promises. */
export const INSTALL_COPY = {
  ar: {
    iosTitle: "أضف ذكين إلى شاشتك الرئيسية",
    iosBody: "في Safari افتح قائمة المشاركة، ثم اختر «إضافة إلى الشاشة الرئيسية».",
    promptTitle: "ثبّت ذكين على جهازك",
    promptBody: "يظهر ذكين بين تطبيقاتك ويفتح في نافذة خاصة به.",
    install: "ثبّت",
    later: "ليس الآن",
  },
  en: {
    iosTitle: "Add Thakeen to your home screen",
    iosBody: "In Safari, open the Share menu, then choose “Add to Home Screen”.",
    promptTitle: "Install Thakeen on this device",
    promptBody: "Thakeen sits with your apps and opens in its own window.",
    install: "Install",
    later: "Not now",
  },
} as const;
