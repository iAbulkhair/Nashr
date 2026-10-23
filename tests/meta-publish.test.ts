import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acct } from "@/lib/account-id";
import { jar, json, newUser, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { connectedTargets, targetsFor } from "@/lib/connectors/targets";
import { publishTask } from "@/lib/connectors/publish";
import { getProvider } from "@/lib/connectors/registry";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";

/**
 * Rule 75: Facebook Page and Instagram publishing. The connection keeps a long-lived token and the owner's Pages, with
 * the tokens encrypted and only names in the visible metadata; the Page is switched only to one Meta returned;
 * Instagram is offered only for a post with a generated image, from any media provider (a placeholder card, an image
 * with no recorded provider and a clip are not); posts go out with the Page token through Meta's container-then-publish
 * flow; and a revoked token asks for a reconnect. Graph is mocked in the shapes Meta documents.
 */
const ENV = { META_APP_ID: "mid", META_APP_SECRET: "msecret" };
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ENV)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const PAGES = [
  { id: "p1", name: "Ward Riyadh", access_token: "page-tok-1" },
  { id: "p2", name: "متجر الورد", access_token: "page-tok-2", instagram_business_account: { id: "ig2", username: "ward.sa" } },
];
const realFetch = globalThis.fetch;
type Call = { url: string; method: string; auth?: string; body: URLSearchParams };
let calls: Call[] = [];
function fakeGraph(opts: { pages?: unknown[]; revoked?: boolean } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, method: init?.method ?? "GET", auth, body });
    const u = new URL(url);
    if (u.host !== "graph.facebook.com") return new Response("not mocked", { status: 500 });
    if (opts.revoked) return Response.json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, { status: 400 });
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    if (path === "/oauth/access_token") return Response.json(body.get("grant_type") === "fb_exchange_token" ? { access_token: "long-user", token_type: "bearer", expires_in: 5183944 } : { access_token: "short-user", token_type: "bearer", expires_in: 5400 });
    if (path === "/me/accounts") return Response.json({ data: opts.pages ?? PAGES });
    if (path === "/ig2/media") return Response.json({ id: "container-1" });
    if (path === "/container-1") return Response.json({ status_code: "FINISHED", id: "container-1" });
    if (path === "/ig2/media_publish") return Response.json({ id: "media-9" });
    if (path === "/media-9") return Response.json({ permalink: "https://www.instagram.com/p/abc/", id: "media-9" });
    if (path === "/p2/feed") return Response.json({ id: "p2_111" });
    if (path === "/p2/photos") return Response.json({ id: "photo-5", post_id: "p2_222" });
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const metaConn = (over: Partial<Connection> = {}): Connection => ({
  provider: "meta", connectedAt: new Date().toISOString(),
  data: { access_token: "long-user", page_token: "page-tok-2", pages: JSON.stringify(PAGES.map((p) => ({ id: p.id, name: p.name, token: p.access_token, igId: p.instagram_business_account?.id, ig: p.instagram_business_account?.username }))) },
  meta: { pageId: "p2", igId: "ig2", account: "متجر الورد · @ward.sa" }, ...over,
});
/** Our own old Blob copies (legacy during the expand release, rule 679): handed over as they are, already public. */
const BLOB_IMG = `https://s1.public.blob.vercel-storage.com/media/${"a1".repeat(16)}.jpg`;
const BLOB_CLIP = `https://s1.public.blob.vercel-storage.com/media/${"b2".repeat(16)}.mp4`;
const post = (over: Partial<Task> = {}): Task => ({ id: `t${Math.random().toString(16).slice(2, 10)}`, type: "social", channel: "instagram", title: "t", body: "## عود ملكي\n**جديد** في المتجر", status: "approved", createdAt: new Date().toISOString(), lang: "ar", imageUrl: "https://v3.fal.media/files/abc.jpg", imageProvider: "fal", ...over });

