import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomBytes } from "crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { jar, newUser } from "./helpers/session";
import { createSession, currentUser, destroySession, sessionKey, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateFormat } from "@/lib/dates";
import { formatMoney, formatNumber, formatTime } from "@/lib/format";
import { formatWhen } from "@/lib/secretary-agenda";
import { scribble, scribbleRing, type ScribbleKind } from "@/lib/scribble";
import { ScribbleSvg, tightPath } from "@/components/ScribbleArt";
import {
  IMPERSONATE_COOKIE, INSTALL_DISMISS_KEY, INVITE_TOKEN_KEY, JOURNEY_KEY, LANG_COOKIE, LEGACY, METRICS_KEY, OAUTH_COOKIE,
  PARTNER_COOKIE, RETURN_COOKIE, SESSION_COOKIE, THEME_COOKIE, cookieFromHeader, dropCookie, expireLegacyLine, namesOf,
  readCookie, readStored, removeStored, writeStored,
} from "@/lib/cookie-names";
import { cookieRef } from "@/lib/partners";
import { partnerCookieValue } from "@/lib/partner-rules";
import { hintDismissed, dismissHint } from "@/lib/pwa";
import { recallInviteToken, rememberInviteToken, forgetInviteToken } from "@/components/app/inviteToken";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { BEARER, TOKEN_PREFIX, tokenHash } from "@/lib/oauth";
import * as impersonateStop from "@/app/api/admin/impersonate/route";

/**
 * UI leftovers after phases 0-5 (rules 1800-1813, docs/system/tests/1800-ui-leftovers.md): Western digits in rendered
 * output, the axe check, a lighter home page, and the `nashr_*` cookie and token names renamed to `thakeen_*` in an
 * expand release (rule 679): read both, write the new one, nobody signed out.
 */
