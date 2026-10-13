import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { jar, json, newUser, params, signIn, signOut } from "./helpers/session";
import { mediaEnv, noNetwork } from "./helpers/media";
import { db } from "@/lib/db";
import { deleteFile, listFiles, writeFile } from "@/lib/files";
import { deleteConnection, listConnections, OAUTH_COOKIE, saveConnection, saveState } from "@/lib/connectors/store";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { EDITABLE_BRAND_FIELDS, runTool } from "@/lib/chat";
import { chatCaps, chatRefusal } from "@/lib/rate";
import { currentUser, isAdminCookie } from "@/lib/auth";

/** Each test here is a bug that was live in the code and is now fixed; the test is what keeps it fixed. */

import * as filesRoute from "@/app/api/files/route";
import * as waitlistRoute from "@/app/api/waitlist/route";
import * as supportRoute from "@/app/api/support/route";
import * as affiliatesRoute from "@/app/api/affiliates/route";
import * as chatRoute from "@/app/api/chat/route";
import * as callbackRoute from "@/app/api/connect/[provider]/callback/route";

const ip = (addr: string) => ({ "x-forwarded-for": addr });
const brand = (over: Partial<Brand> = {}): Brand => ({ name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram", "whatsapp"], city: "الرياض", updatedAt: new Date().toISOString(), ...over });

beforeEach(() => signOut());

describe("a deleted file leaves the index with its record", () => {
  it("drops the name from the workspace file set, not only the record", async () => {
    const u = await newUser("del");
    await writeFile(u.email, "notes.md", "x", "user");
    expect(await db.smembers(`files:${u.email}`)).toEqual(["notes.md"]);
    await deleteFile(u.email, "notes.md");
    // The set used to keep the name for ever: listFiles then paid a read per deleted file, and the set grew unbounded.
    expect(await db.smembers(`files:${u.email}`)).toEqual([]);
    expect(await listFiles(u.email)).toEqual([]);
  });
  it("the route behaves the same, and writing the name again brings it back once", async () => {
    const u = await newUser("del");
    await signIn(u.email);
    await filesRoute.PUT(json("/api/files", "PUT", { name: "a.md", content: "1" }));
    await filesRoute.DELETE(json("/api/files?name=a.md", "DELETE"));
    await filesRoute.PUT(json("/api/files", "PUT", { name: "a.md", content: "2" }));
    expect(await db.smembers(`files:${u.email}`)).toEqual(["a.md"]);
    expect((await listFiles(u.email)).map((f) => f.content)).toEqual(["2"]);
  });
});

describe("a disconnected platform leaves the index with its credentials", () => {
  it("deletes the encrypted record and removes the provider from the set", async () => {
    const u = await newUser("conn");
    await saveConnection(u.email, { provider: "telegram", data: { botToken: "secret" }, connectedAt: new Date().toISOString() });
    await deleteConnection(u.email, "telegram");
    expect(await db.get(`conn:${u.email}:telegram`)).toBeNull();
    expect(await db.smembers(`conns:${u.email}`)).toEqual([]);
    expect(await listConnections(u.email)).toEqual([]);
  });
});

describe("the brand file is not writable field by field from a tool call", () => {
  it("refuses a field that is not on the allowlist and leaves the brand untouched", async () => {
    const u = await newUser("brandtool");
    await saveBrand(u.email, brand());
    // The owner, resolved the way a request is: update_brand is refused to a user with no actor (tests/role-gates.test.ts).
    await signIn(u.email);
    const me = (await currentUser())!;
    const actions: string[] = [];
    // Crawled pages, catalogs and uploads reach this agent, so the model naming a field is not permission to write it.
    for (const field of ["channels", "languages", "social", "updatedAt", "__proto__"]) {
      expect(await runTool(me, "update_brand", { field, value: "instagram" }, actions)).toMatch(/Cannot change brand/);
    }
    const after = (await getBrand(u.email))!;
    expect(Array.isArray(after.channels)).toBe(true);
    expect(after.channels).toEqual(["instagram", "whatsapp"]);
    expect(Array.isArray(after.languages)).toBe(true);
  });
  it("still proposes the fields the tool is meant for, and saves nothing until the owner's Save (rule 568)", async () => {
    const u = await newUser("brandtool");
    await saveBrand(u.email, brand());
    await signIn(u.email);
    const actions: string[] = [];
    expect(await runTool((await currentUser())!, "update_brand", { field: "tone", value: "رسمي" }, actions)).toMatch(/Not saved yet: brand\.tone/);
    expect(actions).toEqual(["brandprop:tone"]);
    expect((await getBrand(u.email))!.tone).toBe(brand().tone);
    expect(EDITABLE_BRAND_FIELDS).toContain("tone");
    expect(EDITABLE_BRAND_FIELDS).not.toContain("channels");
  });
});

describe("public write endpoints are throttled", () => {
  it("waitlist, support and affiliate applications all stop accepting from one address", async () => {
    const post = (mod: { POST: (r: Request) => Promise<Response> }, path: string, payload: Record<string, string>, addr: string) =>
      mod.POST(json(path, "POST", payload, ip(addr)));
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(waitlistRoute, "/api/waitlist", { email: `a${i}@test.example` }, "9.9.9.1")).status);
    expect(codes.filter((c) => c === 429)).toHaveLength(1);

    const support: number[] = [];
    for (let i = 0; i < 11; i++) support.push((await post(supportRoute, "/api/support", { email: "a@test.example", message: "hi" }, "9.9.9.2")).status);
    // Every accepted ticket emails the founder, so the eleventh in an hour is refused.
    expect(support.filter((c) => c === 429)).toHaveLength(1);

    const aff: number[] = [];
    for (let i = 0; i < 11; i++) aff.push((await post(affiliatesRoute, "/api/affiliates", { email: "a@test.example", name: "A", consent: "on" }, "9.9.9.3")).status);
    expect(aff.filter((c) => c === 429)).toHaveLength(1);
  });
});

