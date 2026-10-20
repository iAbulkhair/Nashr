import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The router a client component sees: the hook under test reads the path and the query and calls push or replace.
const nav = vi.hoisted(() => ({ path: "/en/admin/users", search: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));

import { EMPTY_COPY, EMPTY_KEYS, emptyCopy } from "@/lib/empty-copy";
import EmptyState from "@/components/ui/EmptyState";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { DataTable, TABLE_COPY, useUrlQuery } from "@/components/admin/DataTable";
import SettingsCard, { statusTarget } from "@/components/app/settings/SettingsCard";
import SettingsNav from "@/components/app/settings/SettingsNav";
import { SETTINGS_COPY, SETTINGS_GROUPS, SETTINGS_SECTIONS, groupOf, settingsHref } from "@/lib/settings-nav";
import { PROGRESS_EVENT, PROGRESS_MS, progressStore, startsProgress } from "@/lib/route-progress";
import { onRouterTransitionStart } from "@/instrumentation-client";
import RouteProgress from "@/components/ui/RouteProgress";
import { canonicalHref, historyFor, queryHref, type QueryCodec } from "@/lib/url-query";
import { DEFAULT_USER_QUERY, parseUserQuery, userQueryParams, type UserQuery } from "@/lib/admin-users";
import { appDict } from "@/lib/app-i18n";
import { appHref } from "@/lib/ws-path";

const read = (f: string) => readFileSync(f, "utf8");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
const USERS: QueryCodec<UserQuery> = { parse: parseUserQuery, params: userQueryParams };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.search = "";
});

