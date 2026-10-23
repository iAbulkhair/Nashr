// The public site's analytics switch, its consent banner, the dev-only picture hosts, the riyal formatter and the home
// page's drawing of the app (rules 3330-3352, docs/system/tests/3330-marketing-analytics.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import {
  ANALYTICS_ENV, ANALYTICS_PROVIDERS, UMAMI_CLOUD, analyticsAllowed, analyticsConfig, analyticsCsp, bannerNeeded, httpsOrigin,
  pageAddress, pageViewRequest, scriptTag, type AnalyticsConfig,
} from "@/lib/analytics";
import { CONSENT_COPY, clearAnalyticsLines, consentCookieLine, readConsent } from "@/lib/cookie-consent";
import { CONSENT_COOKIE } from "@/lib/cookie-names";
import { DEV_IMAGE_HOSTS, devImagePatterns } from "@/lib/dev-images";
import { CHARGED_CURRENCY, PLAN_PRICE_SAR, SELF_SERVE_PLANS, formatSar, planPriceLabel } from "@/lib/pricing";
import { MIN_ROLE, roleMeets, type Action } from "@/lib/roles";
import { APP_SCREEN_SPOT, RESULT_WORDS, ROLE_ROWS, SCREEN_AGENTS, appScreenStrings, roleRows } from "@/lib/home-app-screen";
import { dict, LANGS } from "@/lib/i18n";
import Footer from "@/components/Footer";
import Workspace from "@/components/home/Workspace";
import Plans from "@/components/home/Plans";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/ar",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

afterEach(() => vi.unstubAllEnvs());

const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

const GA = "G-ABC123XYZ9";
const MIXPANEL = "0123456789abcdef0123456789abcdef";
const POSTHOG = "phc_abcdefghijklmnopqrstuvwxyz0123";
const UMAMI = "4f2c1b5e-9a7d-4c3e-8b1a-2d3e4f5a6b7c";

/** One provider switched on, with a valid id, and every other analytics name empty. */
const ENVS: Record<string, Record<string, string>> = {
  google: { ANALYTICS_PROVIDER: "google", GA_MEASUREMENT_ID: GA },
  mixpanel: { ANALYTICS_PROVIDER: "mixpanel", MIXPANEL_PROJECT_TOKEN: MIXPANEL },
  posthog: { ANALYTICS_PROVIDER: "posthog", POSTHOG_PROJECT_KEY: POSTHOG },
  plausible: { ANALYTICS_PROVIDER: "plausible", PLAUSIBLE_DOMAIN: "thakeen.com" },
  umami: { ANALYTICS_PROVIDER: "umami", UMAMI_WEBSITE_ID: UMAMI },
};
const stubOnly = (env: Record<string, string>) => {
  for (const name of Object.values(ANALYTICS_ENV)) vi.stubEnv(name, env[name] ?? "");
};
const cfgOf = (p: string): AnalyticsConfig => analyticsConfig(ENVS[p])!;

/** Every host any provider could add to a policy. */
const ALL_HOSTS = [
  "googletagmanager.com", "google-analytics.com", "analytics.google.com", "mixpanel.com", "posthog.com", "plausible.io", "umami",
];

describe("rule 3330: one server-side switch, off by default, fails closed", () => {
  it("unset, empty, unknown or a missing id is off", () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "none" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "segment", GA_MEASUREMENT_ID: GA })).toBeNull();
    for (const p of ANALYTICS_PROVIDERS) expect(analyticsConfig({ ANALYTICS_PROVIDER: p }), p).toBeNull();
  });
  it("an id of the wrong shape is off, never a half-configured script", () => {
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "google", GA_MEASUREMENT_ID: "UA-1234-1" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "google", GA_MEASUREMENT_ID: `${GA}"><script>` })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "mixpanel", MIXPANEL_PROJECT_TOKEN: "xyz" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "posthog", POSTHOG_PROJECT_KEY: "phx_abc" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "plausible", PLAUSIBLE_DOMAIN: "https://thakeen.com/" })).toBeNull();
    expect(analyticsConfig({ ANALYTICS_PROVIDER: "umami", UMAMI_WEBSITE_ID: "not-a-uuid" })).toBeNull();
  });
  it("each provider with a valid id is on, and only that provider", () => {
    for (const p of ANALYTICS_PROVIDERS) expect(cfgOf(p).provider, p).toBe(p);
    expect(analyticsConfig({ ANALYTICS_PROVIDER: " Google ", GA_MEASUREMENT_ID: GA })?.provider).toBe("google");
  });
  it("with nothing set, the footer renders no banner, no settings link and no script, in both languages", () => {
    stubOnly({});
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(h(Footer, { t: dict[lang], lang }));
      expect(html).not.toContain("data-consent-banner");
      expect(html).not.toContain(CONSENT_COPY.settings[lang]);
      expect(html).not.toMatch(/<script/);
      for (const host of ALL_HOSTS) expect(html, host).not.toContain(host);
    }
  });
});

