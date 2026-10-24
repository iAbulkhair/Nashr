import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acct } from "@/lib/auth";
import { scopeFor } from "@/lib/brands";
import { BRAND_SECTIONS } from "@/lib/brand-path";
import { listNotifs, notifyItem } from "@/lib/notifications";
import { pageHref } from "@/lib/page-href";
import { buildIcs } from "@/lib/secretary-feed";
import { wsHandle } from "@/lib/ws-handle";
import { appHrefFor, appHrefIn, appHrefInBrand } from "@/lib/ws-href";
import { WS_HEADER, appHref, inWorkspace } from "@/lib/ws-path";
import { newUser, withHeaders } from "./helpers/session";


/**
 * Task 8 of the brand-in-the-URL plan, with `MULTI_ORG` on (the release switch since M2 enable): every builder composes the workspace and the
 * brand as `/{lang}/app/w/{handle}/b/{brandId}/…` (rule 2600), links the server makes about one brand carry that brand
 * (rules 2601-2602, finishing rule 894), and client and page links from an account page name the shell's brand (rule
 * 2603, finishing rule 890). docs/system/tests/2600-brand-url-links.md lists them.
 */

const AID = "a_bbbbbbbbbbbbbbbbbbbbbbbb";
const h = wsHandle(AID);

describe("rule 2600: one composition, every builder", () => {
  it("appHref, appHrefFor, appHrefIn, appHrefInBrand and pageHref give /w/{handle}/b/{brand}/… for a brand section", async () => {
    const want = `/ar/app/w/${h}/b/b1/todo?x=1`;
    expect(appHref("ar", "/todo?x=1", h, "b1")).toBe(want);
    expect(appHrefFor({ id: AID, email: "o@test.example" }, "ar", "/todo?x=1", "b1")).toBe(want);
    expect(appHrefIn(AID, "ar", "/todo?x=1", "b1")).toBe(want);
    expect(appHrefInBrand(scopeFor(AID, "b1"), "ar", "/todo?x=1")).toBe(want);
    const page = await withHeaders({ [WS_HEADER]: h, "x-thakeen-brand": "b1" }, () => pageHref("ar"));
    expect(page("/todo?x=1")).toBe(want);
  });

  it("the account's own scope is its default brand; an account page carries the handle and no brand", () => {
    expect(appHrefInBrand(AID, "en")).toBe(`/en/app/w/${h}/b/default`);
    expect(appHrefInBrand(scopeFor(AID, "b1"), "ar", "/settings/billing")).toBe(`/ar/app/w/${h}/settings/billing`);
  });

  it("a page outside /b/{id} uses the fallback brand it is given; the page's own brand still wins", async () => {
    const off = await withHeaders({ [WS_HEADER]: h }, () => pageHref("ar", "b2"));
    expect(off("/chat")).toBe(`/ar/app/w/${h}/b/b2/chat`);
    expect(off("/settings/billing")).toBe(`/ar/app/w/${h}/settings/billing`);
    const on = await withHeaders({ [WS_HEADER]: h, "x-thakeen-brand": "b1" }, () => pageHref("ar", "b2"));
    expect(on("/chat")).toBe(`/ar/app/w/${h}/b/b1/chat`);
  });

  it("the bell keeps a stored brand link's brand when it moves it into the workspace", () => {
    expect(inWorkspace("/ar/app/b/b1/todo?series=s1", h)).toBe(`/ar/app/w/${h}/b/b1/todo?series=s1`);
  });
});

describe("rule 2601: a bell entry about one brand opens that brand", () => {
  it("notifyItem puts the brand of `brandScope`, else of the filing scope, into a relative href; neither keeps the old path", async () => {
    const u = await newUser("srvlink");
    const a = acct(u);
    const b1 = scopeFor(a, "b1");
    await notifyItem(a, "ar", { kind: "info", title: "by-brand-scope", body: "", href: "settings/governance", brandScope: b1 });
    await notifyItem(a, "ar", { kind: "info", title: "by-scope", body: "", href: "tasks" }, undefined, undefined, b1);
    await notifyItem(a, "ar", { kind: "info", title: "account-wide", body: "", href: "activity" });
    const byTitle = new Map((await listNotifs(a)).map((n) => [n.title, n]));
    expect(byTitle.get("by-brand-scope")?.href).toMatch(/^\/ar\/app\/w\/w_[a-z2-7]{16}\/b\/b1\/settings\/governance$/);
    expect(byTitle.get("by-scope")?.href).toMatch(/^\/ar\/app\/w\/w_[a-z2-7]{16}\/b\/b1\/tasks$/);
    expect(byTitle.get("account-wide")?.href).toMatch(/^\/ar\/app\/w\/w_[a-z2-7]{16}\/activity$/);
    // `brandScope` steers the link only; it is never stored on the entry.
    expect(byTitle.get("by-brand-scope")).not.toHaveProperty("brandScope");
  });

  it("the calendar feed links to its own brand's list", () => {
    const at = "2026-10-21T08:00:00.000Z";
    const item = { id: "s1", title: "Call", dueAt: "2026-10-22T09:00:00.000Z", createdAt: at, updatedAt: at, rev: 1 } as never;
    const ics = buildIcs([item], { lang: "en", zone: "Asia/Riyadh", origin: "https://x.test", now: Date.UTC(2026, 9, 21), brand: "b1" });
    expect(ics.replace(/\r\n /g, "")).toContain("https://x.test/en/app/b/b1/todo");
  });
});