async function connectedUser(tag: string, conn = metaConn()) {
  const u = await newUser(tag);
  await saveConnection(acct(u), conn);
  await signIn(u.email);
  return u;
}
const publish = async (id: string, provider: string) => publishRoute.POST(await vjson(`/api/publish/${id}`, "POST", { provider }), { params: Promise.resolve({ id }) });

describe("connecting Meta (rule 75)", () => {
  it("asks only for the permissions of built features", () => {
    const scopes = getProvider("meta")!.oauth!.scopes;
    expect(scopes).toEqual(["pages_show_list", "pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "business_management"]);
  });

  it("keeps a long-lived token and the Pages, prefers the Page with Instagram, and puts no token in the visible metadata", async () => {
    fakeGraph();
    const u = await newUser("metacb");
    await saveState("s-meta", { email: acct(u), provider: "meta", lang: "en", shop: "", verifier: "" });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "s-meta");
    const res = await callback.GET(new Request("https://app.test/api/connect/meta/callback?state=s-meta&code=c"), ctx("meta"));
    expect(new URL(res.headers.get("location")!).searchParams.get("connected")).toBe("meta");

    const c = (await getConnection(acct(u), "meta"))!;
    expect(c.data).toMatchObject({ access_token: "long-user", page_token: "page-tok-2" });
    expect(c.meta).toMatchObject({ pageId: "p2", igId: "ig2", account: "متجر الورد · @ward.sa" });
    expect(JSON.parse(c.meta!.pages)).toEqual([{ id: "p1", name: "Ward Riyadh", ig: "" }, { id: "p2", name: "متجر الورد", ig: "ward.sa" }]);
    expect(JSON.stringify(c.meta)).not.toMatch(/tok|long-user/);
    expect(c.expiresAt).toBeUndefined();
    // The app secret travels in POST bodies only, never in a URL.
    expect(calls.every((k) => !k.url.includes("msecret"))).toBe(true);
    expect(calls.find((k) => k.body.get("grant_type") === "fb_exchange_token")?.body.get("fb_exchange_token")).toBe("short-user");
    expect(connectedTargets([{ provider: "meta", meta: c.meta }])).toEqual(["meta", "facebook", "instagram"]);
  });

  it("refuses an account with no Page instead of saving a connection that cannot publish", async () => {
    fakeGraph({ pages: [] });
    const u = await newUser("metanone");
    await saveState("s-meta0", { email: acct(u), provider: "meta", lang: "en", shop: "", verifier: "" });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "s-meta0");
    const res = await callback.GET(new Request("https://app.test/api/connect/meta/callback?state=s-meta0&code=c"), ctx("meta"));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("meta_no_page");
    expect(await getConnection(acct(u), "meta")).toBeNull();
  });

  it("switches to another Page Meta returned, and refuses any other id", async () => {
    const u = await connectedUser("metasel");
    const bad = await connectRoute.POST(json("/api/connect/meta", "POST", { action: "select_page", pageId: "p-evil" }), ctx("meta"));
    expect(bad.status).toBe(400);
    expect((await getConnection(acct(u), "meta"))!.data.page_token).toBe("page-tok-2");

    const ok = await connectRoute.POST(json("/api/connect/meta", "POST", { action: "select_page", pageId: "p1" }), ctx("meta"));
    expect((await ok.json()).account).toBe("Ward Riyadh");
    const c = (await getConnection(acct(u), "meta"))!;
    expect(c.data.page_token).toBe("page-tok-1");
    expect(c.meta?.pageId).toBe("p1");
    expect(c.meta?.igId, "p1 has no Instagram account, so the old one must not linger").toBeUndefined();
    expect(connectedTargets([{ provider: "meta", meta: c.meta }])).toEqual(["meta", "facebook"]);
  });
});

