import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { jar, json, newUser, signIn, signOut, supportAccess } from "./helpers/session";
import { db } from "@/lib/db";
import { IMPERSONATE_STOP_PER_IP } from "@/lib/rate";
import { safeHref, safeNext } from "@/lib/safe-next";
import { render } from "@/lib/md";

const sent: { to: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (...a: unknown[]) => { const { to: to, text: text } = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as { to: string; subject: string; text: string }; sent.push({ to, text }); return true; } }));

import * as impersonate from "@/app/api/admin/impersonate/route";
import * as forgot from "@/app/api/auth/forgot/route";

/**
 * Auth hardening (rules 540-547, docs/system/tests.md): the public impersonation-stop route writes the founder audit
 * log only for a real impersonation session and is rate limited; `?next=` and Markdown links stay on this site; the
 * password reset token travels in the URL fragment, never a query string.
 */

let ipN = 0;
const ip = () => `192.0.2.${++ipN}`;
const stop = (addr = ip()) => {
  const form = new FormData();
  form.set("lang", "en");
  return impersonate.POST(new Request("https://nashr.test/api/admin/impersonate", { method: "POST", body: form, headers: { "x-forwarded-for": addr } }));
};
const adminLog = async () => (await db.lrange("admin:log", 0, -1)).map((r) => JSON.parse(r) as { actor: string; email: string; what: string });

beforeEach(async () => { signOut(); await db.del("admin:log"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("impersonation stop (rules 540-542)", () => {
  it("540: a forged nashr_impersonate cookie with no impersonation session writes nothing to admin:log", async () => {
    // Anonymous: only the cookie.
    jar().set("thakeen_impersonate", "victim@test.example");
    expect((await stop()).status).toBe(303);
    // A normal customer session plus the cookie.
    const u = await newUser("imp");
    await signIn(u.email);
    jar().set("thakeen_impersonate", "victim@test.example");
    expect((await stop()).status).toBe(303);
    // A founder's own return cookie plus the forged one: still no impersonation session to burn.
    signOut();
    await supportAccess("victim@test.example");
    expect((await stop()).status).toBe(303);
    expect(await adminLog()).toEqual([]);
    // The caller's own helper cookies are still cleared.
    expect(jar().has("thakeen_impersonate")).toBe(false);
    expect(jar().has("thakeen_return")).toBe(false);
  });

  it("541: a real impersonation session logs its own founder and account, never the cookie value or a literal", async () => {
    const u = await newUser("imp");
    const founder = "real-founder@test.example";
    const temp = await signIn(u.email, { imp: founder });
    jar().set("thakeen_impersonate", "someone-else@test.example");
    expect((await stop()).status).toBe(303);
    const rows = await adminLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: founder, email: u.email, what: "impersonate:stop" });
    expect(JSON.stringify(rows)).not.toContain("someone-else@test.example");
    expect(await (await import("@/lib/auth")).sessionRecord(temp)).toBeNull();
    // The burned session cannot be replayed into a second log row.
    jar().set("thakeen_session", temp);
    await stop();
    expect(await adminLog()).toHaveLength(1);
  });

  it("542: the route is rate limited per client address", async () => {
    const addr = ip();
    for (let i = 0; i < IMPERSONATE_STOP_PER_IP; i++) expect((await stop(addr)).status).toBe(303);
    expect((await stop(addr)).status).toBe(429);
    expect((await stop()).status).toBe(303);
  });
});

describe("same-site redirects and links (rules 543-545)", () => {
  const hostile = ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "https://evil.com", "http://evil.com", "javascript:alert(1)", " //evil.com", "evil.com", ""];

  it("543: safeNext refuses every off-site or control-character form and keeps real paths", () => {
    for (const n of hostile) expect(safeNext(n), JSON.stringify(n)).toBe("");
    expect(safeNext(null)).toBe("");
    expect(safeNext("/ar/app/inbox")).toBe("/ar/app/inbox");
    expect(safeNext("/en/app?tab=plans#x")).toBe("/en/app?tab=plans#x");
  });

  it("544: the login and signup forms use safeNext, not their own pattern", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(src.match(/safeNext\(nextParam\)/g)).toHaveLength(2);
    expect(src).not.toContain("/^\\/(?![\\/\\\\])/");
  });

  it("545: Markdown links to //host, /\\host or control-character paths render as #", () => {
    for (const h of ["//evil.com", "/\\evil.com", "/\t/evil.com", "https://evil.com\\@x", "javascript:alert(1)"]) expect(safeHref(h), JSON.stringify(h)).toBe("#");
    expect(safeHref("/ar/app/inbox")).toBe("/ar/app/inbox");
    expect(safeHref("#plans")).toBe("#plans");
    expect(safeHref("https://thakeen.com/x")).toBe("https://thakeen.com/x");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(render("[x](//evil.com)")).toContain('href="#"');
    expect(render("[x](/\\evil.com)")).toContain('href="#"');
    expect(render("[x](/ar/app)")).toContain('href="/ar/app"');
  });
});

describe("password reset link (rules 546-547)", () => {
  beforeEach(() => { sent.length = 0; vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>"); });

  it("546: the emailed link carries the token in the fragment #t=, never ?token=", async () => {
    const u = await newUser("reset");
    await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email, lang: "en" }, { "x-forwarded-for": ip() }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\/en\/app\/reset#t=[a-f0-9]{64}/);
    expect(sent[0].text).not.toContain("?token=");
    expect(sent[0].text).not.toMatch(/[?&]t=/);
  });

  it("547: the reset form reads the fragment, clears it, and never reads a query token", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    const form = src.slice(src.indexOf("export function ResetForm"));
    expect(form).toContain("readFragmentToken(window.location.hash)");
    expect(form).toContain("withoutFragment(window.location)");
    expect(form).not.toContain('get("token")');
  });
});
