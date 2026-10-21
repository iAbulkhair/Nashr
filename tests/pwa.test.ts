import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import manifest from "@/app/manifest";
import { proxy, config as proxyConfig } from "@/proxy";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { APPLE_ICON_FILE, INSTALL_COPY, INSTALL_DISMISS_KEY, PWA_BACKGROUND_TOKEN, PWA_ICONS, PWA_THEME_TOKEN, dismissHint, hintDismissed, installWay } from "@/lib/pwa";

/**
 * Rules 681-684 (2026-10-08, spec docs/superpowers/specs/2026-10-08-pwa-install-design.md): Thakeen installs to the home
 * screen from a web app manifest, with apple-web-app tags and a placeholder icon set, no service worker, and a dismissible
 * hint in the signed-in app shell.
 */

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "", style: {} });
  return { IBM_Plex_Mono: font, IBM_Plex_Sans_Arabic: font };
});
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "", style: {} }) }));

/** Width and height from a PNG's IHDR chunk, or null when the file is not a PNG. */
function pngSize(file: string): { w: number; h: number } | null {
  const b = readFileSync(file);
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || b.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const token = (name: string) => {
  const m = readFileSync("src/app/tokens.css", "utf8").match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"));
  return m?.[1].toLowerCase();
};

describe("rule 681: the manifest makes the app installable, Arabic first, opening in the person's language", () => {
  const m = manifest();

  it("names the app with the official name and opens standalone from /app inside the whole-site scope", () => {
    expect(m.name).toBe("ذكين | Thakeen");
    expect(m.short_name).toBe("ذكين");
    expect(m.description).toBe(SITE_DEFAULT.ar.description);
    expect(m.lang).toBe("ar");
    expect(m.dir).toBe("rtl");
    expect(m.start_url).toBe("/app");
    expect(m.id).toBe("/app");
    expect(m.scope).toBe("/");
    expect(m.start_url!.startsWith(m.scope!)).toBe(true);
    expect(m.display).toBe("standalone");
  });

  it("takes its colours from the design tokens: paper like the mobile app header, ground behind it", () => {
    expect([PWA_THEME_TOKEN, PWA_BACKGROUND_TOKEN]).toEqual(["paper", "ground"]);
    expect(m.theme_color).toBe(token("paper"));
    expect(m.background_color).toBe(token("ground"));
  });

  it("lists 192 and 512 icons and a 512 maskable one, each a PNG of exactly that size in public/", () => {
    const icons = m.icons ?? [];
    const key = (i: { sizes?: string; purpose?: string }) => `${i.sizes} ${i.purpose ?? "any"}`;
    expect(icons.map(key).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const i of icons) {
      expect(i.type).toBe("image/png");
      const file = join("public", i.src);
      expect(existsSync(file), file).toBe(true);
      const [w, h] = i.sizes!.split("x").map(Number);
      expect(pngSize(file), file).toEqual({ w, h });
    }
    expect(PWA_ICONS.length).toBe(icons.length);
  });

  it("/app redirects (307) to the app in the language the person uses: cookie, then Accept-Language, default Arabic", () => {
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url: "/app" })).toBe(true);
    const go = (headers: Record<string, string> = {}, path = "/app") => proxy(new NextRequest(`https://thakeen.example${path}`, { headers }));
    const at = (r: Response) => new URL(r.headers.get("location")!).pathname;
    const plain = go();
    expect(plain.status).toBe(307);
    expect(at(plain)).toBe("/ar/app");
    expect(at(go({ "accept-language": "en-US,en;q=0.9" }))).toBe("/en/app");
    expect(at(go({ "accept-language": "ar-SA,en;q=0.8" }))).toBe("/ar/app");
    expect(at(go({ cookie: "nashr_lang=en", "accept-language": "ar" }))).toBe("/en/app");
    expect(at(go({ cookie: "nashr_lang=ar", "accept-language": "en" }))).toBe("/ar/app");
    // The root keeps its own redirect, and app pages still only get x-pathname.
    expect(at(go({}, "/"))).toBe("/ar");
    expect(go({}, "/ar/app/chat").headers.get("location")).toBeNull();
  });
});

describe("rule 682: iOS gets the apple-web-app tags and a 180 apple-touch-icon (placeholder mark until the logo exists)", () => {
  it("every language sets capable, the brand word as the home-screen title, a plain status bar, and the legacy apple tag", async () => {
    const { generateMetadata } = await import("@/app/[lang]/layout");
    for (const [lang, brand] of [["ar", "ذكين"], ["en", "Thakeen"]] as const) {
      const meta = await generateMetadata({ params: Promise.resolve({ lang }) });
      expect(meta.appleWebApp, lang).toEqual({ capable: true, title: brand, statusBarStyle: "default" });
      expect(meta.other, lang).toMatchObject({ google: "notranslate", "apple-mobile-web-app-capable": "yes" });
    }
  });

  it("the apple-icon file convention holds a 180x180 PNG at the app root, so every page links it", () => {
    expect(APPLE_ICON_FILE).toBe("src/app/apple-icon.png");
    expect(pngSize(APPLE_ICON_FILE)).toEqual({ w: 180, h: 180 });
  });

  it("the icon script writes exactly the files the manifest and the apple icon name", () => {
    const script = readFileSync("scripts/make-pwa-icons.mjs", "utf8");
    for (const i of PWA_ICONS) expect(script).toContain(`"public${i.src}"`);
    expect(script).toContain(`"${APPLE_ICON_FILE}"`);
    expect(script).toMatch(/PLACEHOLDER/);
    expect(script).not.toMatch(/<text|font-family/); // drawn, never typeset: no font file or licence involved
  });
});