describe("rule 2000: no browser dialog boxes for feedback", () => {
  it("nothing under src calls alert, or window.alert / confirm / prompt", () => {
    const hits = walk("src").flatMap((f) => read(f).split("\n").map((l, i) => ({ f, i: i + 1, l })))
      .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // comments may name the old call
      .filter(({ l }) => /(?<![.\w`'"])alert\s*\(|\bwindow\.(alert|confirm|prompt)\s*\(/.test(l) && !/function alert\b/.test(l));
    expect(hits.map(({ f, i }) => `${f}:${i}`)).toEqual([]);
  });

  it("the inbox reports a failed publish or decision through the toast", () => {
    const inbox = read("src/components/app/Inbox.tsx");
    expect(inbox).toMatch(/useToast\(\)/);
    expect(inbox).toMatch(/toast\.danger\(/);
  });
});

describe("rule 2001: a save's answer, toast for success and inline alert for a refusal", () => {
  it("statusTarget routes ok to the toast, an error inline, nothing for no text", () => {
    expect(statusTarget(null)).toBeNull();
    expect(statusTarget({ tone: "ok", text: "" })).toBeNull();
    expect(statusTarget({ tone: "ok", text: "Saved" })).toBe("toast");
    expect(statusTarget({ tone: "error", text: "Too long" })).toBe("inline");
  });

  it("a success is not repeated inside the card; an error sits there as an alert", () => {
    const ok = renderToStaticMarkup(h(SettingsCard, { title: "Name", onSave: () => {}, saveLabel: "Save", status: { tone: "ok", text: "Saved-once" } }));
    expect(ok).not.toContain("Saved-once");
    expect(ok).not.toContain('role="alert"');
    const bad = renderToStaticMarkup(h(SettingsCard, { title: "Name", onSave: () => {}, saveLabel: "Save", status: { tone: "error", text: "Name too long" } }));
    expect(bad).toMatch(/<p role="alert" class="text-sm text-danger">Name too long<\/p>/);
  });
});

describe("rule 2002: shared empty states", () => {
  it("every panel has a title and a next step in both languages, with no numbers", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(Object.keys(EMPTY_COPY[lang]).sort()).toEqual([...EMPTY_KEYS].sort());
      for (const k of EMPTY_KEYS) {
        const { title, body } = emptyCopy(lang, k);
        expect(title.trim(), `${lang}.${k}`).not.toBe("");
        expect(body.trim(), `${lang}.${k}`).not.toBe("");
        expect(`${title} ${body}`, `${lang}.${k}`).not.toMatch(/[0-9٠-٩۰-۹%]/);
        if (lang === "ar") expect(title, k).toMatch(/[؀-ۿ]/);
        else expect(`${title} ${body}`, k).not.toMatch(/[؀-ۿ]/);
      }
    }
  });

  it("the dictionary names its language, so a panel given only t picks the matching copy", () => {
    expect(appDict.ar.lang).toBe("ar");
    expect(appDict.en.lang).toBe("en");
  });

  it("the compact state is smaller and keeps title, body and action", () => {
    const big = renderToStaticMarkup(h(EmptyState, { title: "T", body: "B" }));
    const small = renderToStaticMarkup(h(EmptyState, { compact: true, title: "T", body: "B", action: h("a", { href: "/x" }, "Go") }));
    expect(big).toContain("px-6 py-10");
    expect(small).toContain("px-4 py-6");
    expect(small).toMatch(/<p class="font-display font-bold text-foreground text-sm">T<\/p><p[^>]*>B<\/p><div class="mt-2"><a href="\/x">Go<\/a><\/div>/);
    expect(small).not.toMatch(/role="(status|alert)"/);
  });

  it("an admin table with no rows shows the empty state, not a bare line", () => {
    const html = renderToStaticMarkup(h(DataTable<{ id: string }, "id">, { lang: "en", caption: "c", columns: [{ id: "a", header: "A", cell: (r) => r.id }], rows: [], rowKey: (r) => r.id }));
    expect(html).toContain(TABLE_COPY.en.empty);
    expect(html).toContain("border-dashed");
  });
});

describe("rule 2003: skeletons while a panel loads", () => {
  it("PanelSkeleton is one polite busy region with the label for screen readers and the shapes hidden", () => {
    for (const shape of ["rows", "cards", "line"] as const) {
      const html = renderToStaticMarkup(h(PanelSkeleton, { label: "Loading…", shape, count: 4 }));
      expect(html).toMatch(/^<div role="status" aria-live="polite" aria-busy="true"[^>]*><span class="sr-only">Loading…<\/span>/);
      expect(html.match(/role="status"/g)).toHaveLength(1);
    }
    const rows = renderToStaticMarkup(h(PanelSkeleton, { label: "L", count: 4 }));
    expect(rows.match(/h-12 w-full/g)).toHaveLength(4);
  });

  it("an admin table still waiting for its first page shows row shapes", () => {
    const html = renderToStaticMarkup(h(DataTable<{ id: string }, "id">, { lang: "ar", caption: "c", columns: [{ id: "a", header: "A", cell: (r) => r.id }], rows: null, rowKey: (r) => r.id }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`<span class="sr-only">${TABLE_COPY.ar.loading}</span>`);
  });
});

describe("rule 2005: the top progress bar during route changes", () => {
  const here = "https://thakeen.com/en/app?tab=1";
  it("starts only for another page on this origin", () => {
    expect(startsProgress("/en/app/files", here)).toBe(true);
    expect(startsProgress("/en/app?tab=2", here)).toBe(true);
    expect(startsProgress("/en/app?tab=1", here)).toBe(false);
    expect(startsProgress("/en/app?tab=1#top", here)).toBe(false);
    expect(startsProgress("https://evil.example/en/app", here)).toBe(false);
    expect(startsProgress("http://[::1", here)).toBe(false);
  });

  it("a fast navigation never shows; a slow one shows, fades and never sticks", () => {
    vi.useFakeTimers();
    const s = progressStore();
    const seen: string[] = [];
    s.subscribe(() => seen.push(s.phase()));
    s.start();
    vi.advanceTimersByTime(PROGRESS_MS.showAfter - 1);
    s.finish();
    expect(seen).toEqual(["waiting", "idle"]);

    seen.length = 0;
    s.start();
    s.start(); // A second start while one runs changes nothing.
    vi.advanceTimersByTime(PROGRESS_MS.showAfter);
    expect(s.phase()).toBe("running");
    s.finish();
    expect(s.phase()).toBe("ending");
    vi.advanceTimersByTime(PROGRESS_MS.fade);
    expect(seen).toEqual(["waiting", "running", "ending", "idle"]);

    s.start();
    vi.advanceTimersByTime(PROGRESS_MS.maxMs + PROGRESS_MS.fade);
    expect(s.phase()).toBe("idle");
  });

  it("the router hook tells the bar through one window event, and never throws", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { location: { href: here }, dispatchEvent });
    onRouterTransitionStart("/en/app/files");
    onRouterTransitionStart("/en/app?tab=1");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe(PROGRESS_EVENT);
    vi.stubGlobal("window", { location: { href: here }, dispatchEvent: () => { throw new Error("x"); } });
    expect(() => onRouterTransitionStart("/en/app/files")).not.toThrow();
  });

  it("the server page carries no bar; the bar is decoration, mirrored in Arabic and still under reduced motion", () => {
    expect(renderToStaticMarkup(h(RouteProgress))).toBe("");
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.route-progress \{[^}]*inset-inline: 0;[^}]*background: var\(--color-primary\);[^}]*transform-origin: left;/);
    expect(css).toMatch(/\[dir="rtl"\] \.route-progress \{ transform-origin: right; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.route-progress \{ animation: none; transition: none;/);
    expect(read("src/components/ui/RouteProgress.tsx")).toMatch(/aria-hidden/);
  });
});

describe("rule 2006: settings in two groups", () => {
  it("the groups hold every section once, in the old order, with no new path", () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(["you", "workspace"]);
    expect(SETTINGS_GROUPS.flatMap((g) => g.sections)).toEqual([...SETTINGS_SECTIONS]);
    expect(SETTINGS_GROUPS[0].sections).toEqual(["account", "security", "notifications"]);
    expect(groupOf("danger")).toBe("workspace");
    expect(SETTINGS_COPY.ar.groups).toEqual({ you: "أنت", workspace: "مساحة العمل" });
    expect(SETTINGS_COPY.en.groups).toEqual({ you: "You", workspace: "Workspace" });
  });

  it("the list names each group with a heading, in both languages, and links the same sections", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(h(SettingsNav, { lang, variant: "list" }));
      const you = html.indexOf(`>${SETTINGS_COPY[lang].groups.you}</h2>`);
      const ws = html.indexOf(`>${SETTINGS_COPY[lang].groups.workspace}</h2>`);
      expect(you).toBeGreaterThan(-1);
      expect(ws).toBeGreaterThan(you);
      expect(html).toContain('aria-labelledby="settings-group-you"');
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual(SETTINGS_SECTIONS.map((s) => settingsHref((p) => appHref(lang, p), s)));
      expect(html.indexOf(settingsHref((p) => appHref(lang, p), "notifications"))).toBeLessThan(ws);
      expect(html.indexOf(settingsHref((p) => appHref(lang, p), "brand"))).toBeGreaterThan(ws);
    }
  });

  it("the side column labels each list by its group and marks the open section", () => {
    const html = renderToStaticMarkup(h(SettingsNav, { lang: "en", current: "billing" }));
    expect(html).toContain('<ul aria-labelledby="settings-col-workspace"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/en\/app\/settings\/billing"/);
  });
});

describe("rule 2007: a table's filters, sort and page in the address", () => {
  it("a change keeps the other choices and goes back to page 1; defaults leave the address", () => {
    const base = "plan=pro&page=3";
    expect(queryHref("/en/admin/users", base, { sort: "email" }, USERS, { page: 1 })).toBe("/en/admin/users?plan=pro&sort=email");
    expect(queryHref("/en/admin/users", base, { page: 4 }, USERS)).toBe("/en/admin/users?plan=pro&page=4");
    expect(queryHref("/en/admin/users", base, { plan: "" }, USERS, { page: 1 })).toBe("/en/admin/users");
  });

  it("typed text replaces the history entry; a filter, a sort or a page is a step of its own", () => {
    expect(historyFor<UserQuery>({ q: "ab" }, ["q"])).toBe("replace");
    expect(historyFor<UserQuery>({ q: "ab", plan: "pro" }, ["q"])).toBe("push");
    expect(historyFor<UserQuery>({ page: 2 }, ["q"])).toBe("push");
    expect(historyFor<UserQuery>({}, ["q"])).toBe("push");
  });

  it("an address the list would not honour is put right; a canonical one is left alone", () => {
    expect(canonicalHref("/en/admin/users", "plan=pro&sort=email", USERS)).toBeNull();
    expect(canonicalHref("/en/admin/users", "", USERS)).toBeNull();
    expect(canonicalHref("/en/admin/users", "page=-3&sort=bogus&per=7&dir=up&plan=gold&filter=x&evil=1", USERS)).toBe("/en/admin/users");
    expect(canonicalHref("/en/admin/users", "page=2&page=9&plan=pro", USERS)).toBe("/en/admin/users?plan=pro&page=2");
    expect(canonicalHref("/en/admin/users", `q=${"a".repeat(130)}`, USERS)).toBe(`/en/admin/users?q=${"a".repeat(120)}`);
    expect(parseUserQuery(new URLSearchParams("page=99999999&per=100"))).toEqual({ ...DEFAULT_USER_QUERY, page: 10_000, per: 100 });
  });

  it("the hook pushes a step for a choice, replaces for typing, and reads the address at the moment of the change", () => {
    let api: ReturnType<typeof useUrlQuery<UserQuery>> | null = null;
    nav.search = "plan=pro&page=3";
    const Probe = () => { api = useUrlQuery(USERS, ["q"] as const); return null; };
    renderToStaticMarkup(h(Probe));
    expect(api!.query).toEqual({ ...DEFAULT_USER_QUERY, plan: "pro", page: 3 });

    // The debounced search fires after the founder already picked a filter: that filter is in the bar by now.
    vi.stubGlobal("window", { location: { search: "?plan=pro&filter=suspended&page=3" } });
    api!.setQuery({ q: "sara" });
    expect(nav.replace).toHaveBeenLastCalledWith("/en/admin/users?q=sara&plan=pro&filter=suspended", { scroll: false });
    api!.setQuery({ sort: "credits" });
    expect(nav.push).toHaveBeenLastCalledWith("/en/admin/users?plan=pro&filter=suspended&sort=credits", { scroll: false });
    api!.setQuery({ page: 5 });
    expect(nav.push).toHaveBeenLastCalledWith("/en/admin/users?plan=pro&filter=suspended&page=5", { scroll: false });
  });

  it("the Users list reads and writes its query through the hook only", () => {
    const users = read("src/components/admin/Users.tsx");
    expect(users).toContain("useUrlQuery(USER_CODEC, TYPED)");
    expect(users).not.toMatch(/router\.(push|replace)\(/);
  });
});
