import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { acct, currentUser } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER } from "@/lib/ws-path";
import { addShadowMembership, newUser, params, signIn, withHeaders } from "./helpers/session";
import { ownerOf } from "@/lib/membership";
import * as workspacesRoute from "@/app/api/workspaces/route";
import * as switchRoute from "@/app/api/workspaces/switch/route";
import { json } from "./helpers/session";
import * as acceptRoute from "@/app/api/team/accept/route";
import { createInvite } from "@/lib/team";
import * as logRoute from "@/app/api/team/log/route";
import * as transferRoute from "@/app/api/team/transfer/route";
import * as xferAcceptRoute from "@/app/api/workspaces/transfer/route";
import * as invitesRoute from "@/app/api/workspaces/invites/route";
import * as personRoute from "@/app/api/workspaces/person/route";
import * as peopleRoute from "@/app/api/admin/people/[email]/route";
import { teamPerms } from "@/components/app/teamPerms";
import { db } from "@/lib/db";
import { accountKey } from "@/lib/keys";

/**
 * Multi-workspace M2 with the switch OFF, as production runs it (docs/superpowers/plans/2026-10-20-multi-org-m2.md,
 * Global Constraints "Switch"; rule 2132: production behaviour is identical). The M2 test files turn `MULTI_ORG` on per
 * file; this one proves every M2 path gives M1's answer while it is off: the proxy rewrites nothing and answers no 409,
 * `currentUser()` ignores any handle, and the new routes answer 404 (added with them).
 */

const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");
const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest("https://thakeen.example" + path, {
    method: init.method ?? "GET",
    headers: { cookie: "thakeen_session=tok", "sec-fetch-site": "same-origin", ...(init.headers ?? {}) },
  });

describe("M2 with MULTI_ORG off changes nothing", () => {
  it("the switch is off", () => {
    expect(MULTI_ORG).toBe(false);
  });

  it("the proxy does not rewrite /w/{handle} and sets no x-thakeen-ws", () => {
    const r = proxy(req(`/ar/app/w/${h}/tasks`));
    expect(r.headers.get("x-middleware-rewrite")).toBeNull();
    expect(r.headers.get(`x-middleware-request-${WS_HEADER}`)).toBeNull();
    expect(r.headers.get("x-middleware-request-x-pathname")).toBe(`/ar/app/w/${h}/tasks`);
  });

  it("a state-changing API request without a handle passes on (no 409)", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(proxy(req("/api/tasks/x", { method })).status, method).toBe(200);
  });

  it("currentUser() ignores a handle, foreign or own", async () => {
    const u = await newUser("off", { shadow: false });
    const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
    const stranger = await newUser("offst", { shadow: false });
    await signIn(u.email);
    for (const handle of [wsHandle(shadow.aid), wsHandle(acct(stranger)), "garbage"]) {
      const v = await withHeaders({ [WS_HEADER]: handle }, () => currentUser());
      expect(acct(v!)).toBe(acct(u));
    }
  });

  it("the workspaces routes answer 404 and write nothing", async () => {
    const u = await newUser("offws", { shadow: false });
    const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
    await signIn(u.email);
    expect((await workspacesRoute.GET()).status).toBe(404);
    expect((await workspacesRoute.POST(json("/api/workspaces", "POST", { name: "x" }))).status).toBe(404);
    expect((await switchRoute.POST(json("/api/workspaces/switch", "POST", { handle: wsHandle(shadow.aid) }))).status).toBe(404);
    expect(acct((await currentUser())!)).toBe(acct(u));
  });

  it("invites: an address that signs in is still unavailable, and {token, join: true} is only a preview", async () => {
    const A = await newUser("offia", { shadow: false });
    const B = await newUser("offib", { shadow: false });
    await signIn(A.email);
    const me = (await currentUser())!;
    expect(await createInvite(me, me.actor!, B.email, "member", "ar")).toEqual({ ok: false, error: "unavailable" });
    const r = await createInvite(me, me.actor!, `offnew-${Date.now()}@test.example`, "member", "ar");
    if (!r.ok) throw new Error(r.error);
    await signIn(B.email);
    const res = await acceptRoute.POST(json("/api/team/accept", "POST", { token: r.token, join: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview?: Record<string, unknown>; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(body.preview && "signIn" in body.preview).toBe(false);
  });

  it("the workspaces page does not exist", async () => {
    const page = (await import("@/app/[lang]/app/workspaces/page")).default;
    const e = await page({ params: Promise.resolve({ lang: "ar" }) }).then(() => null, (x: unknown) => x);
    expect(String((e as { digest?: string })?.digest)).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});

/**
 * Multi-workspace M3 with the switch OFF (docs/system/tests/2750-multi-org-m3.md): every new route answers 404 before it
 * reads a session, the Members page shows neither the log nor the transfer section, and an invite writes no inbox entry.
 */
describe("M3 with MULTI_ORG off changes nothing", () => {
  it("the M3 routes answer 404", async () => {
    const u = await newUser("offm3", { shadow: false });
    await signIn(u.email);
    expect((await logRoute.GET()).status).toBe(404);
    expect((await transferRoute.POST(json("/api/team/transfer", "POST", { email: "x@test.example", password: "abc12345" }))).status).toBe(404);
    expect((await transferRoute.DELETE()).status).toBe(404);
    expect((await xferAcceptRoute.POST(json("/api/workspaces/transfer", "POST", { handle: "w_aaaaaaaaaaaaaaaa", token: "0".repeat(64) }))).status).toBe(404);
    expect((await invitesRoute.GET()).status).toBe(404);
    expect((await personRoute.DELETE(json("/api/workspaces/person", "DELETE", { password: "abc12345" }))).status).toBe(404);
    expect(acct((await currentUser())!)).toBe(acct(u));
    // The console people view (rule 2755): after the console gate, 404 while the switch is off, no audit row.
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-flag-off-0123456789");
    const people = await peopleRoute.GET(json(`/api/admin/people/${encodeURIComponent(u.email)}`, "GET", undefined, { "x-admin-key": "test-admin-key-flag-off-0123456789" }), params({ email: encodeURIComponent(u.email) }));
    vi.unstubAllEnvs();
    expect(people.status).toBe(404);
  });

  it("the Members page offers no log and no transfer, and an invite leaves no inbox entry", async () => {
    const u = await newUser("offm3p", { shadow: false });
    await signIn(u.email);
    const me = (await currentUser())!;
    const perms = teamPerms(me);
    expect(perms.viewLog).toBe(false);
    expect(perms.transfer).toBe(false);
    const to = `offm3-${Date.now()}@test.example`;
    const r = await createInvite(me, me.actor!, to, "member", "ar");
    if (!r.ok) throw new Error(r.error);
    expect(await db.smembers(accountKey.invitesFor(to))).toEqual([]);
  });
});