/** The arguments of each call to `fn(` in `src`, split at the top level (strings, templates and brackets respected). */
function calls(src: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${fn}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const args: string[] = [];
    let depth = 0, cur = "", i = m.index + m[0].length, quote: string | null = null, tpl = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        cur += c;
        if (c === "\\") { cur += src[++i]; continue; }
        if (quote === "`" && c === "$" && src[i + 1] === "{") { tpl++; quote = null; cur += src[++i]; depth++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
      if (c === "}" && tpl > 0 && depth > 0) { depth--; tpl--; quote = "`"; cur += c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** The section a literal path argument names: "" for none (the inbox), null when it is not a literal. */
function literalPath(arg: string | undefined): string | null {
  if (arg === undefined) return "";
  const m = /^["'`]\/?([^"'`?#]*)/.exec(arg);
  // A path built from a value (`/${x}`) is no literal: the scan cannot tell its section.
  return m && !m[1].includes("${") ? m[1].replace(/\/$/, "") : null;
}

const isBrandSection = (p: string) => BRAND_SECTIONS.some((s) => p === s || (s !== "" && p.startsWith(s + "/")));

describe("rule 2602: server links into a brand section name the brand", () => {
  // Account-level mails and the billing return open the app root or an account page: no brand to name. The app root
  // (`/{lang}/app`) is a redirect to the session's brand by design (rule 891), not the `[...legacy]` hop.
  const ACCOUNT_LEVEL = new Set(["src/lib/lifecycle.ts", "src/lib/billing.ts"]);
  const FILES = [
    "src/lib/notifications.ts", "src/lib/secretary-remind.ts", "src/lib/secretary-series.ts", "src/lib/secretary-evening.ts",
    "src/lib/secretary-gcal.ts", "src/lib/media/jobs.ts", "src/app/api/cron/daily/route.ts", "src/lib/lifecycle.ts", "src/lib/billing.ts",
    "src/app/api/connect/[provider]/start/route.ts", "src/app/api/connect/[provider]/callback/route.ts",
  ];

  it("every appHrefFor / appHrefIn call to a brand section passes the brand (appHrefInBrand takes it from the scope)", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      for (const fn of ["appHrefFor", "appHrefIn"]) {
        for (const args of calls(src, fn)) {
          if (args.length >= 4) continue;
          const p = literalPath(args[2]);
          if (p !== null && isBrandSection(p) && !ACCOUNT_LEVEL.has(f)) offenders.push(`${f}: ${fn}(${args.join(", ")})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scan sees a call without the brand", () => {
    expect(calls('x(appHrefFor(u, u.lang, "/todo"))', "appHrefFor")).toEqual([["u", "u.lang", '"/todo"']]);
    expect(calls("appHrefIn(s, l, `/todo?series=${a(b, c)}`, brandOfScope(s))", "appHrefIn")[0]).toHaveLength(4);
    expect(isBrandSection(literalPath('"/todo"') ?? "-")).toBe(true);
    expect(isBrandSection(literalPath(undefined) ?? "-")).toBe(true);
    expect(isBrandSection(literalPath('"/billing"') ?? "-")).toBe(false);
  });

  it("relative bell hrefs about one brand pass its scope", () => {
    for (const f of ["src/lib/routines.ts", "src/lib/handoff-auto.ts", "src/lib/judge.ts"]) {
      const src = readFileSync(f, "utf8");
      const n = calls(src, "notifyItem").length;
      expect(n, f).toBeGreaterThan(0);
      expect((src.match(/brandScope: scope/g) ?? []).length, f).toBe(n);
    }
    expect(readFileSync("src/lib/notifications.ts", "utf8")).toContain("brandScope: paid.scope");
  });
});

describe("rule 2603: links from an account page name the shell's brand", () => {
  it("useAppLink falls back to the shell's brand, the billing page and the shell's banner pass u.brandId", () => {
    const ctx = readFileSync("src/components/app/WorkspaceContext.tsx", "utf8");
    expect(ctx).toMatch(/brandFromPath\(pathname\) \?\? \(fallbackBrand === undefined \? shellBrand : fallbackBrand\)/);
    expect(readFileSync("src/app/[lang]/app/settings/billing/page.tsx", "utf8")).toContain("pageHref(lang, u.brandId)");
    expect(readFileSync("src/app/[lang]/app/layout.tsx", "utf8")).toContain("appHref(lang, p, handle, user.brandId)");
  });

  it("a new brand opens its own start page; a new account its default brand's", () => {
    expect(readFileSync("src/components/app/BrandsPanel.tsx", "utf8")).toContain('appHref(lang, "/start", handleOfPath(path) ?? shellHandle, j.brand?.id)');
    expect(readFileSync("src/components/app/AuthForm.tsx", "utf8")).toMatch(/appHref\(lang, `\/start[^\n]*, null, "default"\)/);
    expect(readFileSync("src/app/api/auth/google/callback/route.ts", "utf8")).toContain('appHref(lang, "/start", null, "default")');
    expect(appHref("ar", "/start", null, "default")).toBe("/ar/app/b/default/start");
  });
});