describe("rule 3331: only the public marketing pages carry it", () => {
  it("the footer, which only marketing pages render, is the one place the loader is mounted", () => {
    const users = files("src").filter((f) => /\.tsx?$/.test(f) && /analytics\/SiteAnalytics|analytics\/AnalyticsLoader/.test(code(f)));
    expect(users).toEqual(["src/components/Footer.tsx"]);
    const footerUsers = files("src/app").filter((f) => /components\/Footer"/.test(read(f)));
    for (const f of footerUsers) expect(f, f).not.toMatch(/\/app\/\[lang\]\/(app|admin)\//);
  });
});

describe("rule 3332: Google, Mixpanel and PostHog load nothing and send nothing before a yes", () => {
  for (const p of ["google", "mixpanel", "posthog"]) {
    it(`${p}: no script and not allowed until the consent cookie says yes`, () => {
      const cfg = cfgOf(p);
      expect(cfg.consent).toBe(true);
      for (const choice of [null, "no"] as const) {
        expect(analyticsAllowed(cfg, choice), String(choice)).toBe(false);
        expect(scriptTag(cfg, choice), String(choice)).toBeNull();
      }
      expect(analyticsAllowed(cfg, "yes")).toBe(true);
    });
  }
  it("Google's script is the only one, and only after yes; Mixpanel and PostHog never load a script", () => {
    expect(scriptTag(cfgOf("google"), "yes")?.src).toBe(`https://www.googletagmanager.com/gtag/js?id=${GA}`);
    expect(scriptTag(cfgOf("mixpanel"), "yes")).toBeNull();
    expect(scriptTag(cfgOf("posthog"), "yes")).toBeNull();
  });
  it("the server render never holds the script, even with Google switched on (the browser reads the cookie first)", () => {
    stubOnly(ENVS.google);
    const html = renderToStaticMarkup(h(Footer, { t: dict.ar, lang: "ar" }));
    expect(html).not.toContain("googletagmanager");
    expect(html).not.toMatch(/<script/);
    expect(html).not.toContain("data-consent-banner");
  });
  it("the loader asks the gate before every script and every request", () => {
    const src = code("src/components/analytics/AnalyticsLoader.tsx");
    expect(src).toMatch(/if \(!allowed \|\| !pathname\) return;/);
    expect(src).toMatch(/choice === undefined \? null : scriptTag\(cfg, choice\)/);
    expect(code("src/components/analytics/use-consent.ts")).toMatch(/\(\) => undefined\)/);
  });
});

describe("rule 3333: Plausible and Umami are cookieless, so no banner and the script loads at once", () => {
  for (const p of ["plausible", "umami"]) {
    it(`${p}: no consent needed, script present before any answer, no banner`, () => {
      const cfg = cfgOf(p);
      expect(cfg.consent).toBe(false);
      for (const choice of [null, "no", "yes"] as const) {
        expect(analyticsAllowed(cfg, choice)).toBe(true);
        expect(scriptTag(cfg, choice)?.src).toBe(cfg.script);
        expect(bannerNeeded(cfg, choice)).toBe(false);
      }
    });
    it(`${p}: the footer shows neither the banner nor the cookie-settings link`, () => {
      stubOnly(ENVS[p]);
      for (const lang of LANGS) {
        const html = renderToStaticMarkup(h(Footer, { t: dict[lang], lang }));
        expect(html).not.toContain("data-consent-banner");
        expect(html).not.toContain(CONSENT_COPY.settings[lang]);
      }
    });
  }
  it("Plausible gets its domain; Umami its website id and is told to leave out the query and the fragment", () => {
    expect(scriptTag(cfgOf("plausible"), null)).toEqual({ src: "https://plausible.io/js/script.js", attrs: { "data-domain": "thakeen.com" } });
    expect(scriptTag(cfgOf("umami"), null)).toEqual({
      src: `${UMAMI_CLOUD}/script.js`,
      attrs: { "data-website-id": UMAMI, "data-exclude-search": "true", "data-exclude-hash": "true" },
    });
  });
});

describe("rule 3334: page views only, no personal data, IP dropped where the provider allows", () => {
  const view = { origin: "https://thakeen.com", pathname: "/ar/pricing?email=a@b.c&ref=x#top", title: "الأسعار", anonId: "11111111-2222-4333-8444-555555555555", now: 1_760_000_000_000, eventId: "e" };
  it("the address is the origin and the path, never the query or the fragment", () => {
    expect(pageAddress("https://thakeen.com", "/ar/pricing?x=1#y")).toBe("https://thakeen.com/ar/pricing");
    expect(pageAddress("https://thakeen.com", "")).toBe("https://thakeen.com/");
  });
  for (const p of ["mixpanel", "posthog"]) {
    it(`${p}: one page-view event, no query, no email, no account`, () => {
      const req = pageViewRequest(cfgOf(p), view)!;
      const body = decodeURIComponent(req.body);
      expect(body).toContain("https://thakeen.com/ar/pricing");
      for (const bad of ["?", "email", "a@b.c", "ref=", "#top", "account", "user_id", "$ip"]) expect(body, bad).not.toContain(bad);
      expect(body).toContain(p === "mixpanel" ? "$mp_web_page_view" : "$pageview");
    });
  }
  it("Mixpanel's address carries ip=0; PostHog's event keeps off any person profile; Google's config turns signals off", () => {
    expect(cfgOf("mixpanel").endpoint).toMatch(/\?ip=0$/);
    expect(pageViewRequest(cfgOf("posthog"), view)!.body).toContain('"$process_person_profile":false');
    const src = read("src/lib/analytics.ts");
    expect(src).toMatch(/send_page_view: false, anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false/);
  });
  it("Plausible, Umami and Google send no request of the page's own", () => {
    for (const p of ["google", "plausible", "umami"]) expect(pageViewRequest(cfgOf(p), view), p).toBeNull();
  });
  it("the loader sends no event but the page view, without credentials", () => {
    const src = code("src/components/analytics/AnalyticsLoader.tsx");
    expect(src).toContain('credentials: "omit"');
    expect(src.match(/"event",/g)).toHaveLength(1);
    expect(src).toContain('"event", "page_view"');
  });
});

describe("rules 3335-3336: the banner shows only while a consent provider is on and unanswered", () => {
  it("bannerNeeded: off with no provider, off after any answer", () => {
    expect(bannerNeeded(null, null)).toBe(false);
    for (const p of ["google", "mixpanel", "posthog"]) {
      expect(bannerNeeded(cfgOf(p), null), p).toBe(true);
      expect(bannerNeeded(cfgOf(p), "yes"), p).toBe(false);
      expect(bannerNeeded(cfgOf(p), "no"), p).toBe(false);
    }
  });
  it("the banner and its copy come in Arabic and English", () => {
    for (const k of Object.keys(CONSENT_COPY) as (keyof typeof CONSENT_COPY)[]) {
      expect(CONSENT_COPY[k].ar, k).toMatch(/[؀-ۿ]/);
      expect(CONSENT_COPY[k].en, k).toMatch(/[A-Za-z]/);
    }
  });
});

describe("rule 3337: a footer link to change the choice, only for a consent provider", () => {
  it("Google switched on: the footer has the cookie-settings button in both languages", () => {
    stubOnly(ENVS.google);
    for (const lang of LANGS) expect(renderToStaticMarkup(h(Footer, { t: dict[lang], lang }))).toContain(CONSENT_COPY.settings[lang]);
  });
});

describe("rule 3338: two answers of equal weight, nothing pre-ticked, plain copy", () => {
  it("both buttons share one class; no checkbox, no default", () => {
    const src = code("src/components/analytics/ConsentBanner.tsx");
    const classes = [...src.matchAll(/className=\{(buttonClass\([^)]*\))\}/g)].map((m) => m[1]);
    expect(classes).toHaveLength(2);
    expect(classes[0]).toBe(classes[1]);
    expect(src).not.toMatch(/checkbox|defaultChecked|checked=|autoFocus/);
  });
  it("no legal claim in the copy", () => {
    const all = JSON.stringify(CONSENT_COPY);
    expect(all).not.toMatch(/PDPL|GDPR|compliant|complies|certified|متوافق|نظام حماية البيانات|معتمد/i);
  });
});