describe("chat is bounded per account", () => {
  it("stops a single account after the hourly ceiling and answers 429", async () => {
    const u = await newUser("chatcap");
    await signIn(u.email);
    // The account's own ceiling, by plan (rule 331, tests/chat-trial.test.ts).
    for (let i = 0; i < chatCaps(u).hour; i++) expect(await chatRefusal(u)).toBeNull();
    expect(await chatRefusal(u)).toBe("hour");
    // A burst is refused before the month's chat allowance is touched (src/lib/chat-allowance.ts).
    expect((await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا" }))).status).toBe(429);
  });
});

describe("the Shopify callback only ever talks to a Shopify host", () => {
  it("refuses a shop that is not a myshopify.com domain instead of posting the client secret to it", async () => {
    const u = await newUser("shop");
    const exchange = vi.fn();
    vi.doMock("@/lib/connectors/oauth", () => ({ exchangeCode: exchange, REDIRECT: (id: string) => `https://nashr.test/api/connect/${id}/callback` }));
    await saveState("st-evil", { email: u.email, provider: "shopify", lang: "ar", shop: "evil.example", verifier: "" });
    // Get past the session binding and the signature, so the host check is what refuses it.
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "st-evil");
    const before = process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_CLIENT_SECRET = "test-secret";
    const q = new URLSearchParams({ code: "c", shop: "evil.example", state: "st-evil" });
    q.set("hmac", createHmac("sha256", "test-secret").update([...q.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&")).digest("hex"));
    const res = await callbackRoute.GET(new Request(`https://nashr.test/api/connect/shopify/callback?${q}`), params({ provider: "shopify" }));
    if (before === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = before;
    expect(res.headers.get("location")).toContain("error=bad_shop");
    expect(exchange).not.toHaveBeenCalled();
    expect(await listConnections(u.email)).toEqual([]);
  });
});

describe("the admin cookie is a server-side key session, never the key itself (rule 424)", () => {
  it("refuses the raw key and a prefix of a session id, and accepts only a live session", async () => {
    const prev = process.env.WAITLIST_ADMIN_KEY;
    process.env.WAITLIST_ADMIN_KEY = "s3cret-admin-key";
    try {
      const { adminSignIn, jar } = await import("./helpers/session");
      jar().clear();
      // The cookie a browser kept from before the key session existed: the raw key no longer opens anything.
      jar().set("nashr_admin", "s3cret-admin-key");
      expect(await isAdminCookie()).toBe(false);
      const id = await adminSignIn();
      jar().set("nashr_admin", id.slice(0, -1));
      expect(await isAdminCookie()).toBe(false);
      jar().set("nashr_admin", id);
      expect(await isAdminCookie()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WAITLIST_ADMIN_KEY; else process.env.WAITLIST_ADMIN_KEY = prev;
    }
  });
});

/**
 * Every spending path checks the trial before it charges — except the two that generate images, which never got the
 * check. An ended trial went on paying for fal.ai and Anthropic calls with no ceiling but the credit balance.
 */
describe("an ended trial cannot buy an image", () => {
  const expired = async () => {
    const u = await newUser("trial");
    const { saveUser } = await import("@/lib/auth");
    await saveUser({ ...u, plan: "trial", trialEnds: new Date(Date.now() - 864e5).toISOString() });
    await signIn(u.email);
    return u;
  };

  it("the image route refuses with the same 402 as every other spending route", async () => {
    const u = await expired();
    const { saveTask, getBrand: gb } = await import("@/lib/brand");
    void gb;
    await saveBrand(u.email, brand());
    await saveTask(u.email, { id: "img1", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" });

    const imageRoute = await import("@/app/api/tasks/[id]/image/route");
    const res = await imageRoute.POST(json("/api/tasks/img1/image", "POST"), params({ id: "img1" }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("trial_over");

    const { getUser } = await import("@/lib/auth");
    expect((await getUser(u.email))!.credits, "a refused request must not have charged").toBe(50);
  });

  it("the video route refuses with the same 402, before the model, the plan or the provider are looked at", async () => {
    const u = await expired();
    await saveBrand(u.email, brand());
    const { saveTask } = await import("@/lib/brand");
    await saveTask(u.email, { id: "vid1", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" });

    const videoRoute = await import("@/app/api/tasks/[id]/video/route");
    // A model the route would otherwise answer plan_required or bad_model for: the trial check is the first line.
    for (const model of ["vid-quick", "vid-premium", "not-a-model", undefined]) {
      const res = await videoRoute.POST(json("/api/tasks/vid1/video", "POST", { model }), params({ id: "vid1" }));
      expect(res.status, String(model)).toBe(402);
      expect((await res.json()).error, String(model)).toBe("trial_over");
    }

    const { getUser } = await import("@/lib/auth");
    expect((await getUser(u.email))!.credits, "a refused request must not have charged").toBe(50);
  });

  it("the chat's generate_image tool refuses too, and says why", async () => {
    const u = await expired();
    await saveBrand(u.email, brand());
    const { saveTask } = await import("@/lib/brand");
    await saveTask(u.email, { id: "img2", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" });

    const { getUser } = await import("@/lib/auth");
    const fresh = (await getUser(u.email))!;
    const actions: string[] = [];
    const out = await runTool(fresh, "generate_image", { task_id: "img2" }, actions);
    expect(out).toMatch(/Trial ended/);
    expect(actions).toContain("limit:trial");
    expect((await getUser(u.email))!.credits).toBe(50);
  });
});

/**
 * Credits are charged against the ACCOUNT, but the profile read usage from the active brand's scope alone and then
 * rendered it directly beside the account balance. On an agency plan the page contradicted itself, and the figure
 * moved when the owner switched brand while the balance stayed put.
 */
describe("profile usage covers every brand the account owns", () => {
  it("sums all scopes, so used and remaining describe the same money", async () => {
    const u = await newUser("agency");
    const { saveUser } = await import("@/lib/auth");
    await saveUser({ ...u, plan: "agency" });
    const fresh = (await import("@/lib/auth")).getUser;
    const acct = (await fresh(u.email))!;

    const { addBrand, scopeFor } = await import("@/lib/brands");
    const second = await addBrand(acct, "Second");
    expect("id" in second, "the agency plan must allow a second brand").toBe(true);
    const secondScope = scopeFor(u.email, (second as { id: string }).id);

    const { saveTask } = await import("@/lib/brand");
    const task = (id: string) => ({ id, type: "social" as const, channel: "instagram", title: "t", body: "b", status: "approved" as const, createdAt: new Date().toISOString(), lang: "ar" as const });
    await saveTask(u.email, task("d1"), true);
    await saveTask(secondScope, task("s1"), true);
    await saveTask(secondScope, task("s2"), true);

    await signIn(u.email);
    const profileRoute = await import("@/app/api/profile/route");
    const body = (await (await profileRoute.GET()).json()) as { usage: Record<string, { count: number }> };
    expect(body.usage.social.count, "one task in the default brand and two in the second").toBe(3);
  });
});

/**
 * PUT /api/files was the one write with no rate limit and no ceiling. `listFiles` reads every file in the index on
 * the Files page and on several routes, so an index grown without bound stops the page answering at all — and
 * nothing could bring the count down except deleting entries one by one.
 */
describe("the workspace file index is bounded", () => {
  it("refuses a new file past the ceiling but still allows edits to existing ones", async () => {
    const { MAX_FILES, FileLimitError, writeFile: wf } = await import("@/lib/files");
    const who = "capped@test.example";
    for (let i = 0; i < MAX_FILES; i++) await wf(who, `f${i}.md`, "x", "user");

    await expect(wf(who, "one-too-many.md", "x", "user")).rejects.toBeInstanceOf(FileLimitError);
    // An existing file is still editable: a full workspace must be tidyable, not frozen.
    const edited = await wf(who, "f0.md", "updated", "user");
    expect(edited.content).toBe("updated");
  });

  it("the route answers 409 rather than throwing, and throttles repeated writes", async () => {
    const u = await newUser("filecap");
    await signIn(u.email);
    const put = (name: string) => filesRoute.PUT(json("/api/files", "PUT", { name, content: "hello" }));

    expect((await put("first.md")).status).toBe(200);

    // 60 writes an hour per scope; the 61st is refused.
    for (let i = 1; i < 60; i++) await put(`f${i}.md`);
    const throttled = await put("too-fast.md");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("3600");
    expect((await throttled.json()).error).toBe("slow_down");
  });

  it("rejects an oversized body before parsing it", async () => {
    const u = await newUser("filebig");
    await signIn(u.email);
    const req = new Request("https://nashr.test/api/files", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "5000000" },
      body: JSON.stringify({ name: "big.md", content: "x" }),
    });
    const res = await filesRoute.PUT(req);
    expect(res.status).toBe(413);
  });
});

/**
 * When no image service is configured, the default image model gives a placehold.co card with the brand name on it.
 * The task never recorded which service produced the image, so the Inbox showed that card exactly as it shows real
 * artwork — the owner paid a credit and was told nothing.
 */
describe("a placeholder image is recorded as one", () => {
  it("the route stores the provider alongside the url", async () => {
    const u = await newUser("img");
    await signIn(u.email);
    await saveBrand(u.email, brand());
    const { saveTask, getTask } = await import("@/lib/brand");
    await saveTask(u.email, { id: "ph1", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" }, true);

    // No media service configured at all is exactly the case that yields a placeholder, and it never reaches the network.
    mediaEnv({});
    const imageRoute = await import("@/app/api/tasks/[id]/image/route");
    const net = noNetwork();
    const res = await imageRoute.POST(json("/api/tasks/ph1/image", "POST"), params({ id: "ph1" })).finally(net.restore);
    expect(res.status).toBe(200);
    expect((await res.json()).provider).toBe("placeholder");
    expect(net.hosts).toEqual([]);

    const saved = (await getTask(u.email, "ph1"))!;
    expect(saved.imageUrl).toContain("placehold.co");
    expect(saved.imageProvider, "the card must be readable as a placeholder after a reload, not only in the response").toBe("placeholder");
  });
});

/**
 * The daily cron reads every brand's task history to decide whether to send a lifecycle email. On most days nothing
 * is due, so the read bought nothing — and doing it for every brand is what exhausted the 30-hop chain at roughly
 * 2,232 brands, leaving every account past that point with no lifecycle mail at all.
 */
describe("the daily lifecycle read", () => {
  it("does not touch the workspace on a day when no message is due", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const u = await newUser("life");
    const { saveUser, getUser } = await import("@/lib/auth");
    // Five days in, paying: nothing in the plan is due.
    await saveUser({ ...u, plan: "pro", createdAt: new Date(Date.now() - 5 * 864e5).toISOString() });
    const fresh = (await getUser(u.email))!;

    const { runLifecycle } = await import("@/lib/lifecycle");
    const spy = vi.spyOn(db, "get");
    const sentKeys = await runLifecycle(fresh);
    const reads = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(sentKeys).toEqual([]);
    expect(reads.filter((k) => k.startsWith("tidxv:") || k.startsWith("brand:")), "nothing was due, so nothing needed reading").toEqual([]);
  });

  it("stops being due at all once the windows have passed", async () => {
    const { lifecyclePlan } = await import("@/lib/lifecycle");
    const long = { createdAt: new Date(Date.now() - 400 * 864e5).toISOString(), trialEnds: new Date(Date.now() - 397 * 864e5).toISOString(), plan: "trial" as const };
    expect(lifecyclePlan(long).some(([, due]) => due), "a year-old trial must not still be owed its day-one mail").toBe(false);

    // The windows themselves still fire, and still have the slack a missed cron run needs.
    const day = (n: number) => ({ createdAt: new Date(Date.now() - n * 864e5).toISOString(), trialEnds: new Date(Date.now() + 1 * 864e5).toISOString(), plan: "trial" as const });
    expect(lifecyclePlan(day(1)).find(([k]) => k === "day1")![1]).toBe(true);
    expect(lifecyclePlan(day(3)).find(([k]) => k === "day1")![1], "three days of slack for a missed run").toBe(true);
    expect(lifecyclePlan(day(4)).find(([k]) => k === "day1")![1]).toBe(false);
  });
});

/**
 * OAuth 2.1 §4.1.3: every redirect URI is https, with one exception for a native client on the loopback interface.
 * Registration accepted /^https?:\/\// — any plaintext host at all — so a client could register a redirect on a host
 * it controlled and be handed an authorization code for someone's account over the open network.
 */
describe("OAuth client registration refuses a plaintext redirect", () => {
  it("takes https anywhere and http only on loopback", async () => {
    const { validRedirectUri } = await import("@/lib/oauth");
    expect(validRedirectUri("https://claude.example/cb")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
    expect(validRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(validRedirectUri("http://localhost:3000/cb")).toBe(true);

    expect(validRedirectUri("http://evil.example/cb"), "the whole point").toBe(false);
    expect(validRedirectUri("http://127.0.0.1.evil.example/cb"), "a host that merely starts with the loopback IP").toBe(false);
    expect(validRedirectUri("http://localhost.evil.example/cb")).toBe(false);
    expect(validRedirectUri("https://claude.example/cb#frag"), "RFC 6749 §3.1.2 forbids a fragment").toBe(false);
    expect(validRedirectUri("not-a-url")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validRedirectUri(undefined)).toBe(false);
  });

  it("registerClient drops the bad ones and refuses when none survive", async () => {
    const { registerClient } = await import("@/lib/oauth");
    const c = await registerClient({ redirect_uris: ["http://evil.example/cb", "https://good.example/cb"], client_name: "Mixed" });
    expect(c.redirect_uris, "the plaintext host must not be registered alongside the good one").toEqual(["https://good.example/cb"]);
    await expect(registerClient({ redirect_uris: ["http://evil.example/cb"], client_name: "Bad" })).rejects.toThrow(/invalid_redirect_uri/);
  });
});

/**
 * When no image service is configured the owner gets a placehold.co card instead of artwork. Charging a credit for
 * that bills the customer for our outage, so the card is not charged at all (it was charged and refunded before).
 */
describe("a placeholder image is not charged", () => {
  it("the route charges nothing and reports the unchanged balance", async () => {
    const u = await newUser("refund");
    await signIn(u.email);
    await saveBrand(u.email, brand());
    const { saveTask } = await import("@/lib/brand");
    await saveTask(u.email, { id: "ph2", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" }, true);

    mediaEnv({});
    const imageRoute = await import("@/app/api/tasks/[id]/image/route");
    const net = noNetwork();
    const res = await imageRoute.POST(json("/api/tasks/ph2/image", "POST"), params({ id: "ph2" })).finally(net.restore);
    const body = (await res.json()) as { provider: string; credits: number };
    expect(net.hosts).toEqual([]);

    expect(body.provider).toBe("placeholder");
    expect(body.credits, "the response must report the balance, which nothing charged").toBe(50);
    const { getUser } = await import("@/lib/auth");
    expect((await getUser(u.email))!.credits, "no credit may be kept for an outage").toBe(50);
  });
});

/**
 * `Secure` describes the transport, not the build. It was `NODE_ENV === "production"`, so a production build served
 * over plain http marked the cookie Secure, every conforming client discarded it, and nobody could log in — silently,
 * because the next request simply arrives with no cookie. WebKit does exactly that on http://localhost, which is how
 * 40 signed-in route tests failed on CI while passing on Chromium.
 */
describe("the session cookie's Secure flag follows the connection", () => {
  const opts = async (h: Record<string, string>) => {
    const { withHeaders } = await import("./helpers/session");
    const { sessionCookie } = await import("@/lib/auth");
    return withHeaders(h, () => sessionCookie(60));
  };

  it("is dropped only for plain http on the loopback interface", async () => {
    expect((await opts({ host: "localhost:3000" })).secure, "the local harness").toBe(false);
    expect((await opts({ host: "127.0.0.1:3000" })).secure).toBe(false);
    expect((await opts({ host: "[::1]:3000" })).secure).toBe(false);
  });

  it("is kept for https, and for any real host even over http", async () => {
    expect((await opts({ host: "localhost:3000", "x-forwarded-proto": "https" })).secure).toBe(true);
    expect((await opts({ host: "nashr.example.com", "x-forwarded-proto": "https" })).secure, "production").toBe(true);
    // A real host over plain http keeps the flag and therefore stops working. That is the right way for that
    // deployment mistake to fail: loudly, and never by quietly dropping the flag on live traffic.
    expect((await opts({ host: "nashr.example.com" })).secure).toBe(true);
    expect((await opts({ host: "localhost.evil.example" })).secure, "a host that merely starts with localhost").toBe(true);
  });

  it("is never anything but httpOnly and lax", async () => {
    const o = await opts({ host: "localhost:3000" });
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
  });
});

/**
 * Registration is where the https rule is applied, but a client registered before that rule existed still carries
 * whatever it asked for, and the stored list is the only thing the approval step used to check. The code is about to
 * be sent somewhere, so the rule is applied again at that moment.
 */
describe("a legacy client cannot still receive a code over plaintext", () => {
  it("approval refuses a stored http redirect", async () => {
    const { registerClient } = await import("@/lib/oauth");
    const client = await registerClient({ redirect_uris: ["https://good.example/cb"], client_name: "Legacy" });

    // Exactly what a client registered before the rule looks like on disk: a plaintext URI in its stored list.
    client.redirect_uris.push("http://evil.example/cb");
    await db.set(`oauthclient:${client.client_id}`, client);

    const u = await newUser("legacy");
    await signIn(u.email);
    const approve = await import("@/app/api/oauth/approve/route");
    const form = (uri: string) =>
      new Request("https://nashr.test/api/oauth/approve", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.client_id, redirect_uri: uri, decision: "allow", code_challenge: "c".repeat(43), code_challenge_method: "S256", scope: "noor" }).toString(),
      });

    const refused = await approve.POST(form("http://evil.example/cb"));
    expect(refused.status, "the stored list says yes; the rule says no, and the rule wins").toBe(400);

    // The good URI on the same client still works, so this refuses the URI and not the client. Success is the 303
    // back to the client with the code on it.
    const allowed = await approve.POST(form("https://good.example/cb"));
    expect(allowed.status).toBe(303);
    expect(new URL(allowed.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });
});

/**
 * Resend's `emails.send` RESOLVES with { data, error }; it does not throw when the API refuses the message. The old
 * code awaited it and returned true regardless, so a refused email was reported as sent — password resets, trial
 * mail and weekly plans went nowhere while every screen said they had been sent.
 */
describe("a refused email is reported as refused", () => {
  const load = async () => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    return import("@/lib/notify");
  };

  it("returns false when Resend answers with an error, and records it for the operator", async () => {
    vi.doMock("resend", () => ({
      Resend: class { emails = { send: async () => ({ data: null, error: { name: "validation_error", message: "You can only send testing emails to your own email address" }, headers: null }) }; },
    }));
    const { sendEmail } = await load();
    expect(await sendEmail("someone@example.com", "s", "t"), "a refused message is not a sent message").toBe(false);

    const rows = await db.lrange("admin:log", 0, 9);
    const entry = rows.map((r) => JSON.parse(r) as { what?: string; after?: { reason?: string } }).find((r) => r.what === "mail:refused");
    expect(entry, "the founder console must be able to see that mail is being refused").toBeTruthy();
    expect(entry!.after!.reason).toMatch(/your own email address/);
    expect(JSON.stringify(rows), "the recipient must not be logged: this would become a list of who asked for a reset").not.toContain("someone@example.com");
    vi.doUnmock("resend");
  });

  it("returns true only when Resend accepts it", async () => {
    vi.doMock("resend", () => ({
      Resend: class { emails = { send: async () => ({ data: { id: "re_1" }, error: null, headers: null }) }; },
    }));
    const { sendEmail } = await load();
    expect(await sendEmail("someone@example.com", "s", "t")).toBe(true);
    vi.doUnmock("resend");
  });

  it("a transport failure is still false", async () => {
    vi.doMock("resend", () => ({
      Resend: class { emails = { send: async () => { throw new Error("socket hang up"); } }; },
    }));
    const { sendEmail } = await load();
    expect(await sendEmail("someone@example.com", "s", "t")).toBe(false);
    vi.doUnmock("resend");
  });

  it("a send with no answer within EMAIL_TIMEOUT_MS is false, and never holds its caller longer", async () => {
    vi.doMock("resend", () => ({
      Resend: class { emails = { send: () => new Promise(() => {}) }; },
    }));
    const { sendEmail, EMAIL_TIMEOUT_MS } = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done: boolean | undefined;
      void sendEmail("someone@example.com", "s", "t").then((v) => { done = v; });
      for (let i = 0; i < 200 && done === undefined; i++) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(EMAIL_TIMEOUT_MS / 10);
      }
      expect(done).toBe(false);
      const rows = await db.lrange("admin:log", 0, 9);
      expect(rows.some((r) => r.includes(`no answer within ${EMAIL_TIMEOUT_MS / 1000} s`))).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.doUnmock("resend");
    }
  });
});
