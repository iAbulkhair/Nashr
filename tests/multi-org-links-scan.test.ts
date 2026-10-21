import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appHrefFor } from "@/lib/app-href";
import { MULTI_ORG } from "@/lib/multi-org";
import { wsHandle } from "@/lib/ws-handle";
import { PERSON_PAGES, appHref, inWorkspace } from "@/lib/ws-path";

/**
 * Rule 2113, link half (multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 7 "Links"): every link to a
 * workspace page is made by `appHref` (src/lib/ws-path.ts) through `useAppHref` in client components, `pageHref` (src/lib/page-href.ts) in
 * pages and `appHrefFor` for links made from an account (src/lib/app-href.ts), so a page under `w/{handle}` never links
 * out of its workspace. A raw `/{lang}/app…` string may name only a person-level page (`PERSON_PAGES`). With
 * `MULTI_ORG` off (this file does not turn it on) every builder gives today's string.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/** The files that may hold a raw app path, and why. */
const RAW_ALLOWED = new Set([
  "src/lib/ws-path.ts", // the builder itself
  "src/proxy.ts", // the rewrite and the legacy-settings move build the path from its parts
  "src/app/robots.ts", // the crawl rule for the whole app
]);

/** `/${…}/app`, `/ar/app` or `/en/app` followed by what comes after `/app`. */
const RAW = /\/(?:\$\{[^}]+\}|ar|en)\/app(?![a-z-])(\/[A-Za-z0-9_\-/]*)?/g;
const isPerson = (rest: string) => PERSON_PAGES.some((p) => rest === p || rest.startsWith(p + "/"));

const offenders = walk("src")
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => !RAW_ALLOWED.has(f))
  .flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => ({ f, n: i + 1, line }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(({ line }) => [...line.matchAll(RAW)].some((m) => !isPerson(m[1] ?? ""))),
  )
  .map(({ f, n, line }) => `${f}:${n}: ${line.trim().slice(0, 140)}`);

describe("rule 2113: app links go through appHref", () => {
  it("no raw link to a workspace page outside the builder", () => {
    expect(offenders).toEqual([]);
  });

  it("only client components call the WorkspaceContext hooks (a server component gets the page's builder as a prop)", () => {
    // `useAppHref` is a client hook: a server component calling it answers 500 on every page that renders it (React
    // error 441, caught by the end-to-end run of PR #418 for HomeSide and TrialBanner). Those take `to` from the page.
    const isClient = (src: string) => /^\s*["']use client["']/.test(src.replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/, ""));
    const hooks = /\buse(AppHref|WsHandle|Workspace)\(/;
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const server = walk("src")
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => f !== "src/components/app/WorkspaceContext.tsx")
      .filter((f) => { const src = readFileSync(f, "utf8"); return hooks.test(code(src)) && !isClient(src); });
    expect(server).toEqual([]);
    expect(isClient('"use client";\nexport default 1')).toBe(true);
    expect(isClient('import x from "y";\nexport default 1')).toBe(false);
  });

  it("the scan reads the tree and knows a raw link when it sees one", () => {
    const sample = ["go(`/${lang}/app/tasks`)", 'href="/ar/app"', "`/${lang}/app/settings/brand?x=1`"];
    for (const s of sample) expect([...s.matchAll(RAW)].some((m) => !isPerson(m[1] ?? "")), s).toBe(true);
    for (const s of ["`/${lang}/app/login`", "`/${lang}/app/join#t=1`", "`/${lang}/app/settings/security`", "`/${lang}/application`"])
      expect([...s.matchAll(RAW)].some((m) => !isPerson(m[1] ?? "")), s).toBe(false);
  });

  it("with MULTI_ORG off every builder gives today's link", () => {
    expect(MULTI_ORG).toBe(false);
    const u = { id: "a_aaaaaaaaaaaaaaaaaaaaaaaa", email: "o@test.example" };
    for (const p of ["", "/", "/tasks", "/tasks?tab=done#x", "/settings/brand", "/login"]) {
      const old = `/ar/app${p === "/" ? "" : p}`;
      expect(appHref("ar", p)).toBe(old);
      expect(appHref("ar", p, null)).toBe(old);
      expect(appHrefFor(u, "ar", p)).toBe(old);
      expect(inWorkspace(old, null)).toBe(old);
    }
  });

  it("inWorkspace moves a stored link into the handle's workspace, once", () => {
    const h = wsHandle("a_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(inWorkspace("/ar/app/tasks?id=1#c", h)).toBe(`/ar/app/w/${h}/tasks?id=1#c`);
    expect(inWorkspace("/en/app", h)).toBe(`/en/app/w/${h}`);
    expect(inWorkspace(`/ar/app/w/${h}/tasks`, h)).toBe(`/ar/app/w/${h}/tasks`);
    expect(inWorkspace("/ar/app/login", h)).toBe("/ar/app/login");
    expect(inWorkspace("https://example.com/ar/app/tasks", h)).toBe("https://example.com/ar/app/tasks");
    expect(inWorkspace("/ar/pricing", h)).toBe("/ar/pricing");
  });
});