describe("rule 3339: the answer stays in a first-party cookie; the server never records it", () => {
  it("the cookie line is first-party, whole site, Lax, Secure on https, and reads back", () => {
    const line = consentCookieLine("yes", true);
    expect(line).toBe(`${CONSENT_COOKIE}=yes; path=/; max-age=15552000; samesite=lax; secure`);
    expect(line).not.toMatch(/domain=/);
    expect(readConsent(`a=1; ${CONSENT_COOKIE}=no`)).toBe("no");
    expect(readConsent(`${CONSENT_COOKIE}=maybe`)).toBeNull();
    expect(readConsent("")).toBeNull();
  });
  it("a no clears the anonymous id and Google's cookies on the host and its parents", () => {
    const lines = clearAnalyticsLines("_ga=1; _ga_ABC=2; other=3", "www.thakeen.com");
    for (const n of ["thakeen_aid", "_ga", "_ga_ABC"]) expect(lines.some((l) => l.startsWith(`${n}=; path=/; max-age=0; domain=.thakeen.com`)), n).toBe(true);
    expect(lines.some((l) => l.startsWith("other="))).toBe(false);
  });
  it("no route, server module or store key reads the consent cookie", () => {
    const server = files("src").filter((f) => /\.tsx?$/.test(f) && !/src\/lib\/(cookie-consent|cookie-names)\.ts$/.test(f) && !/src\/components\/analytics\//.test(f));
    for (const f of server) expect(code(f), f).not.toMatch(/CONSENT_COOKIE|thakeen_consent|readConsent/);
  });
});

describe("rules 3340-3341: the page policy widens only for the active provider, only on marketing pages", () => {
  const req = (path: string) => new NextRequest("https://thakeen.example" + path);
  const policies = async (path: string) => {
    const { proxy } = await import("@/proxy");
    const r = proxy(req(path));
    return { enforced: r.headers.get("content-security-policy") ?? "", report: r.headers.get("content-security-policy-report-only") ?? "" };
  };
  it("with no provider, the policies are exactly the default", async () => {
    stubOnly({});
    const { pageCsp } = await import("@/lib/csp");
    const { enforced, report } = await policies("/ar/pricing");
    const nonce = enforced.match(/'nonce-([^']+)'/)![1];
    expect(enforced).toBe(pageCsp(nonce, false));
    for (const host of ALL_HOSTS) { expect(enforced, host).not.toContain(host); expect(report, host).not.toContain(host); }
  });
  for (const p of ANALYTICS_PROVIDERS) {
    it(`${p}: its own hosts on a marketing page and no other provider's; none on the app or the console`, async () => {
      stubOnly(ENVS[p]);
      const cfg = cfgOf(p);
      const own = (h: string) => [...cfg.csp.script, ...cfg.csp.connect].some((x) => x.includes(h));
      const { enforced, report } = await policies("/ar/pricing");
      for (const host of cfg.csp.script) expect(enforced, host).toContain(` ${host}`);
      for (const host of cfg.csp.connect) expect(report, host).toContain(` ${host}`);
      for (const host of ALL_HOSTS.filter((x) => !own(x))) {
        expect(enforced, `${p} ${host}`).not.toContain(host);
        expect(report, `${p} ${host}`).not.toContain(host);
      }
      for (const path of ["/ar/app/tasks", "/en/app/login", "/ar/admin", "/en/admin/users"]) {
        const app = await policies(path);
        for (const host of ALL_HOSTS) expect(app.enforced + app.report, `${path} ${host}`).not.toContain(host);
      }
    });
  }
  it("a host with a space or semicolon never reaches the policy", async () => {
    const { pageCsp } = await import("@/lib/csp");
    const csp = pageCsp("bm9uY2Vub25jZW5vbmNlMQ==", false, { script: ["https://ok.example", "https://x.example; script-src *"], connect: [] });
    expect(csp).toContain(" https://ok.example");
    expect(csp).not.toContain("x.example");
    expect(analyticsCsp(null)).toEqual({ script: [], connect: [] });
  });
});

