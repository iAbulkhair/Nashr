import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as convRoute from "@/app/api/conversations/route";
import { acct, sc } from "@/lib/auth";
import { listConversations } from "@/lib/conversations";
import { ownerOf } from "@/lib/membership";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER, oldAppTarget } from "@/lib/ws-path";
import { installWorkspaceFetch, withWsHeader, wsHeaderFor } from "@/lib/api-client";
import { addShadowMembership, json, newUser, signIn, withHeaders } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M2, the shell's half of the workspace in the link (docs/specs/2026-10-18-multi-org.md section 7
 * "Where the handle comes from" and "Old URLs"; rule 2113): a request from a page under `w/{handle}` names that page's
 * workspace, an old address moves to the session's workspace with its query, and two tabs on two handles each write
 * into their own account.
 */

const origin = "https://thakeen.example";
const h1 = wsHandle("a_aaaaaaaaaaaaaaaaaaaaaaaa");
const h2 = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");

describe("the fetch header follows the page's link", () => {
  it("same-site /api/ requests from a page under w/{handle} carry that handle", () => {
    expect(wsHeaderFor("/api/tasks", `/ar/app/w/${h1}/tasks`, origin)).toBe(h1);
    expect(wsHeaderFor(`${origin}/api/tasks?x=1`, `/en/app/w/${h2}`, origin)).toBe(h2);
    expect(wsHeaderFor(new URL("/api/brand", origin), `/ar/app/w/${h1}/brand`, origin)).toBe(h1);
  });

  it("no header for another site, a non-API path, or a page without a handle", () => {
    expect(wsHeaderFor("https://evil.example/api/tasks", `/ar/app/w/${h1}/tasks`, origin)).toBeNull();
    expect(wsHeaderFor("/ar/app/tasks", `/ar/app/w/${h1}/tasks`, origin)).toBeNull();
    expect(wsHeaderFor("/api/tasks", "/ar/app/tasks", origin)).toBeNull();
    expect(wsHeaderFor("/api/tasks", "/ar/app/w/not-a-handle/tasks", origin)).toBeNull();
    expect(wsHeaderFor("http://[bad", `/ar/app/w/${h1}`, origin)).toBeNull();
  });

  it("withWsHeader keeps the caller's headers and never overrides one already set", () => {
    const init = withWsHeader("/api/tasks", { method: "POST", headers: { "content-type": "application/json" } }, h1);
    const hs = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(hs.get("content-type")).toBe("application/json");
    expect(hs.get(WS_HEADER)).toBe(h1);
    expect(new Headers(withWsHeader("/api/tasks", { headers: { [WS_HEADER]: h2 } }, h1).headers).get(WS_HEADER)).toBe(h2);
  });

  it("installWorkspaceFetch wraps window.fetch once and adds the header", async () => {
    const seen: (string | null)[] = [];
    const fake = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(WS_HEADER));
      return new Response("{}");
    });
    vi.stubGlobal("window", { fetch: fake, location: { pathname: `/ar/app/w/${h1}/tasks`, origin } });
    try {
      installWorkspaceFetch();
      installWorkspaceFetch();
      await window.fetch("/api/tasks", { method: "POST" });
      await window.fetch("https://other.example/x");
      expect(seen).toEqual([h1, null]);
      expect(fake).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("old addresses move into the session's workspace (307 from the layout)", () => {
  it("keeps the page and the query", () => {
    expect(oldAppTarget("ar", "/ar/app/tasks", "?filter=open", h1)).toBe(`/ar/app/w/${h1}/tasks?filter=open`);
    expect(oldAppTarget("en", "/en/app", "", h1)).toBe(`/en/app/w/${h1}`);
    expect(oldAppTarget("ar", "/ar/app/settings/brand", "", h1)).toBe(`/ar/app/w/${h1}/settings/brand`);
  });

  it("never loops and leaves person pages, other paths and a missing handle alone", () => {
    expect(oldAppTarget("ar", `/ar/app/w/${h1}/tasks`, "", h1)).toBeNull();
    expect(oldAppTarget("ar", `/ar/app/w/${h2}/tasks`, "", h1)).toBeNull();
    for (const p of ["/ar/app/login", "/ar/app/workspaces", "/ar/app/join", "/ar/app/settings/security", "/ar/app/admin"]) expect(oldAppTarget("ar", p, "", h1), p).toBeNull();
    expect(oldAppTarget("ar", "/ar/pricing", "", h1)).toBeNull();
    expect(oldAppTarget("ar", "/ar/application", "", h1)).toBeNull();
    expect(oldAppTarget("ar", "/ar/app/tasks", "", null)).toBeNull();
    expect(oldAppTarget("ar", "/ar/app/tasks", "", "garbage")).toBeNull();
  });

  it("the layout applies it only with MULTI_ORG on, from the session's own handle", () => {
    const src = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(src).toMatch(/MULTI_ORG && user && !isPublic && !handle\)/);
    expect(src).toContain('oldAppTarget(lang, path, h.get("x-search") ?? "", handleOf(user))');
    expect(src).toContain("handle={handle} multiOrg={MULTI_ORG}");
  });
});

describe("rule 2113: two tabs on two handles write into their own accounts", () => {
  it("each conversation lands in the workspace its handle names", async () => {
    const u = await newUser("tabs", { shadow: false });
    const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
    await signIn(u.email);
    const post = (handle: string, title: string) =>
      withHeaders({ [WS_HEADER]: handle }, () => convRoute.POST(json("/api/conversations", "POST", { title, agent: "noor" }, { [WS_HEADER]: handle })));
    // One after the other: the test helper's request headers are one store, so two at once would share it.
    const a = await post(wsHandle(acct(u)), "home tab");
    const b = await post(wsHandle(shadow.aid), "other tab");
    expect([a.status, b.status]).toEqual([200, 200]);
    const [home, other] = await Promise.all([listConversations(sc(u)), listConversations(shadow.aid)]);
    expect(home.map((c) => c.title)).toEqual(["home tab"]);
    expect(other.map((c) => c.title)).toEqual(["other tab"]);
  });

  it("the same write without a handle is refused, nothing written", async () => {
    const u = await newUser("tabs0", { shadow: false });
    await signIn(u.email);
    const r = await convRoute.POST(json("/api/conversations", "POST", { title: "x" }));
    expect(r.status).toBe(409);
    expect(await listConversations(sc(u))).toEqual([]);
  });
});
