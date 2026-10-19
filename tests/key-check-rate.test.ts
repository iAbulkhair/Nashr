import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { sc } from "@/lib/auth";
import { globalKey, wsKey } from "@/lib/keys";
import { KEY_CHECK_FAILS_PER_DAY, KEY_CHECK_FAILS_PER_HOUR } from "@/lib/rate";
import { getConnection } from "@/lib/connectors/store";
import * as keyRoute from "@/app/api/connect/[provider]/key/route";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rule 2240 (docs/system/tests/2240-key-check-rate.md): every key connect asks an outside service whether the
 * credentials work, so failed checks are limited per workspace (ten an hour, thirty a day, every key provider together)
 * and the route cannot be used to try passwords against someone's site from our servers. A check that passes gives its
 * hit back; a refusal asks nothing of the outside service.
 */

const wp = (password: string) => keyRoute.POST(json("/api/connect/wordpress/key", "POST", { site: "https://blog.example.com", username: "editor", appPassword: password }), params({ provider: "wordpress" }));
/** A WordPress site that accepts one password only. */
function fakeSite(good = "right-SENTINEL") {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const sent = new Headers(init?.headers).get("authorization") ?? "";
    return sent === `Basic ${Buffer.from(`editor:${good}`).toString("base64")}` ? Response.json({ name: "Editor", capabilities: { publish_posts: true } }) : new Response("{}", { status: 401 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("failed key checks are limited per workspace (rule 2240)", () => {
  it("ten wrong passwords an hour, then 429 with Retry-After and the site is not asked again", async () => {
    const u = await newUser("keyrate-hour");
    await signIn(u.email);
    const site = fakeSite();
    for (let i = 0; i < KEY_CHECK_FAILS_PER_HOUR; i++) expect((await wp(`wrong-${i}`)).status).toBe(400);
    expect(site).toHaveBeenCalledTimes(KEY_CHECK_FAILS_PER_HOUR);
    const refused = await wp("right-SENTINEL");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("3600");
    expect(await refused.json()).toEqual({ ok: false, error: "slow_down" });
    expect(site).toHaveBeenCalledTimes(KEY_CHECK_FAILS_PER_HOUR);
    expect(await getConnection(sc(u), "wordpress")).toBeNull();
  });

  it("a check that passes gives its hit back, so connecting again and again is never refused", async () => {
    const u = await newUser("keyrate-good");
    await signIn(u.email);
    fakeSite();
    for (let i = 0; i < KEY_CHECK_FAILS_PER_HOUR + 5; i++) expect((await wp("right-SENTINEL")).status).toBe(200);
    expect(Number((await db.get(globalKey.rate(wsKey.keyCheckBucket(sc(u), "hour")))) ?? 0)).toBe(0);
    expect((await getConnection(sc(u), "wordpress"))?.meta?.account).toBe("Editor");
  });

  it("the day cap holds across hours, answered with a day's Retry-After", async () => {
    const u = await newUser("keyrate-day");
    await signIn(u.email);
    await db.set(globalKey.rate(wsKey.keyCheckBucket(sc(u), "day")), KEY_CHECK_FAILS_PER_DAY, 86400);
    const site = fakeSite();
    const r = await wp("right-SENTINEL");
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("86400");
    expect(site).not.toHaveBeenCalled();
  });

  it("the bucket is the caller's own workspace: another workspace keeps its allowance", async () => {
    const a = await newUser("keyrate-a");
    const b = await newUser("keyrate-b");
    await signIn(a.email);
    fakeSite();
    for (let i = 0; i < KEY_CHECK_FAILS_PER_HOUR; i++) await wp(`wrong-${i}`);
    expect((await wp("wrong-x")).status).toBe(429);
    signOut();
    await signIn(b.email);
    expect((await wp("right-SENTINEL")).status).toBe(200);
  });

  it("a missing field, an unknown provider or a member without the connectors role costs nothing", async () => {
    const u = await newUser("keyrate-free");
    await signIn(u.email);
    fakeSite();
    expect((await keyRoute.POST(json("/api/connect/wordpress/key", "POST", { site: "https://blog.example.com" }), params({ provider: "wordpress" }))).status).toBe(400);
    expect((await keyRoute.POST(json("/api/connect/nope/key", "POST", {}), params({ provider: "nope" }))).status).toBe(404);
    const m = await newMember(u, "member");
    signOut();
    await signIn(m.email);
    expect((await wp("wrong")).status).toBe(403);
    expect(await db.get(globalKey.rate(wsKey.keyCheckBucket(sc(u), "hour")))).toBeNull();
  });

  it("the route takes the hit before any check and gives it back only after every check passed", () => {
    const src = readFileSync("src/app/api/connect/[provider]/key/route.ts", "utf8");
    const take = src.indexOf("allow(buckets[0], KEY_CHECK_FAILS_PER_HOUR, WINDOW.hour)");
    const back = src.indexOf("await Promise.all(buckets.map((b) => giveBack(b)));");
    expect(src.indexOf('forbid(u, "connectors")')).toBeLessThan(take);
    expect(take).toBeLessThan(src.indexOf("verifyWordPress(data)"));
    expect(src.indexOf('fetch("https://a.klaviyo.com/api/accounts/"')).toBeLessThan(back);
    expect(back).toBeLessThan(src.indexOf("await saveConnection(sc(u), conn);"));
    expect(src).toContain('wsKey.keyCheckBucket(sc(u), "hour"), wsKey.keyCheckBucket(sc(u), "day")');
    expect([KEY_CHECK_FAILS_PER_HOUR, KEY_CHECK_FAILS_PER_DAY]).toEqual([10, 30]);
  });
});