describe("rule 3342: Umami's script host is configurable, https origin only", () => {
  it("a self-hosted origin replaces Umami Cloud in the script and the policy", () => {
    const cfg = analyticsConfig({ ...ENVS.umami, UMAMI_SCRIPT_HOST: "https://stats.thakeen.com" })!;
    expect(cfg.script).toBe("https://stats.thakeen.com/script.js");
    expect(cfg.csp).toEqual({ script: ["https://stats.thakeen.com"], connect: ["https://stats.thakeen.com"] });
    expect(cfgOf("umami").csp.connect).toEqual([UMAMI_CLOUD, "https://api-gateway.umami.dev"]);
  });
  it("http, a path, a user, a query or junk turns analytics off", () => {
    for (const bad of ["http://stats.example", "https://stats.example/u", "https://a:b@stats.example", "https://stats.example/?x", "stats.example", "https://x.example; script-src *"]) {
      expect(analyticsConfig({ ...ENVS.umami, UMAMI_SCRIPT_HOST: bad }), bad).toBeNull();
    }
    expect(httpsOrigin("https://stats.example:8443/")).toBe("https://stats.example:8443");
  });
});

describe("rule 3343: env names only, documented, never compiled in", () => {
  it("every name is in variables.md and none is NEXT_PUBLIC_", () => {
    const vars = read("docs/system/variables.md");
    for (const name of Object.values(ANALYTICS_ENV)) {
      expect(vars, name).toContain(`\`${name}\``);
      expect(name).not.toMatch(/^NEXT_PUBLIC_/);
    }
    expect(code("src/lib/analytics.ts")).not.toMatch(/NEXT_PUBLIC_/);
  });
  it("the EU region picks the EU hosts for Mixpanel and PostHog", () => {
    expect(analyticsConfig({ ...ENVS.mixpanel, ANALYTICS_REGION: "eu" })!.endpoint).toBe("https://api-eu.mixpanel.com/track/?ip=0");
    expect(analyticsConfig({ ...ENVS.posthog, ANALYTICS_REGION: "EU" })!.endpoint).toBe("https://eu.i.posthog.com/i/v0/e/");
  });
});