const read = (f: string) => readFileSync(f, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const ARABIC_INDIC = /[\u0660-\u0669\u06F0-\u06F9]/;
const src = walk("src").filter((f) => /\.tsx?$/.test(f));
/** Source without comments: a comment may name an old cookie, code may not. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

describe("rule 1800: what the formatters render in Arabic has Western digits only", () => {
  it("numbers, money, times, dates and agenda lines", () => {
    const at = Date.UTC(2026, 9, 13, 17, 45);
    const out = [
      formatNumber(1234567.89, "ar"), formatNumber(0, "ar"),
      formatMoney(299, "ar"), formatMoney(1499.5, "ar"), formatMoney(35, "ar", "USD"),
      formatTime(at, "ar", "date"), formatTime(at, "ar", "datetime"), formatTime(at, "ar", "time"),
      dateFormat("ar", { dateStyle: "full", timeStyle: "short" }).format(at),
      dateFormat("ar", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }, "Asia/Riyadh").format(at),
      formatWhen(new Date(at + 86_400_000).toISOString(), false, "ar", at),
      formatWhen(new Date(at + 9 * 86_400_000).toISOString(), true, "ar", at),
    ];
    for (const s of out) {
      expect(s, s).not.toMatch(ARABIC_INDIC);
      expect(s, s).toMatch(/[0-9]/);
    }
  });

  it("every Intl formatter that takes the page language asks for Latin digits, and nothing calls toLocaleString", () => {
    for (const f of src) {
      const code = read(f);
      expect(code, f).not.toMatch(/\.toLocale(?:Date|Time)?String\(/);
      for (const m of code.matchAll(/new Intl\.(NumberFormat|DateTimeFormat|RelativeTimeFormat)\(([^,)]*)/g)) {
        const loc = m[2].trim();
        expect(/^"en(?:-[A-Za-z]+)*"$/.test(loc) || /nu-latn/.test(loc) || loc === "locale(lang", `${f}: ${m[0]}`).toBe(true);
      }
    }
    expect(read("src/lib/format.ts")).toMatch(/"ar-u-nu-latn"/);
  });
});

describe("rules 1801-1802: an automatic accessibility check that stays cheap", () => {
  const spec = read("e2e/a11y.spec.ts");
  it("axe-core runs on a short list of first pages and fails on serious or critical WCAG A/AA violations", () => {
    expect(spec).toContain('resolve("axe-core/axe.min.js")');
    expect(spec).toMatch(/values: \["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"\]/);
    expect(spec).toContain('v.impact === "serious" || v.impact === "critical"');
    const pages = JSON.parse(/const PAGES = (\[[^\]]+\])/.exec(spec)![1]) as string[];
    expect(pages.length).toBeLessThanOrEqual(8);
    expect(pages.filter((p) => p.startsWith("/ar")).length).toBeGreaterThanOrEqual(3);
  });
  it("one browser only (rule 772), and the Arabic pages are read for Arabic-Indic digits", () => {
    expect(spec).toContain('test.skip(({ browserName }) => browserName !== "chromium"');
    expect(spec).toMatch(/document\.body\.innerText/);
    expect(spec).toContain("\\u0660-\\u0669\\u06F0-\\u06F9");
  });
  it("what the first run found is fixed: the language toggle's visible word is its accessible name (WCAG 2.5.3)", () => {
    const toggle = read("src/components/LangToggle.tsx");
    expect(toggle).not.toMatch(/aria-label=\{title\}/);
    expect(toggle).toContain("title={title}");
  });
  it("axe-core is a declared dev dependency, not a transitive accident", () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.devDependencies["axe-core"]).toMatch(/^\^4\./);
    expect(pkg.dependencies["axe-core"]).toBeUndefined();
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { devDependencies?: Record<string, string> }> };
    expect(lock.packages[""].devDependencies?.["axe-core"]).toBe(pkg.devDependencies["axe-core"]);
  });
});

describe("rule 1803: scribble paths go into the page in their shortest exact spelling", () => {
  const numbers = (d: string) => (d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map((t) => (/[A-Za-z]/.test(t) ? t : Number(t)));
  const KINDS: ScribbleKind[] = ["box", "bubble", "circleLoop", "cloud", "divider", "pill", "puddle", "stamp", "strike", "swash", "tape", "tick", "underline"];

  it("the same commands and the same numbers, fewer characters", () => {
    let before = 0, after = 0;
    for (const kind of KINDS) for (const seed of ["a", "b7", "pl-starter", "hero"]) {
      const art = scribble(kind, 240, 64, seed, { rtl: seed === "b7" });
      const paths = [art.d, art.fill, art.ink, art.cap, art.capFill, art.ghost, ...scribbleRing(seed, kind, 240, 64)].filter((d): d is string => !!d);
      for (const d of paths) {
        const t = tightPath(d);
        expect(numbers(t), `${kind} ${seed}`).toEqual(numbers(d));
        expect(t).not.toMatch(/ -|(?:^|[^\d.])0\.\d/);
        before += d.length;
        after += t.length;
      }
    }
    expect(after).toBeLessThan(before);
  });

  it("edge spellings stay exact", () => {
    expect(tightPath("M-3 8.5Q50.2 -0.4 124 0.6")).toBe("M-3 8.5Q50.2-.4 124 .6");
    expect(tightPath("M10.5 20.05L0 0")).toBe("M10.5 20.05L0 0");
    expect(tightPath("M0.5 1Z")).toBe("M.5 1Z");
  });

  it("the rendered svg carries the short paths and no IE-only focusable attribute", () => {
    const html = renderToStaticMarkup(h(ScribbleSvg, { look: { kind: "box", seed: "pl-starter", fill: "paper", ring: true, boil: true }, w: 240, h: 64, rtl: false }));
    expect(html).not.toContain("focusable");
    expect(html).toContain('aria-hidden="true"');
    for (const [, d] of html.matchAll(/ d="([^"]*)"/g)) expect(d).toBe(tightPath(d));
    expect(html.match(/pathLength="1"/g)?.length).toBeGreaterThan(0);
  });
});

describe("rule 1810: one home for every cookie and storage name, the new `thakeen_` names written, the old ones read", () => {
  it("every name is thakeen and maps to exactly the nashr name it replaces", () => {
    const names = [SESSION_COOKIE, RETURN_COOKIE, IMPERSONATE_COOKIE, LANG_COOKIE, THEME_COOKIE, PARTNER_COOKIE, OAUTH_COOKIE, INVITE_TOKEN_KEY, INSTALL_DISMISS_KEY, JOURNEY_KEY, METRICS_KEY];
    for (const n of names) {
      expect(n).toMatch(/^thakeen[_:]/);
      expect(LEGACY[n]).toBe(n.replace(/^thakeen/, "nashr"));
      expect(namesOf(n)).toEqual([n, LEGACY[n]]);
    }
    expect(Object.keys(LEGACY).sort()).toEqual([...names].sort());
  });

  it("the module imports nothing, so client code and the head script can use it", () => {
    expect(read("src/lib/cookie-names.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("reads prefer the new name, fall back to the old one, and treat an empty value as absent", () => {
    const j = (o: Record<string, string>) => ({ get: (n: string) => (n in o ? { value: o[n] } : undefined) });
    expect(readCookie(j({ nashr_lang: "en" }), LANG_COOKIE)).toBe("en");
    expect(readCookie(j({ nashr_lang: "en", thakeen_lang: "ar" }), LANG_COOKIE)).toBe("ar");
    expect(readCookie(j({ thakeen_lang: "", nashr_lang: "en" }), LANG_COOKIE)).toBe("en");
    expect(readCookie(j({}), LANG_COOKIE)).toBeUndefined();
    expect(cookieFromHeader("a=1; nashr_lang=en", LANG_COOKIE, /ar|en/)).toBe("en");
    expect(cookieFromHeader("nashr_lang=en; thakeen_lang=ar", LANG_COOKIE, /ar|en/)).toBe("ar");
    expect(cookieFromHeader("x_thakeen_lang=en", LANG_COOKIE, /ar|en/)).toBeUndefined();
    expect(cookieFromHeader("thakeen_lang=fr", LANG_COOKIE, /ar|en/)).toBeUndefined();
    expect(expireLegacyLine(LANG_COOKIE)).toBe("nashr_lang=; path=/; max-age=0; samesite=lax");
  });

  it("a browser holding only the old session cookie stays signed in", async () => {
    const u = await newUser("legacy");
    const token = randomBytes(32).toString("hex");
    await db.set(sessionKey(token), { email: u.email, at: Date.now() }, 3600);
    jar().clear();
    jar().set("nashr_session", token);
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("a new session is written under the new name and clears the old one", async () => {
    const u = await newUser("fresh");
    jar().clear();
    jar().set("nashr_session", "stale");
    await createSession(u.email);
    expect(jar().get("thakeen_session")).toBeTruthy();
    expect(jar().has("nashr_session")).toBe(false);
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("the proxy keeps a visitor's old language cookie, and the new one wins", async () => {
    const { proxy } = await import("@/proxy");
    const at = (cookie: string) => proxy(new NextRequest("https://thakeen.test/", { headers: { cookie, "accept-language": "ar" } })).headers.get("location") ?? "";
    expect(at("nashr_lang=en")).toMatch(/\/en$/);
    expect(at("nashr_lang=en; thakeen_lang=ar")).toMatch(/\/ar$/);
    expect(at("thakeen_lang=en")).toMatch(/\/en$/);
  });

  it("a partner link clicked before the release still counts", async () => {
    jar().clear();
    jar().set("nashr_partner", partnerCookieValue("OLDCODE", Date.now()));
    expect((await cookieRef())?.code).toBe("OLDCODE");
  });

  it("every writer uses the new names; the old ones appear only in cookie-names.ts", () => {
    const OLD = /["'`]nashr_(session|return|impersonate|lang|theme|partner|oauth|invite_token|install_hint_dismissed)["'`]|["'`]nashr:(journey|metrics)/;
    expect(src.filter((f) => f !== join("src", "lib", "cookie-names.ts") && OLD.test(code(f)))).toEqual([]);
    expect(read("src/components/LangToggle.tsx")).toMatch(/\$\{LANG_COOKIE\}=/);
    expect(read("src/components/LangToggle.tsx")).toContain("expireLegacyLine(LANG_COOKIE)");
    expect(read("src/components/ui/ThemeToggle.tsx")).toContain("legacyThemeExpiry()");
    expect(read("src/app/p/[code]/route.ts")).toContain("dropLegacyCookie(jar, PARTNER_COOKIE)");
    expect(read("src/lib/auth.ts")).toContain("dropLegacyCookie(jar, COOKIE)");
  });
});

describe("rule 1811: sign-out, stop viewing and a used OAuth state clear both names", () => {
  it("sign-out ends the session behind each name", async () => {
    const u = await newUser("both");
    const a = randomBytes(32).toString("hex"), b = randomBytes(32).toString("hex");
    await Promise.all([db.set(sessionKey(a), { email: u.email, at: Date.now() }, 3600), db.set(sessionKey(b), { email: u.email, at: Date.now() }, 3600)]);
    jar().clear();
    jar().set("thakeen_session", a);
    jar().set("nashr_session", b);
    await destroySession();
    expect(jar().has("thakeen_session")).toBe(false);
    expect(jar().has("nashr_session")).toBe(false);
    expect(await sessionRecord(a)).toBeNull();
    expect(await sessionRecord(b)).toBeNull();
  });

  it("a customer view opened before the release (old cookie names) stops cleanly and hands the founder back", async () => {
    const founder = await newUser("imp-founder");
    const customer = await newUser("imp-customer");
    const mine = randomBytes(32).toString("hex"), temp = randomBytes(32).toString("hex");
    await Promise.all([
      db.set(sessionKey(mine), { email: founder.email, at: Date.now() }, 3600),
      db.set(sessionKey(temp), { email: customer.email, at: Date.now(), imp: founder.email }, 3600),
      db.del("admin:log"),
    ]);
    // What the code before this release left in the browser: every helper cookie under its `nashr_` name only.
    jar().clear();
    jar().set("nashr_session", temp);
    jar().set("nashr_return", mine);
    jar().set("nashr_impersonate", customer.email);
    expect((await currentUser())?.email).toBe(customer.email);
    const form = new FormData();
    form.set("lang", "en");
    const r = await impersonateStop.POST(new Request("https://nashr.test/api/admin/impersonate", { method: "POST", body: form, headers: { "x-forwarded-for": "192.0.2.181" } }));
    expect(r.status).toBe(303);
    // The founder is back under the new name, the view's session is burned, and no helper cookie is left under either name.
    expect(jar().get("thakeen_session")).toBe(mine);
    for (const n of ["nashr_session", "nashr_return", "thakeen_return", "nashr_impersonate", "thakeen_impersonate"]) expect(jar().has(n), n).toBe(false);
    expect(await sessionRecord(temp)).toBeNull();
    expect((await currentUser())?.email).toBe(founder.email);
    const rows = (await db.lrange("admin:log", 0, -1)).map((x) => JSON.parse(x) as { actor: string; what: string });
    expect(rows.filter((x) => x.what === "impersonate:stop").map((x) => x.actor)).toEqual([founder.email]);
  });

  it("dropCookie deletes both spellings", () => {
    const gone: string[] = [];
    dropCookie({ delete: (n: string) => gone.push(n) }, OAUTH_COOKIE);
    expect(gone).toEqual(["thakeen_oauth", "nashr_oauth"]);
  });

  it("the impersonation restore and the OAuth callback use the two-name helpers", () => {
    const imp = read("src/app/api/admin/impersonate/route.ts");
    for (const n of ["dropCookie(jar, RETURN_COOKIE)", "dropCookie(jar, IMPERSONATE_COOKIE)", "readCookie(jar, RETURN_COOKIE)"]) expect(imp).toContain(n);
    const cb = read("src/app/api/connect/[provider]/callback/route.ts");
    expect(cb).toContain("readCookie(jar, OAUTH_COOKIE)");
    expect(cb).toContain("dropCookie(jar, OAUTH_COOKIE)");
  });
});

describe("rule 1812: browser storage keys move to the new name without losing what a viewer saved", () => {
  const fake = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it("read new then old, write new and drop old, remove both", () => {
    const s = fake({ "nashr:metrics": "[1]" });
    expect(readStored(s, METRICS_KEY)).toBe("[1]");
    writeStored(s, METRICS_KEY, "[2]");
    expect([...s.m.entries()]).toEqual([["thakeen:metrics", "[2]"]]);
    s.m.set("nashr:metrics", "[3]");
    removeStored(s, METRICS_KEY);
    expect(s.m.size).toBe(0);
    expect(readStored(null, METRICS_KEY)).toBeNull();
  });
  it("the install hint and the invite token keep an old value", () => {
    const s = fake({ nashr_install_hint_dismissed: String(Date.now()) });
    expect(hintDismissed(s)).toBe(true);
    dismissHint(s);
    expect(s.m.has("nashr_install_hint_dismissed")).toBe(false);
    expect(s.m.has(INSTALL_DISMISS_KEY)).toBe(true);
    const [oldTok, newTok] = ["a".repeat(64), "b".repeat(64)];
    const t = fake({ nashr_invite_token: oldTok });
    expect(recallInviteToken(t)).toBe(oldTok);
    rememberInviteToken(newTok, t);
    expect(t.m.get(INVITE_TOKEN_KEY)).toBe(newTok);
    expect(t.m.has("nashr_invite_token")).toBe(false);
    forgetInviteToken(t);
    expect(t.m.size).toBe(0);
  });
  it("the journey card and the reports page use the helpers", () => {
    expect(read("src/components/app/JourneyCard.tsx")).toMatch(/readStored\(|writeStored\(/);
    expect(read("src/components/app/ReportsPanel.tsx")).toMatch(/readStored\(|writeStored\(/);
  });
});

describe("rule 1813: MCP and OAuth tokens are minted as thakeen_, and an old nashr_ token still works", () => {
  const bearer = (t: string) => new Request("https://thakeen.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
  it("new tokens carry the new prefix and sign in", async () => {
    const u = await newUser("tok");
    const t = await createMcpToken(u.email);
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(TOKEN_PREFIX).toBe("thakeen_");
    expect((await userFromBearer(bearer(t)))?.email).toBe(u.email);
  });
  it("a token minted before the rename is accepted; another prefix is not", async () => {
    const u = await newUser("oldtok");
    const old = "nashr_" + randomBytes(24).toString("base64url");
    await db.set(`mcptoken:${tokenHash(old)}`, u.email);
    expect((await userFromBearer(bearer(old)))?.email).toBe(u.email);
    expect(BEARER.test(`Bearer ${old}`)).toBe(true);
    expect(BEARER.test("Bearer other_abc")).toBe(false);
    expect(await userFromBearer(bearer("other_" + randomBytes(24).toString("base64url")))).toBeNull();
  });
});
