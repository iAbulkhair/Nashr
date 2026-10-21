import { describe, expect, it, vi } from "vitest";
import { addShadowMembership, json, newMember, newUser, params, signIn, withHeaders } from "./helpers/session";
import * as proposalRoute from "@/app/api/brand/proposals/[id]/route";
import { trackRounds } from "./helpers/rounds";
import { acct, currentUser, currentUserUnverified, sc, sessionKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { personKey, storedAccountId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { deleteMembership, withAccountTeamLock } from "@/lib/team";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER } from "@/lib/ws-path";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M2 (docs/specs/2026-10-18-multi-org.md section 7 "Workspace in the link"), with `MULTI_ORG` on for
 * this file. Rules 2112 (the handle is only a selector among the person's own memberships: a foreign, made-up, stale or
 * malformed handle answers the same 404, and nothing is written), 2111 (a membership removed ends its handle at the next
 * request) and 2135 (two rounds on the session's own workspace, three on another).
 */

/** `notFound()` throws an error whose digest names the 404 fallback (next/dist/client/components/http-access-fallback). */
const is404 = (e: unknown) => typeof (e as { digest?: unknown })?.digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
const inWs = <T>(handle: string, fn: () => Promise<T>) => withHeaders({ [WS_HEADER]: handle }, fn);
async function expect404(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(is404(e), String(e)).toBe(true);
}

async function ownerWithTwo() {
  const u = await newUser("ws", { shadow: false });
  const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
  return { u, shadow };
}

describe("rule 2112: the handle picks among the person's own accounts", () => {
  it("no handle and the session's own handle: the session's account", async () => {
    const { u } = await ownerWithTwo();
    await signIn(u.email);
    expect(acct((await currentUser())!)).toBe(acct(u));
    expect(acct((await inWs(wsHandle(acct(u)), () => currentUser()))!)).toBe(acct(u));
  });

  it("another workspace's handle resolves there, its own scope, and writes neither acct nor lastorg", async () => {
    const { u, shadow } = await ownerWithTwo();
    const token = await signIn(u.email);
    const before = await db.get(sessionKey(token));
    const v = await inWs(wsHandle(shadow.aid), () => currentUser());
    expect(acct(v!)).toBe(shadow.aid);
    expect(sc(v!)).toBe(shadow.aid);
    expect(v!.actor?.role).toBe("member");
    expect(v!.actor?.pid).toBe(ownerOf(u));
    expect(await db.get(sessionKey(token))).toEqual(before);
    expect(await db.get(personKey.lastOrg(ownerOf(u)))).toBeNull();
  });

  it("a member reaches their own other workspace and their home, nothing else", async () => {
    const { u } = await ownerWithTwo();
    const m = await newMember(u, "member", "wm", { shadow: false });
    const other = await addShadowMembership(m.pid, new Date().toISOString());
    await signIn(m.email);
    expect(acct((await inWs(wsHandle(acct(u)), () => currentUser()))!)).toBe(acct(u));
    expect(acct((await inWs(wsHandle(other.aid), () => currentUser()))!)).toBe(other.aid);
    const stranger = await newUser("st", { shadow: false });
    await expect404(inWs(wsHandle(acct(stranger)), () => currentUser()));
  });

  it("foreign, made-up and malformed handles all answer the same 404", async () => {
    const { u } = await ownerWithTwo();
    const stranger = await newUser("st", { shadow: false });
    await signIn(u.email);
    for (const h of [wsHandle(acct(stranger)), "w_aaaaaaaaaaaaaaaa", "garbage", acct(stranger), ""]) {
      await expect404(inWs(h, () => currentUser()));
      await expect404(inWs(h, () => currentUserUnverified()));
    }
  });

  it("a stale or forged orgs: entry grants nothing (the forward records are re-checked)", async () => {
    const { u } = await ownerWithTwo();
    const stranger = await newUser("st", { shadow: false });
    await db.sadd(personKey.orgs(ownerOf(u)), acct(stranger));
    await signIn(u.email);
    await expect404(inWs(wsHandle(acct(stranger)), () => currentUser()));
  });

  it("an impersonation reaches only its own account's handle", async () => {
    const { u, shadow } = await ownerWithTwo();
    await signIn(u.email, { imp: "founder@test.example" });
    expect(acct((await inWs(wsHandle(acct(u)), () => currentUser()))!)).toBe(acct(u));
    await expect404(inWs(wsHandle(shadow.aid), () => currentUser()));
  });

  it("a session written before R1 reaches only its own account's handle", async () => {
    const u = await newUser("lg", { legacy: true, shadow: false });
    const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
    await signIn(u.email, { legacyShape: true });
    expect(acct((await inWs(wsHandle(acct(u)), () => currentUser()))!)).toBe(acct(u));
    await expect404(inWs(wsHandle(shadow.aid), () => currentUser()));
  });

  it("a signed-out request is still null, not 404", async () => {
    const { u } = await ownerWithTwo();
    await signIn(u.email);
    const { jar } = await import("./helpers/session");
    jar().clear();
    expect(await inWs(wsHandle(acct(u)), () => currentUser())).toBeNull();
  });
});

describe("rule 2111: a membership removed ends its handle at the next request", () => {
  it("removing the shadow membership turns its handle into a 404", async () => {
    const { u, shadow } = await ownerWithTwo();
    await signIn(u.email);
    expect(acct((await inWs(wsHandle(shadow.aid), () => currentUser()))!)).toBe(shadow.aid);
    await withAccountTeamLock(storedAccountId(shadow.aid), () => deleteMembership(storedAccountId(shadow.aid), ownerOf(u), { home: false, teamLocked: true }));
    await expect404(inWs(wsHandle(shadow.aid), () => currentUser()));
    expect(acct((await currentUser())!)).toBe(acct(u));
  });
});

describe("rule 2135: rounds", () => {
  const rounds = async (handle: string | null) => {
    const t = trackRounds();
    const v = handle ? await inWs(handle, () => currentUser()) : await currentUser();
    t.stop();
    return { v, n: t.rounds() };
  };

  it("two rounds without a handle and on the session's own; three on another workspace", async () => {
    const { u, shadow } = await ownerWithTwo();
    await signIn(u.email);
    expect((await rounds(null)).n).toBe(2);
    expect((await rounds(wsHandle(acct(u)))).n).toBe(2);
    const r = await rounds(wsHandle(shadow.aid));
    expect(acct(r.v!)).toBe(shadow.aid);
    expect(r.n).toBe(3);
  });
});

describe("rule 2113: the route wrapper checks the workspace too", () => {
  const post = (headers: Record<string, string>) =>
    proposalRoute.POST(json("/api/brand/proposals/p1", "POST", { action: "dismiss" }, headers), params({ id: "p1" }));

  it("no handle: 409 workspace_missing before anything runs", async () => {
    const { u } = await ownerWithTwo();
    await signIn(u.email);
    const r = await post({});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "workspace_missing" });
  });

  it("a foreign handle: 404 not_found as JSON; the own handle reaches the route", async () => {
    const { u } = await ownerWithTwo();
    const stranger = await newUser("st", { shadow: false });
    await signIn(u.email);
    const r = await withHeaders({ [WS_HEADER]: wsHandle(acct(stranger)) }, () => post({ [WS_HEADER]: wsHandle(acct(stranger)) }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ ok: false, error: "not_found" });
    const own = await withHeaders({ [WS_HEADER]: wsHandle(acct(u)) }, () => post({ [WS_HEADER]: wsHandle(acct(u)) }));
    expect(own.status).toBe(404); // the proposal does not exist: the route ran, in the caller's own workspace
    expect((await own.json()).error).toBe("not_found");
  });
});