describe("where a post can go (rule 75)", () => {
  const both = ["meta", "facebook", "instagram"];
  it("offers Instagram only for a post with a generated image, and Facebook for Instagram-channel posts", () => {
    expect(targetsFor(post(), both)).toEqual(["instagram", "facebook"]);
    expect(targetsFor(post({ imageUrl: undefined, imageProvider: undefined }), both)).toEqual(["facebook"]);
    expect(targetsFor(post({ imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" }), both), "a placeholder card is not artwork").toEqual(["facebook"]);
    expect(targetsFor(post({ type: "cart_recovery" }), both)).toEqual(["instagram", "facebook"]);
    expect(targetsFor(post({ channel: "snapchat" }), both)).toEqual([]);
    expect(targetsFor(post({ type: "article", channel: "blog" }), both)).toEqual([]);
    expect(targetsFor(post(), ["meta", "facebook"])).toEqual(["facebook"]);
  });

  it("counts a generated image from every media provider, and nothing else, as artwork", () => {
    expect(targetsFor(post({ imageUrl: BLOB_IMG, imageProvider: "kie", imageModel: "img-balanced" }), both)).toEqual(["instagram", "facebook"]);
    expect(targetsFor(post({ imageUrl: BLOB_IMG, imageProvider: "higgsfield", imageModel: "img-lifestyle" }), both)).toEqual(["instagram", "facebook"]);
    expect(targetsFor(post({ imageProvider: undefined }), both), "an image saved with no recorded provider is not known artwork").toEqual(["facebook"]);
    expect(targetsFor(post({ imageUrl: undefined, imageProvider: "kie" }), both), "a provider with no image").toEqual(["facebook"]);
  });

  it("never offers a clip to Instagram: video is not a publish target in this round", () => {
    const clipOnly = post({ imageUrl: undefined, imageProvider: undefined, videoUrl: BLOB_CLIP, videoProvider: "kie", videoModel: "vid-quick" });
    expect(targetsFor(clipOnly, both)).toEqual(["facebook"]);
  });
});

describe("publishing to Instagram and Facebook (rule 75)", () => {
  it("publishes to Instagram with the Page token: container, ready check, publish, permalink", async () => {
    fakeGraph();
    const u = await connectedUser("metaig");
    const t = post();
    await saveTask(acct(u), t, true);
    const res = await publish(t.id, "instagram");
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.result).toMatchObject({ provider: "instagram", status: "published", url: "https://www.instagram.com/p/abc/", id: "media-9" });
    const create = calls.find((k) => k.url.endsWith("/ig2/media"))!;
    expect(create.method).toBe("POST");
    expect(create.auth).toBe("Bearer page-tok-2");
    expect(create.body.get("image_url")).toBe("https://v3.fal.media/files/abc.jpg");
    expect(create.body.get("caption")).toBe("عود ملكي\nجديد في المتجر");
    expect(calls.find((k) => k.url.endsWith("/ig2/media_publish"))!.body.get("creation_id")).toBe("container-1");
    expect((await getTask(acct(u), t.id))!.published?.[0]).toMatchObject({ provider: "instagram", status: "published" });
  });

  it("refuses Instagram for a post without a generated image, before calling Meta", async () => {
    fakeGraph();
    const u = await connectedUser("metaig2");
    const t = post({ imageUrl: undefined, imageProvider: undefined });
    await saveTask(acct(u), t, true);
    const res = await publish(t.id, "instagram");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("wrong_target");
    expect(calls).toEqual([]);
  });

  it("posts to the Facebook Page as text, or as a photo when the post has a generated image", async () => {
    fakeGraph();
    const u = await connectedUser("metafb");
    const text = post({ imageUrl: undefined, imageProvider: undefined });
    await saveTask(acct(u), text, true);
    expect((await (await publish(text.id, "facebook")).json()).result).toMatchObject({ url: "https://www.facebook.com/p2_111", status: "published" });
    expect(calls.find((k) => k.url.endsWith("/p2/feed"))!.body.get("message")).toBe("عود ملكي\nجديد في المتجر");

    const photo = post();
    await saveTask(acct(u), photo, true);
    expect((await (await publish(photo.id, "facebook")).json()).result.url).toBe("https://www.facebook.com/p2_222");
    expect(calls.find((k) => k.url.endsWith("/p2/photos"))!.body.get("url")).toBe("https://v3.fal.media/files/abc.jpg");
  });

  it("publishes a kie image to Instagram and a Higgsfield image to the Page, both from our Blob copy", async () => {
    fakeGraph();
    const u = await connectedUser("metamedia");
    const kie = post({ imageUrl: BLOB_IMG, imageProvider: "kie", imageModel: "img-premium" });
    await saveTask(acct(u), kie, true);
    expect((await (await publish(kie.id, "instagram")).json()).result).toMatchObject({ provider: "instagram", status: "published" });
    expect(calls.find((k) => k.url.endsWith("/ig2/media"))!.body.get("image_url")).toBe(BLOB_IMG);

    const hf = post({ imageUrl: BLOB_IMG, imageProvider: "higgsfield", imageModel: "img-design" });
    await saveTask(acct(u), hf, true);
    expect((await (await publish(hf.id, "facebook")).json()).result.url).toBe("https://www.facebook.com/p2_222");
    expect(calls.find((k) => k.url.endsWith("/p2/photos"))!.body.get("url")).toBe(BLOB_IMG);
  });

  it("hands Meta a short signed link to a disk-store image, and the task keeps the plain URL (rule 1755)", async () => {
    fakeGraph();
    const u = await connectedUser("metadisk");
    const plain = `https://thakeen.com/m/${"c3".repeat(16)}.jpg`;
    const t = post({ imageUrl: plain, imageProvider: "kie", imageModel: "img-premium" });
    await saveTask(acct(u), t, true);
    expect((await (await publish(t.id, "instagram")).json()).result).toMatchObject({ status: "published" });
    const sent = new URL(calls.find((k) => k.url.endsWith("/ig2/media"))!.body.get("image_url")!);
    expect(sent.origin + sent.pathname).toBe(plain);
    expect([...sent.searchParams.keys()].sort()).toEqual(["exp", "sig"]);
    const { shareValid } = await import("@/lib/media/share");
    expect(shareValid(`${"c3".repeat(16)}.jpg`, sent.searchParams.get("exp"), sent.searchParams.get("sig"))).toBe(true);
    expect((await getTask(acct(u), t.id))?.imageUrl).toBe(plain);
  });

  it("posts a clip-only item to the Page as text, never with the clip or a placeholder", async () => {
    fakeGraph();
    const u = await connectedUser("metaclip");
    const clip = post({ channel: "facebook", imageUrl: undefined, imageProvider: undefined, videoUrl: BLOB_CLIP, videoProvider: "higgsfield", videoModel: "vid-motion" });
    await saveTask(acct(u), clip, true);
    await publish(clip.id, "facebook");
    const placeholder = post({ channel: "facebook", imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" });
    await saveTask(acct(u), placeholder, true);
    await publish(placeholder.id, "facebook");
    expect(calls.filter((k) => k.url.endsWith("/p2/feed"))).toHaveLength(2);
    expect(calls.some((k) => k.url.endsWith("/p2/photos"))).toBe(false);
    expect(calls.some((k) => [...k.body.values()].some((v) => v.includes(BLOB_CLIP) || v.includes("placehold.co")))).toBe(false);
  });

  it("checks for artwork again at the call that posts, not only in the route", async () => {
    fakeGraph();
    const u = await connectedUser("metaig3");
    await expect(publishTask(acct(u), post({ imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" }), "instagram")).rejects.toThrow("instagram_needs_image");
    await expect(publishTask(acct(u), post({ imageProvider: undefined }), "instagram")).rejects.toThrow("instagram_needs_image");
    expect(calls).toEqual([]);
  });

  it("asks for a reconnect when Meta says the token was revoked", async () => {
    fakeGraph({ revoked: true });
    const u = await connectedUser("metarev");
    const t = post();
    await saveTask(acct(u), t, true);
    const res = await publish(t.id, "facebook");
    expect((await res.json()).error).toBe("reconnect_required");
    expect((await getConnection(acct(u), "meta"))?.needsReconnect).toBeTruthy();
  });
});
