import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleOf, matchHandle, wsHandle } from "@/lib/ws-handle";
import {
  appHref,
  asHandle,
  HANDLE_RE,
  handleOfPath,
  personPage,
  splitWsPath,
  stripWs,
  workspaceFree,
  workspaceMissing,
} from "@/lib/ws-path";

/**
 * Rule 2114 (multi-workspace release M2, docs/specs/2026-10-18-multi-org.md section 7): the workspace handle is an
 * opaque HMAC of the account id, never an address, never a key; the link helpers keep today's links when no handle is
 * passed (so `MULTI_ORG` off changes nothing) and keep a Part C `b/{brandId}` segment untouched.
 */

describe("rule 2114: the handle", () => {
  const ids = ["owner@example.com", "a_bbbbbbbbbbbbbbbbbbbbbbbb", "a_cccccccccccccccccccccccc", "x@y.co"];

  it("has the shape w_ + 16 base32 characters, is stable and differs per account", () => {
    const hs = ids.map(wsHandle);
    for (const h of hs) expect(h).toMatch(HANDLE_RE);
    expect(ids.map(wsHandle)).toEqual(hs);
    expect(new Set(hs).size).toBe(ids.length);
  });

  it("never carries the address or any part of it", () => {
    const h = wsHandle("owner@example.com");
    expect(h).not.toMatch(/[@.:#]/);
    expect(h).not.toContain("owner");
    expect(h).not.toContain("example");
  });

  it("a one-character change of the id changes the handle", () => {
    expect(wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb")).not.toBe(wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbc"));
    expect(wsHandle("")).toMatch(HANDLE_RE);
  });

  it("handleOf reads the account id, and matchHandle picks only among the given ids", () => {
    expect(handleOf({ id: "a_bbbbbbbbbbbbbbbbbbbbbbbb", email: "o@example.com" })).toBe(wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb"));
    expect(handleOf({ email: "o@example.com" })).toBe(wsHandle("o@example.com"));
    expect(matchHandle(wsHandle(ids[2]), ids)).toBe(ids[2]);
    expect(matchHandle(wsHandle("someone-else"), ids)).toBeNull();
    expect(matchHandle("w_aaaaaaaaaaaaaaaa", ids)).toBeNull();
  });

  it("no key builder takes a handle, and nothing stores or indexes one", () => {
    const keys = readFileSync("src/lib/keys.ts", "utf8");
    expect(keys).not.toMatch(/handle/i);
    const src = readFileSync("src/lib/ws-handle.ts", "utf8");
    expect(src).not.toMatch(/from "\.\/db"|db\./);
  });
});

describe("rule 2114: paths and links", () => {
  const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");

  it("asHandle accepts only the handle shape", () => {
    expect(asHandle(h)).toBe(h);
    for (const bad of [null, undefined, "", "w_short", "a_bbbbbbbbbbbbbbbbbbbbbbbb", "owner@example.com", `${h}x`, "W_AAAAAAAAAAAAAAAA"]) {
      expect(asHandle(bad)).toBeNull();
    }
  });

  it("splitWsPath and stripWs read /{lang}/app/w/{handle}/rest", () => {
    expect(splitWsPath(`/ar/app/w/${h}`)).toEqual({ lang: "ar", handle: h, rest: "" });
    expect(splitWsPath(`/ar/app/w/${h}/`)).toEqual({ lang: "ar", handle: h, rest: "" });
    expect(splitWsPath(`/en/app/w/${h}/tasks/t1`)).toEqual({ lang: "en", handle: h, rest: "/tasks/t1" });
    expect(splitWsPath(`/en/app/w/${h}/b/brand1/tasks`)).toEqual({ lang: "en", handle: h, rest: "/b/brand1/tasks" });
    expect(splitWsPath("/en/app/w/not-a-handle/tasks")).toBeNull();
    expect(splitWsPath("/en/app/tasks")).toBeNull();
    expect(stripWs(`/en/app/w/${h}/tasks`)).toBe("/en/app/tasks");
    expect(stripWs(`/en/app/w/${h}`)).toBe("/en/app");
    expect(stripWs("/en/app/tasks")).toBe("/en/app/tasks");
    expect(handleOfPath(`/ar/app/w/${h}/files`)).toBe(h);
    expect(handleOfPath("/ar/app/files")).toBeNull();
  });

  it("appHref without a handle is today's link (MULTI_ORG off), with one it nests under w/{handle}", () => {
    expect(appHref("ar")).toBe("/ar/app");
    expect(appHref("ar", "/tasks?tab=done#x")).toBe("/ar/app/tasks?tab=done#x");
    expect(appHref("ar", "/tasks", null)).toBe("/ar/app/tasks");
    expect(appHref("ar", "/tasks", "garbage")).toBe("/ar/app/tasks");
    expect(appHref("ar", "", h)).toBe(`/ar/app/w/${h}`);
    expect(appHref("ar", "/", h)).toBe(`/ar/app/w/${h}`);
    expect(appHref("en", "/tasks?tab=done#x", h)).toBe(`/en/app/w/${h}/tasks?tab=done#x`);
    expect(appHref("en", "/b/brand1/files", h)).toBe(`/en/app/w/${h}/b/brand1/files`);
    expect(stripWs(appHref("en", "/files/f1", h))).toBe("/en/app/files/f1");
  });

  it("person-level pages never take a handle", () => {
    for (const p of ["/login", "/signup", "/forgot", "/reset", "/verify", "/join", "/workspaces", "/settings/security", "/admin/users"]) {
      expect(personPage(`/ar/app${p}`)).toBe(true);
      expect(appHref("ar", p, h)).toBe(`/ar/app${p}`);
    }
    expect(personPage("/ar/app/settings/account")).toBe(false);
    expect(personPage("/ar/app/loginx")).toBe(false);
    expect(personPage("/ar/app")).toBe(false);
  });
});

describe("rule 2113: the pure guard", () => {
  const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");

  it("a state-changing request with the session cookie and no handle is missing its workspace", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(workspaceMissing(m, "/api/tasks", true, null)).toBe(true);
    expect(workspaceMissing("POST", "/api/tasks", true, "garbage")).toBe(true);
    expect(workspaceMissing("POST", "/api/tasks", true, h)).toBe(false);
    expect(workspaceMissing("GET", "/api/tasks", true, null)).toBe(false);
    expect(workspaceMissing("HEAD", "/api/tasks", true, null)).toBe(false);
    expect(workspaceMissing("POST", "/api/tasks", false, null)).toBe(false);
    expect(workspaceMissing("POST", "/ar/app/tasks", true, null)).toBe(false);
  });

  it("free paths pass: person-level, sign-in, console, OAuth, staging, public forms, crons, webhooks, MCP", () => {
    for (const p of [
      "/api/auth/login", "/api/auth/signup", "/api/workspaces", "/api/workspaces/", "/api/workspaces/switch",
      "/api/team/accept", "/api/account/2fa", "/api/account/sessions", "/api/account/email", "/api/account/google",
      "/api/admin/users/x", "/api/oauth/approve", "/api/staging-access", "/api/waitlist", "/api/affiliates",
      "/api/ops/telegram", "/api/mcp", "/api/cron/daily", "/api/media/hook/kie", "/api/billing/paymob/webhook",
    ]) {
      expect(workspaceFree(p)).toBe(true);
      expect(workspaceMissing("POST", p, true, null)).toBe(false);
    }
  });

  it("a look-alike of a free path is guarded", () => {
    for (const p of ["/api/account", "/api/team/acceptx", "/api/team/invite", "/api/workspacesx", "/api/mcpx", "/api/brand"]) {
      expect(workspaceFree(p)).toBe(false);
    }
  });
});