describe("rules 3344-3345: placeholder picture hosts in development only", () => {
  it("production gets none; any other mode gets placehold.co and picsum.photos over https", () => {
    expect(devImagePatterns("production")).toEqual([]);
    for (const env of ["development", "test", undefined]) {
      expect(devImagePatterns(env).map((p) => p.hostname), String(env)).toEqual([...DEV_IMAGE_HOSTS]);
      for (const p of devImagePatterns(env)) expect(p.protocol).toBe("https");
    }
  });
  it("a production next.config holds no image hosts at all", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const cfg = (await import("../next.config")).default;
    expect(JSON.stringify(cfg.images ?? {})).not.toMatch(/placehold|picsum/);
  });
  it("the page policy names neither host in any mode", async () => {
    const { pageCsp, reportOnlyCsp } = await import("@/lib/csp");
    for (const dev of [true, false]) {
      const all = pageCsp("bm9uY2Vub25jZW5vbmNlMQ==", dev) + reportOnlyCsp("bm9uY2Vub25jZW5vbmNlMQ==", dev);
      for (const host of DEV_IMAGE_HOSTS) expect(all, host).not.toContain(host);
    }
  });
});

describe("rules 3346-3347: riyals only, written for the language", () => {
  it("Arabic: Latin digits then ر.س; English: SAR then the figure", () => {
    expect(formatSar(299, "ar")).toBe("299 ر.س");
    expect(formatSar(299, "en")).toBe("SAR 299");
    expect(formatSar(1499.5, "ar")).toBe("1,499.5 ر.س");
    expect(formatSar(1499.499, "en")).toBe("SAR 1,499.5");
    expect(formatSar(Number.NaN, "en")).toBe("");
    expect(CHARGED_CURRENCY).toBe("SAR");
    for (const plan of SELF_SERVE_PLANS) {
      expect(planPriceLabel(plan, "ar")).toBe(`${PLAN_PRICE_SAR[plan]} ر.س`);
      expect(planPriceLabel(plan, "en")).toBe(`SAR ${PLAN_PRICE_SAR[plan]}`);
    }
  });
  it("the formatter never writes another currency or an Arabic-Indic digit", () => {
    for (const lang of LANGS) for (const n of [0, 1, 299, 12345.67]) expect(formatSar(n, lang)).not.toMatch(/[$€£]|USD|AED|EUR|دولار|درهم|[٠-٩]/);
  });
  it("the home page plans show no currency that is not charged", () => {
    for (const lang of LANGS) {
      const text = renderToStaticMarkup(h(Plans, { t: dict[lang], lang })).replace(/<[^>]+>/g, " ");
      expect(text, lang).not.toMatch(/\$|€|£|\bUSD\b|\bAED\b|\bEUR\b|دولار|درهم/);
    }
  });
});