describe("rule 683 (narrowed by rule 2569): one push-only worker, so nothing on the device caches a signed-in page", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

  it("ships only public/sw.js, registered only by the push switch, with no fetch handler and no Cache API", () => {
    const pub = walk("public").map((p) => p.toLowerCase());
    expect(pub.filter((p) => /(^|\/)(sw|service-?worker|workbox)[^/]*\.js$/.test(p))).toEqual([join("public", "sw.js")]);
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).not.toMatch(/addEventListener\(\s*["'](fetch|install|activate)["']|\bcaches\b|importScripts|Workbox/);
    expect(sw).toMatch(/addEventListener\(\s*"push"/);
    const src = walk("src").filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
    expect(src.filter((p) => /serviceWorker\s*\.\s*register/.test(readFileSync(p, "utf8")))).toEqual([join("src", "components", "app", "PushToggle.tsx")]);
    expect(src.filter((p) => /caches\s*\.\s*open|new\s+Workbox/.test(readFileSync(p, "utf8")))).toEqual([]);
    expect(manifest()).not.toHaveProperty("serviceworker");
  });

  it("app pages stay request-time (the layout reads headers and the session) and no config marks them cacheable", () => {
    const layout = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(layout).toMatch(/await headers\(\)/);
    expect(layout).toMatch(/await currentUser\(\)/);
    expect(readFileSync("next.config.ts", "utf8")).not.toMatch(/cache-control|s-maxage|stale-while-revalidate/i);
  });
});

describe("rule 684: the install hint fits the browser, says only what installing does, and stays dismissed", () => {
  const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1";
  const IPHONE_INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0";
  const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

  it("iPhone and iPad Safari get the steps; other iOS browsers and in-app views get nothing", () => {
    const off = { standalone: false, hasPrompt: false };
    expect(installWay(IPHONE_SAFARI, off)).toBe("ios");
    expect(installWay(IPAD_DESKTOP, { ...off, touchPoints: 5 })).toBe("ios");
    expect(installWay(IPAD_DESKTOP, { ...off, touchPoints: 0 })).toBe("none"); // a Mac's Safari
    expect(installWay(IPHONE_CHROME, off)).toBe("none");
    expect(installWay(IPHONE_INSTAGRAM, off)).toBe("none");
  });

  it("elsewhere the hint waits for beforeinstallprompt, and nothing shows once running from the home screen", () => {
    expect(installWay(ANDROID_CHROME, { standalone: false, hasPrompt: false })).toBe("none");
    expect(installWay(ANDROID_CHROME, { standalone: false, hasPrompt: true })).toBe("prompt");
    for (const ua of [IPHONE_SAFARI, ANDROID_CHROME]) expect(installWay(ua, { standalone: true, hasPrompt: true })).toBe("none");
  });

  it("dismissal is remembered in localStorage, and storage that throws neither hides the hint nor breaks the page", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(hintDismissed(store)).toBe(false);
    dismissHint(store, 1_791_460_000_000);
    expect(mem.get(INSTALL_DISMISS_KEY)).toBe("1791460000000");
    expect(hintDismissed(store)).toBe(true);
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(hintDismissed(broken)).toBe(false);
    expect(() => dismissHint(broken)).not.toThrow();
    expect(hintDismissed(undefined)).toBe(false);
    expect(() => dismissHint(undefined)).not.toThrow();
  });

  it("the copy is the steps and what installing does, in both languages, with no speed, offline or notification promise", () => {
    expect(Object.keys(INSTALL_COPY.ar).sort()).toEqual(Object.keys(INSTALL_COPY.en).sort());
    for (const v of Object.values(INSTALL_COPY.ar)) expect(v).toMatch(/[؀-ۿ]/);
    const all = [...Object.values(INSTALL_COPY.ar), ...Object.values(INSTALL_COPY.en)].join(" ");
    expect(all).not.toMatch(/offline|faster|quick|instant|notif|push|alert|بدون (إنترنت|انترنت|اتصال)|أسرع|فوري|إشعار|تنبيه/i);
    expect(INSTALL_COPY.ar.iosBody).toContain("«إضافة إلى الشاشة الرئيسية»");
    expect(INSTALL_COPY.en.iosBody).toContain("Add to Home Screen");
  });

  it("renders only in the signed-in shell, reads storage only through the guarded helpers, and keeps the native prompt for the button", () => {
    const layout = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(layout.indexOf("<InstallHint lang={lang} />")).toBeGreaterThan(layout.indexOf("if (!user) {"));
    expect(layout.match(/<InstallHint/g)).toHaveLength(1);
    const hint = readFileSync("src/components/app/InstallHint.tsx", "utf8");
    expect(hint).toMatch(/try \{ return window\.localStorage; \} catch \{ return undefined; \}/);
    expect(hint.match(/\blocalStorage\s*[.[]|window\.localStorage/g)).toHaveLength(1); // the one read, inside store()
    expect(hint).toMatch(/hintDismissed\(store\(\)\)/);
    expect(hint).toMatch(/dismissHint\(store\(\)\)/);
    expect(hint).toMatch(/"beforeinstallprompt"/);
    expect(hint).toMatch(/e\.preventDefault\(\)/);
    expect(hint).toMatch(/"appinstalled"/);
  });
});
