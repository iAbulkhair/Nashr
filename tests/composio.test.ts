import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { bucketFor, errorShape, TOOLKIT_VERSION, composioEnabled, composioRead, composioUserId, composioWrite, setComposioClientForTests, type ComposioClient } from "@/lib/connectors/composio";
import { liEscape } from "@/lib/connectors/via-composio";
import { TOOLKITS } from "@/lib/connectors/composio-catalog";
import { connectedTargets, targetsFor } from "@/lib/connectors/targets";
import { publishTask } from "@/lib/connectors/publish";
import { getProvider, isAvailable } from "@/lib/connectors/registry";
import { ReconnectRequired } from "@/lib/connectors/fresh";
import { mayHavePosted } from "@/lib/publish-once";
import { wipeAccount } from "@/lib/account";
import type { Task } from "@/lib/brand";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rules 645-652: publishing through Composio (src/lib/connectors/composio.ts, via-composio.ts). Composio's client is
 * replaced by a fake that records every call; the platforms' answers are given in the shapes Composio's tool schemas
 * describe, and `pick` reads them however deep they sit.
 */
type Exec = { slug: string; userId: string; accountId: string; args: Record<string, unknown> };
type Answer = { data?: unknown; error?: string | null; successful: boolean } | (() => never);
let calls: { exec: Exec[]; link: { userId: string; auth: string; callbackUrl: string; allowMultiple?: boolean }[]; revoked: string[]; deleted: string[] };
let answers: Record<string, Answer>;
let owned: Record<string, string[]>;
let status = "ACTIVE";
let redirect = "https://connect.composio.dev/link/lk_1";
let revokeFails: string | null = null;

function fake(): ComposioClient {
  return {
    connectedAccounts: {
      link: async (userId, auth, o) => { calls.link.push({ userId, auth, callbackUrl: o.callbackUrl, allowMultiple: o.allowMultiple }); return { id: "ca_new", redirectUrl: redirect }; },
      waitForConnection: async (id) => ({ id, status }),
      list: async (q) => ({ items: (owned[q.userIds[0]] ?? []).map((id) => ({ id })) }),
      revoke: async (id) => { if (revokeFails) throw new Error(revokeFails); calls.revoked.push(id); },
      delete: async (id) => { calls.deleted.push(id); },
    },
    tools: {
      execute: async (slug, body) => {
        calls.exec.push({ slug, userId: body.userId, accountId: body.connectedAccountId, args: body.arguments });
        const a = answers[slug];
        if (typeof a === "function") return a();
        return a ?? { successful: false, error: "not mocked" };
      },
    },
    files: { upload: async () => ({}) },
  };
}

beforeEach(() => {
  calls = { exec: [], link: [], revoked: [], deleted: [] };
  answers = {};
  owned = {};
  status = "ACTIVE";
  redirect = "https://connect.composio.dev/link/lk_1";
  revokeFails = null;
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "meta,x,linkedin,tiktok");
  for (const t of ["FACEBOOK", "INSTAGRAM", "TWITTER", "LINKEDIN", "TIKTOK"]) vi.stubEnv(`COMPOSIO_AUTH_${t}`, `ac_${t.toLowerCase()}`);
  setComposioClientForTests(fake());
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); });

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const via = (provider: string, data: Record<string, string>, meta: Record<string, string> = {}): Connection => ({ provider, data, meta: { via: "composio", ...meta }, connectedAt: new Date().toISOString() });
const IMG = `https://s1.public.blob.vercel-storage.com/media/${"a1".repeat(16)}.jpg`;
const post = (over: Partial<Task> = {}): Task => ({ id: `t${Math.random().toString(16).slice(2, 10)}`, type: "social", channel: "instagram", title: "t", body: "## عود ملكي\n**جديد** في المتجر (اليوم)", status: "approved", createdAt: new Date().toISOString(), lang: "ar", imageUrl: IMG, imageProvider: "kie", ...over });
const ok = (data: unknown) => ({ successful: true, data });
/** The error a call that must fail threw. */
const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);