describe("rules 3348-3350: the drawing of the app holds no figure and no claim", () => {
  const BAD = new RegExp(`[0-9٠-٩]|%|\\$|ر\\.س|\\bSAR\\b|ريال|${RESULT_WORDS.source}`, "i");
  const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  it("its spot is one constant, outside the cover", () => {
    expect(["after-gallery", "after-cover", "off"]).toContain(APP_SCREEN_SPOT);
    expect(read("src/app/[lang]/page.tsx")).toMatch(/APP_SCREEN_SPOT === "after-gallery" && <Workspace/);
    expect(code("src/components/home/Cover.tsx")).not.toMatch(/Workspace|AppScreen/);
  });
  it("it shows four agents from the registry, none whose role names a result", () => {
    expect(SCREEN_AGENTS).toHaveLength(4);
    for (const a of SCREEN_AGENTS) expect(`${a.role.ar} ${a.role.en}`, a.id).not.toMatch(RESULT_WORDS);
    // The result words do catch the registry roles they are meant to catch.
    expect("Finance, pricing and revenue").toMatch(RESULT_WORDS);
    expect("المنتج والاحتفاظ بالعملاء").toMatch(RESULT_WORDS);
  });
  it("every string it owns, in both languages, has no digit, money, percentage or result word", () => {
    for (const s of appScreenStrings()) expect(s, s).not.toMatch(BAD);
  });
  for (const lang of LANGS) {
    it(`the rendered section (${lang}): no figure or claim in its text or labels, no picture`, () => {
      const html = renderToStaticMarkup(h(Workspace, { lang }));
      const text = decode(html.replace(/<[^>]+>/g, " "));
      expect(text).not.toMatch(BAD);
      expect(text).not.toMatch(/&#/);
      for (const m of html.matchAll(/(?:aria-label|alt|title)="([^"]*)"/g)) expect(decode(m[1]), m[1]).not.toMatch(BAD);
      expect(html).not.toMatch(/<img|<image|background-image|https?:\/\//);
      expect(html).toContain('role="img"');
    });
  }
});

describe("rules 3351-3352: the role cards read MIN_ROLE, with drawn avatars", () => {
  it("roleMeets mirrors MIN_ROLE for every action", () => {
    const rank = { member: 0, admin: 1, owner: 2 } as const;
    for (const [action, min] of Object.entries(MIN_ROLE) as [Action, keyof typeof rank][]) {
      for (const role of ["owner", "admin", "member"] as const) expect(roleMeets(role, action), `${role} ${action}`).toBe(rank[role] >= rank[min]);
    }
  });
  it("owner reaches every row; admin all but billing and roles; member asks and edits drafts only", () => {
    const allowed = (role: "owner" | "admin" | "member") => ROLE_ROWS.filter((r) => roleMeets(role, r.action)).map((r) => r.action);
    expect(allowed("owner")).toEqual(ROLE_ROWS.map((r) => r.action));
    expect(allowed("admin")).toEqual(ROLE_ROWS.map((r) => r.action).filter((a) => a !== "billing" && a !== "team.role"));
    expect(allowed("member")).toEqual(["generate", "drafts"]);
    for (const lang of LANGS) expect(roleRows("member", lang).filter((r) => r.allowed)).toHaveLength(2);
  });
  it("the cards render each row's state and no photograph", () => {
    const html = renderToStaticMarkup(h(Workspace, { lang: "en" }));
    for (const role of ["owner", "admin", "member"]) expect(html).toContain(`data-role="${role}"`);
    expect((html.match(/data-allowed="true"/g) ?? []).length).toBe(ROLE_ROWS.length + (ROLE_ROWS.length - 2) + 2);
    expect(code("src/components/home/RolePreview.tsx")).not.toMatch(/<img|next\/image|\.jpe?g|\.png|\.webp/);
  });
});