describe("who Composio sees (rule 645)", () => {
  it("knows a workspace by an opaque id derived from its scope, never the email, the same on every call", async () => {
    const a = composioUserId("owner@shop.sa"), b = composioUserId("owner@shop.sa#b2"), again = composioUserId("owner@shop.sa");
    expect(a).toHaveLength(32);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/owner|shop/);
    expect(bucketFor("owner@shop.sa")).not.toMatch(/owner|shop/);
    answers.TWITTER_USER_LOOKUP_ME = ok({ data: { username: "ward" } });
    await composioRead("owner@shop.sa", "twitter", "TWITTER_USER_LOOKUP_ME", {}, "ca_x");
    expect(calls.exec[0]).toMatchObject({ userId: a, accountId: "ca_x" });
  });
});

describe("what may be called (rule 646)", () => {
  it("runs only listed tools with listed argument names, and a read tool is not a write", async () => {
    await expect(composioWrite("s", "facebook", "FACEBOOK_DELETE_POST", {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
    await expect(composioWrite("s", "facebook", "FACEBOOK_LIST_MANAGED_PAGES", {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
    await expect(composioWrite("s", "twitter", "TWITTER_CREATION_OF_A_POST", { text: "hi", poll_options: ["a", "b"] }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    await expect(composioRead("s", "facebook", "toString", {}, "ca")).rejects.toThrow("composio_tool_not_allowed");
    expect(calls.exec).toEqual([]);
  });

  it("is off unless the key is set and COMPOSIO_PROVIDERS names the provider; LinkedIn and TikTok have no direct path", () => {
    expect(composioEnabled("meta")).toBe(true);
    vi.stubEnv("COMPOSIO_PROVIDERS", "x");
    expect(composioEnabled("meta")).toBe(false);
    expect(isAvailable(getProvider("linkedin")!)).toBe(false);
    vi.stubEnv("LINKEDIN_CLIENT_ID", "id");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "secret");
    expect(isAvailable(getProvider("linkedin")!), "a direct LinkedIn app has no publishing code behind it").toBe(false);
    vi.stubEnv("COMPOSIO_PROVIDERS", "linkedin");
    expect(isAvailable(getProvider("linkedin")!)).toBe(true);
    vi.stubEnv("COMPOSIO_AUTH_LINKEDIN", "");
    expect(isAvailable(getProvider("linkedin")!), "no auth config, no Connect button").toBe(false);
    vi.stubEnv("COMPOSIO_API_KEY", "");
    expect(composioEnabled("linkedin")).toBe(false);
  });
});

describe("what a failure says (rule 647)", () => {
  it("shapes errors like the direct connectors, so a refused token reconnects and an unknown result is held", async () => {
    answers.FACEBOOK_CREATE_POST = { successful: false, error: "Error validating access token: Session has expired" };
    const e1 = await failure(composioWrite("s", "facebook", "FACEBOOK_CREATE_POST", { page_id: "1", message: "m" }, "ca"));
    expect(e1.message).toMatch(/^meta create_post 401: /);
    expect(mayHavePosted(e1)).toBe(false);
    answers.TWITTER_CREATION_OF_A_POST = { successful: false, error: "Internal error (500) upstream" };
    const e2 = await failure(composioWrite("s", "twitter", "TWITTER_CREATION_OF_A_POST", { text: "m" }, "ca"));
    expect(e2.message).toMatch(/^x 502: creation_of_a_post /);
    expect(mayHavePosted(e2), "the number in the platform's text is not the status").toBe(true);
    answers.TWITTER_CREATION_OF_A_POST = () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
    const e3 = await failure(composioWrite("s", "twitter", "TWITTER_CREATION_OF_A_POST", { text: "m" }, "ca"));
    expect(e3.name).toBe("TimeoutError");
    expect(mayHavePosted(e3)).toBe(true);
    for (const m of ["composio_unavailable", "composio_rate_limited", "instagram_limit_reached", "tiktok_needs_image", "linkedin_no_author", "meta media 400: image_rejected"]) expect(mayHavePosted(new Error(m)), m).toBe(false);
  });

  it("asks the owner to reconnect when the platform refused the token", async () => {
    const u = await newUser("cpre");
    await saveConnection(u.email, via("x", { twitter: "ca_x" }, { account: "@ward" }));
    answers.TWITTER_CREATION_OF_A_POST = { successful: false, error: "Unauthorized: token revoked" };
    await expect(publishTask(u.email, post({ channel: "x" }), "x")).rejects.toBeInstanceOf(ReconnectRequired);
    expect((await getConnection(u.email, "x"))!.needsReconnect).toBeTruthy();
  });

  it("caps calls per workspace per hour", async () => {
    await db.set(`rate:${bucketFor("busy@test.example")}`, 600, 3600);
    await expect(composioRead("busy@test.example", "twitter", "TWITTER_USER_LOOKUP_ME", {}, "ca")).rejects.toThrow("composio_rate_limited");
    expect(calls.exec).toEqual([]);
  });
});

describe("connecting (rule 648)", () => {
  it("sends the browser only to Composio, with the account id kept server-side and one listed toolkit", async () => {
    const u = await newUser("cpstart");
    await signIn(u.email);
    const res = await start.GET(new Request("https://app.test/api/connect/meta/start?lang=en&toolkit=facebook"), ctx("meta"));
    expect(res.headers.get("location")).toBe(redirect);
    expect(calls.link[0]).toMatchObject({ userId: composioUserId(u.email), auth: "ac_facebook", allowMultiple: true });
    const state = jar().get(OAUTH_COOKIE)!;
    expect(calls.link[0].callbackUrl).toContain(`/api/connect/meta/callback?state=${state}`);
    expect(await db.get(`oauthstate:${state}`)).toMatchObject({ via: "composio", toolkit: "facebook", accountId: "ca_new", provider: "meta" });

    await start.GET(new Request("https://app.test/api/connect/meta/start?lang=en&toolkit=twitter"), ctx("meta"));
    expect(calls.link[1].auth, "a toolkit of another provider falls back to this provider's own").toBe("ac_instagram");

    redirect = "https://evil.example/phish";
    const bad = await start.GET(new Request("https://app.test/api/connect/x/start?lang=en"), ctx("x"));
    expect(new URL(bad.headers.get("location")!).pathname, "back to the page, not raw JSON").toBe("/en/app/integrations");
    expect(new URL(bad.headers.get("location")!).searchParams.get("error")).toBe("connect_failed");
    expect(calls.deleted).toEqual(["ca_new"]);
  });

  const finish = async (u: { email: string }, provider: string, toolkit: string, accountId: string, query = "") => {
    const s = `st-${Math.random().toString(16).slice(2)}`;
    await saveState(s, { email: u.email, provider, lang: "en", shop: "", verifier: "", via: "composio", toolkit, accountId });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, s);
    const res = await callback.GET(new Request(`https://app.test/api/connect/${provider}/callback?state=${s}${query}`), ctx(provider));
    return new URL(res.headers.get("location")!).searchParams;
  };

  it("stores only after the account is ACTIVE and this workspace's own; the callback's query never names the account", async () => {
    const u = await newUser("cpcb");
    answers.FACEBOOK_LIST_MANAGED_PAGES = ok({ data: [{ id: "111", name: "متجر الورد" }, { id: "222", name: "Ward Riyadh" }] });
    owned[composioUserId(u.email)] = ["ca_other"];
    expect((await finish(u, "meta", "facebook", "ca_fb")).get("error")).toBe("connect_failed");
    expect(calls.deleted).toContain("ca_fb");
    expect(await getConnection(u.email, "meta")).toBeNull();

    owned[composioUserId(u.email)] = ["ca_fb"];
    expect((await finish(u, "meta", "facebook", "ca_fb", "&connected_account_id=ca_evil")).get("connected")).toBe("meta");
    const c = (await getConnection(u.email, "meta"))!;
    expect(c.data).toEqual({ facebook: "ca_fb" });
    expect(c.meta).toMatchObject({ via: "composio", pageId: "111", account: "متجر الورد" });
    expect(calls.exec.find((e) => e.slug === "FACEBOOK_LIST_MANAGED_PAGES")!.args.fields, "never asks for Page tokens").toBe("id,name");

    owned[composioUserId(u.email)] = ["ca_fb", "ca_ig"];
    answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "ward.sa" } });
    await finish(u, "meta", "instagram", "ca_ig");
    const both = (await getConnection(u.email, "meta"))!;
    expect(both.data).toEqual({ facebook: "ca_fb", instagram: "ca_ig" });
    expect(both.meta).toMatchObject({ igId: "1784", account: "متجر الورد · @ward.sa" });
    expect(connectedTargets([{ provider: "meta", meta: both.meta }])).toEqual(["meta", "facebook", "instagram"]);

    const bad = await connectRoute.POST(json("/api/connect/meta", "POST", { action: "select_page", pageId: "999" }), ctx("meta"));
    expect(bad.status).toBe(400);
    const sel = await connectRoute.POST(json("/api/connect/meta", "POST", { action: "select_page", pageId: "222" }), ctx("meta"));
    expect((await sel.json()).account).toBe("Ward Riyadh · @ward.sa");
  });

  it("refuses a toolkit the provider does not list, and revokes the old account when one is reconnected", async () => {
    const u = await newUser("cptk");
    expect((await finish(u, "x", "facebook", "ca_1")).get("error")).toBe("invalid_state");
    owned[composioUserId(u.email)] = ["ca_x2"];
    answers.TWITTER_USER_LOOKUP_ME = ok({ data: { username: "ward" } });
    await saveConnection(u.email, via("x", { twitter: "ca_x1" }));
    await finish(u, "x", "twitter", "ca_x2");
    expect((await getConnection(u.email, "x"))!).toMatchObject({ data: { twitter: "ca_x2" }, meta: { account: "@ward" } });
    expect(calls.revoked).toEqual(["ca_x1"]);
  });

  it("deletes the new Composio account when the callback cannot store it, so a retry is not blocked", async () => {
    const u = await newUser("cpdisc");
    owned[composioUserId(u.email)] = ["ca_li"];
    answers.LINKEDIN_GET_MY_INFO = { successful: false, error: "profile unavailable" };
    expect((await finish(u, "linkedin", "linkedin", "ca_li")).get("error")).toBe("connect_failed");
    expect(calls.deleted).toEqual(["ca_li"]);
    expect(await getConnection(u.email, "linkedin")).toBeNull();
  });

  it("pins a dated version for every toolkit, since the SDK will not execute a tool on \"latest\"", () => {
    expect(Object.keys(TOOLKIT_VERSION).sort()).toEqual(Object.keys(TOOLKITS).sort());
    for (const [t, v] of Object.entries(TOOLKIT_VERSION)) expect(v, t).toMatch(/^\d{8}_\d{2}$/);
  });

  it("keeps LinkedIn's author from the profile", async () => {
    const u = await newUser("cpli");
    owned[composioUserId(u.email)] = ["ca_li"];
    answers.LINKEDIN_GET_MY_INFO = ok({ response_dict: { sub: "abc123", name: "Abulkhair" } });
    await finish(u, "linkedin", "linkedin", "ca_li");
    expect((await getConnection(u.email, "linkedin"))!.meta).toMatchObject({ author: "urn:li:person:abc123", account: "Abulkhair" });
  });
});

describe("publishing (rule 649)", () => {
  it("posts to X, Facebook and LinkedIn with the stored account, plain text and the platform's own link", async () => {
    const u = await newUser("cppub");
    await saveConnection(u.email, via("x", { twitter: "ca_x" }));
    await saveConnection(u.email, via("meta", { facebook: "ca_fb" }, { pageId: "111" }));
    await saveConnection(u.email, via("linkedin", { linkedin: "ca_li" }, { author: "urn:li:person:abc" }));
    answers.TWITTER_CREATION_OF_A_POST = ok({ data: { id: "1799" } });
    answers.FACEBOOK_CREATE_PHOTO_POST = ok({ id: "photo-5", post_id: "111_222" });
    answers.LINKEDIN_CREATE_LINKED_IN_POST = ok({ id: "urn:li:share:77" });
    expect(await publishTask(u.email, post({ channel: "x" }), "x")).toMatchObject({ url: "https://x.com/i/status/1799", status: "published" });
    expect(await publishTask(u.email, post({ channel: "facebook" }), "facebook")).toMatchObject({ url: "https://www.facebook.com/111_222" });
    expect(calls.exec.find((e) => e.slug === "FACEBOOK_CREATE_PHOTO_POST")).toMatchObject({ accountId: "ca_fb", args: { page_id: "111", url: IMG, message: "عود ملكي\nجديد في المتجر (اليوم)", published: true } });
    expect(await publishTask(u.email, post({ channel: "linkedin" }), "linkedin")).toMatchObject({ url: "https://www.linkedin.com/feed/update/urn:li:share:77/" });
    expect(calls.exec.find((e) => e.slug === "LINKEDIN_CREATE_LINKED_IN_POST")!.args).toEqual({ author: "urn:li:person:abc", commentary: "عود ملكي\nجديد في المتجر \\(اليوم\\)", visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    expect(liEscape("a_b #c @d")).toBe("a\\_b \\#c \\@d");
  });

  it("reads a repeated X post as a duplicate, not a dead token", async () => {
    const u = await newUser("cpdup");
    await saveConnection(u.email, via("x", { twitter: "ca_x" }));
    answers.TWITTER_CREATION_OF_A_POST = { successful: false, error: "403 Forbidden: You are not allowed to create a Tweet with duplicate content." };
    await expect(publishTask(u.email, post({ channel: "x" }), "x")).rejects.toThrow("x_duplicate");
    expect((await getConnection(u.email, "x"))!.needsReconnect).toBeUndefined();
  });

  it("publishes to Instagram in two steps, stops at the daily limit, and calls a rejected image a refusal", async () => {
    const u = await newUser("cpig");
    await saveConnection(u.email, via("meta", { instagram: "ca_ig" }, { igId: "1784" }));
    answers.INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT = ok({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
    answers.INSTAGRAM_POST_IG_USER_MEDIA = ok({ id: "c-1" });
    answers.INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH = ok({ id: "m-9" });
    expect(await publishTask(u.email, post(), "instagram")).toMatchObject({ id: "m-9", status: "published" });
    expect(calls.exec.find((e) => e.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH")!.args).toEqual({ ig_user_id: "1784", creation_id: "c-1", max_wait_seconds: 20 });

    answers.INSTAGRAM_POST_IG_USER_MEDIA = { successful: false, error: "The image's aspect ratio is not supported" };
    const e = await failure(publishTask(u.email, post(), "instagram"));
    expect(e.message).toBe("meta media 400: image_rejected");
    expect(mayHavePosted(e)).toBe(false);

    answers.INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT = ok({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] });
    calls.exec = [];
    await expect(publishTask(u.email, post(), "instagram")).rejects.toThrow("instagram_limit_reached");
    expect(calls.exec.map((x) => x.slug)).toEqual(["INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT"]);
  });

  it("sends TikTok an image as a draft to the owner's inbox, and needs a generated image", async () => {
    const u = await newUser("cptt");
    await saveConnection(u.email, via("tiktok", { tiktok: "ca_tt" }));
    answers.TIKTOK_POST_PHOTO = ok({ data: { publish_id: "p_1" } });
    expect(await publishTask(u.email, post({ channel: "tiktok" }), "tiktok")).toMatchObject({ id: "p_1", status: "draft" });
    expect(calls.exec[0].args).toMatchObject({ photo_images: [IMG], photo_cover_index: 0, post_mode: "MEDIA_UPLOAD" });
    await expect(publishTask(u.email, post({ channel: "tiktok", imageUrl: undefined, imageProvider: undefined }), "tiktok")).rejects.toThrow("tiktok_needs_image");
  });

  it("never publishes to LinkedIn or TikTok through a direct record", async () => {
    const u = await newUser("cpdir");
    await saveConnection(u.email, { provider: "linkedin", data: { access_token: "t" }, meta: {}, connectedAt: new Date().toISOString() });
    await expect(publishTask(u.email, post({ channel: "linkedin" }), "linkedin")).rejects.toThrow("unsupported_provider");
    expect(calls.exec).toEqual([]);
  });
});

describe("where a post can go (rule 650)", () => {
  it("offers LinkedIn and TikTok only from a Composio record, TikTok only with artwork, and Instagram without a Page", () => {
    const conns = [via("linkedin", {}), via("tiktok", {}), via("meta", {}, { igId: "1784" })];
    const connected = connectedTargets(conns);
    expect(connected).toEqual(["linkedin", "tiktok", "meta", "instagram"]);
    expect(targetsFor(post({ channel: "linkedin" }), connected)).toEqual(["linkedin"]);
    expect(targetsFor(post({ channel: "tiktok" }), connected)).toEqual(["tiktok"]);
    expect(targetsFor(post({ channel: "tiktok", imageUrl: undefined, imageProvider: undefined }), connected)).toEqual([]);
    expect(targetsFor(post(), connected)).toEqual(["instagram"]);
    expect(connectedTargets([{ provider: "linkedin", meta: {} }, { provider: "tiktok" }])).toEqual([]);
  });
});

describe("disconnecting (rule 651)", () => {
  it("revokes at the platform before deleting, keeps a record it could not revoke, and treats a gone account as revoked", async () => {
    const u = await newUser("cpdel");
    await signIn(u.email);
    await saveConnection(u.email, via("meta", { facebook: "ca_fb", instagram: "ca_ig" }, { pageId: "1" }));
    revokeFails = "network down";
    const bad = await connectRoute.DELETE(new Request("https://app.test/api/connect/meta", { method: "DELETE" }), ctx("meta"));
    expect(bad.status).toBe(502);
    expect((await getConnection(u.email, "meta"))!.needsReconnect).toBe("revoke_failed");

    revokeFails = "Connected account not found";
    const gone = await connectRoute.DELETE(new Request("https://app.test/api/connect/meta", { method: "DELETE" }), ctx("meta"));
    expect(gone.status).toBe(200);
    expect(await getConnection(u.email, "meta")).toBeNull();

    revokeFails = null;
    await saveConnection(u.email, via("x", { twitter: "ca_x" }));
    await connectRoute.DELETE(new Request("https://app.test/api/connect/x", { method: "DELETE" }), ctx("x"));
    expect(calls.revoked).toEqual(["ca_x"]);
    expect(calls.deleted).toEqual(["ca_x"]);
    expect(await getConnection(u.email, "x")).toBeNull();
  });

  it("revokes every Composio account when the account is deleted", async () => {
    const u = await newUser("cpwipe");
    await saveConnection(u.email, via("x", { twitter: "ca_x" }));
    await saveConnection(u.email, via("meta", { facebook: "ca_fb" }));
    await saveConnection(u.email, { provider: "telegram", data: { botToken: "t", chatId: "@c" }, connectedAt: new Date().toISOString() });
    await wipeAccount(u.email);
    expect([...calls.revoked].sort()).toEqual(["ca_fb", "ca_x"]);
    expect(await getConnection(u.email, "x")).toBeNull();
  });
});

describe("who can reach Composio (rule 652)", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []; });
  it("only the connector layer, the connect routes and account deletion import it; no chat, MCP or agent code does", () => {
    const importers = files("src").filter((f) => /from "(?:\.\/|@\/lib\/connectors\/|\.\/connectors\/)(?:composio|via-composio)"/.test(readFileSync(f, "utf8"))).sort();
    expect(importers).toEqual([
      "src/app/api/connect/[provider]/callback/route.ts",
      "src/app/api/connect/[provider]/route.ts",
      "src/app/api/connect/[provider]/start/route.ts",
      "src/lib/account.ts",
      "src/lib/connectors/ads-via-composio.ts",
      "src/lib/connectors/publish.ts",
      "src/lib/connectors/registry.ts",
      "src/lib/connectors/via-composio.ts",
      "src/lib/site-stats.ts",
    ]);
    expect(readFileSync("src/lib/connectors/composio-catalog.ts", "utf8")).not.toMatch(/^import /m);
  });

  it("never logs a response body, an account id or a scope", () => {
    const src = readFileSync("src/lib/connectors/composio.ts", "utf8") + readFileSync("src/lib/connectors/via-composio.ts", "utf8");
    const logged = [...src.matchAll(/console\.\w+\(([^)]*)\)/g)].map((m) => m[1]);
    expect(logged.length).toBeGreaterThan(0);
    for (const args of logged) expect(args, "a log carries a fixed message, the tool slug and the status only").toMatch(/^"[^"]*"(?:, (?:slug|status))*$/);
    for (const args of logged) expect(args).not.toMatch(/accountId|scope|\bdata\b|\berr|\be\b/);
  });

  it("a failed connect logs the error's class, status and code, never its message or body", () => {
    class ApiError extends Error { status = 403; code = "Forbidden"; body = { user_id: "u-secret" }; }
    class LinkFailed extends Error {}
    const e = new LinkFailed("Failed for user u-secret in ac_123", { cause: new ApiError("u-secret has no access to ac_123") });
    expect(errorShape(e)).toBe("LinkFailed ApiError 403 Forbidden");
    expect(errorShape(new Error("ac_123 u-secret"))).toBe("Error");
    expect(errorShape("plain string")).toBe("error");
    expect(errorShape({ constructor: { name: "has space" }, status: "403", code: "not a code!" })).toBe("error");
  });
});
