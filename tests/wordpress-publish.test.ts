import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { currentUser, sc } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { saveConnection } from "@/lib/connectors/store";
import * as publishRoute from "@/app/api/publish/[id]/route";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rules 618-622: WordPress publishing. A post goes out as a draft; going live is a separate confirmation for that one
 * item, checked in code, and needs the site's publish capability. The item's artwork becomes the featured image, and a
 * failed image never blocks the draft. "Publish again" updates the post the item's own record names, never an id from the
 * request, and never changes a status the owner set in WordPress. WordPress is mocked in the shapes its REST API documents.
 */
const SITE = "https://blog.example.com";
const IMG = "https://v3.fal.media/files/abc.png";
const realFetch = globalThis.fetch;
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
let calls: Call[] = [];
type Site = { canPublish?: boolean; image?: { type: string; size: number } | "fail"; media?: "fail"; missing?: boolean; postStatus?: string };
function fakeSite(o: Site = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (url === IMG) {
      if (o.image === "fail") return new Response("gone", { status: 404 });
      const im = o.image ?? { type: "image/png", size: 10 };
      return new Response(new Uint8Array(im.size), { status: 200, headers: { "content-type": im.type } });
    }
    const u = new URL(url);
    if (u.host !== "blog.example.com") return new Response("not mocked", { status: 500 });
    if (u.pathname === "/wp-json/wp/v2/users/me") return Response.json({ name: "Owner", capabilities: { edit_posts: true, publish_posts: o.canPublish !== false, upload_files: true } });
    if (u.pathname === "/wp-json/wp/v2/media") return o.media === "fail" ? new Response("no", { status: 403 }) : Response.json({ id: 77 });
    const upd = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(u.pathname);
    if (upd) return o.missing ? new Response("gone", { status: 404 }) : Response.json({ id: Number(upd[1]), link: `${SITE}/?p=${upd[1]}`, status: o.postStatus ?? "draft" });
    if (u.pathname === "/wp-json/wp/v2/posts") {
      const status = (body as { status?: string }).status;
      return Response.json({ id: 501, link: `${SITE}/?p=501`, status: status === "publish" ? "publish" : "draft" }, { status: 201 });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const article = (over: Partial<Task> = {}): Task => ({ id: `t${Math.random().toString(16).slice(2, 10)}`, type: "article", channel: "blog", title: "عود", body: "# عود ملكي\nنص المقال", status: "approved", createdAt: new Date().toISOString(), lang: "ar", ...over });
const withArt: Partial<Task> = { imageUrl: IMG, imageProvider: "fal" };
const publish = async (id: string, body: Record<string, unknown>) => publishRoute.POST(await vjson(`/api/publish/${id}`, "POST", { provider: "wordpress", ...body }), { params: Promise.resolve({ id }) });
const posts = () => calls.filter((c) => /\/wp\/v2\/posts(\/\d+)?$/.test(c.url) && c.method === "POST");
const sentStatus = (i = 0) => (posts()[i].body as { status?: string }).status;

let email = "";
beforeEach(async () => {
  const u = await newUser("wp");
  email = u.email;
  await saveConnection(email, { provider: "wordpress", connectedAt: new Date().toISOString(), data: { site: SITE, username: "owner", appPassword: "abcd efgh ijkl" } });
  await signIn(email);
});
const scopeOf = async () => sc((await currentUser())!);
const seed = async (t: Task) => { await saveTask(await scopeOf(), t); return t; };

describe("WordPress publishes a draft (rule 618)", () => {
  it("creates the post with status draft and records it as a draft", async () => {
    fakeSite();
    const t = await seed(article());
    const res = await publish(t.id, {});
    expect(res.status).toBe(200);
    expect(posts()).toHaveLength(1);
    expect(sentStatus()).toBe("draft");
    expect((await res.json()).result.status).toBe("draft");
    const rec = (await getTask(await scopeOf(), t.id))!.published!.at(-1)!;
    expect(rec).toMatchObject({ provider: "wordpress", status: "draft", id: "501" });
  });

  it("ignores a live flag the body does not set to exactly true", async () => {
    fakeSite();
    const t = await seed(article());
    await publish(t.id, { live: "true" });
    expect(sentStatus()).toBe("draft");
  });
});

describe("going live is a separate confirmation (rule 619)", () => {
  it("publishes only when the body says live: true, and records it as published", async () => {
    fakeSite();
    const t = await seed(article());
    const res = await publish(t.id, { live: true });
    expect(res.status).toBe(200);
    expect(sentStatus()).toBe("publish");
    expect((await res.json()).result.status).toBe("published");
  });

  it("refuses live for any other platform before anything is sent", async () => {
    fakeSite();
    const t = await seed(article());
    await saveConnection(email, { provider: "shopify", connectedAt: new Date().toISOString(), data: { access_token: "shpat" }, meta: { shop: "a.myshopify.com" } });
    const res = await publish(t.id, { provider: "shopify", live: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("live_unsupported");
    expect(calls).toHaveLength(0);
  });

  it("refuses live when the site user cannot publish, posts nothing, and leaves no result-unknown marker", async () => {
    fakeSite({ canPublish: false });
    const t = await seed(article());
    const res = await publish(t.id, { live: true });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("wordpress_cannot_publish_live");
    expect(posts()).toHaveLength(0);
    // The refusal proves nothing went out: the next click is a normal publish, not "result unknown".
    fakeSite({ canPublish: false });
    const next = await publish(t.id, {});
    expect(next.status).toBe(200);
    expect(sentStatus()).toBe("draft");
  });

  it("the role gate sits in front of the live flag, and the chat and MCP path never passes live or again", () => {
    const route = readFileSync("src/app/api/publish/[id]/route.ts", "utf8");
    expect(route.indexOf('forbid(u, "publish")')).toBeGreaterThan(-1);
    expect(route.indexOf('forbid(u, "publish")')).toBeLessThan(route.indexOf("b.live"));
    const chat = readFileSync("src/lib/chat.ts", "utf8").split("\n").filter((l) => l.includes("publishOnce("));
    expect(chat.length).toBeGreaterThan(0);
    for (const l of chat) expect(l).not.toMatch(/live|again/);
  });
});

describe("featured image (rule 620)", () => {
  it("uploads the artwork to the media library with the site login and sets featured_media", async () => {
    fakeSite();
    const t = await seed(article(withArt));
    await publish(t.id, {});
    const media = calls.find((c) => c.url === `${SITE}/wp-json/wp/v2/media`)!;
    expect(media.method).toBe("POST");
    expect(media.headers.Authorization).toBe("Basic " + Buffer.from("owner:abcdefghijkl").toString("base64"));
    expect(media.headers["Content-Type"]).toBe("image/png");
    expect(media.headers["Content-Disposition"]).toMatch(/^attachment; filename="thakeen-\d+\.png"$/);
    expect((posts()[0].body as { featured_media: number }).featured_media).toBe(77);
  });

  it("a failed upload still creates the draft and says the image is missing", async () => {
    fakeSite({ media: "fail" });
    const t = await seed(article(withArt));
    const res = await publish(t.id, {});
    expect(res.status).toBe(200);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).not.toHaveProperty("featured_media");
    expect((await res.json()).result.notes).toEqual(["image_failed"]);
  });

  it("a missing, non-image or oversize file is not sent to the site", async () => {
    for (const image of ["fail", { type: "text/html", size: 10 }, { type: "image/png", size: 8 * 1024 * 1024 + 1 }] as const) {
      fakeSite({ image });
      const t = await seed(article(withArt));
      const res = await publish(t.id, {});
      expect(res.status).toBe(200);
      expect(calls.some((c) => c.url.endsWith("/media"))).toBe(false);
      expect((await res.json()).result.notes).toEqual(["image_failed"]);
    }
  });

  it("only generated artwork goes up: an image with no recorded media provider is not fetched and gives no note", async () => {
    fakeSite();
    const t = await seed(article({ imageUrl: IMG }));
    const res = await publish(t.id, {});
    expect(calls.some((c) => c.url === IMG)).toBe(false);
    expect((await res.json()).result.notes).toBeUndefined();
  });

  it("the image address goes through safeFetch: an http address is never fetched", async () => {
    fakeSite();
    const t = await seed(article({ imageUrl: "http://v3.fal.media/files/abc.png", imageProvider: "fal" }));
    const res = await publish(t.id, {});
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.startsWith("http://"))).toBe(false);
    expect((await res.json()).result.notes).toEqual(["image_failed"]);
  });
});

describe("publish again updates the same post (rule 621)", () => {
  async function sentOnce(over: Partial<Task> = {}) {
    fakeSite();
    const t = await seed(article(over));
    await publish(t.id, {});
    return t;
  }

  it("without again a second publish is refused and sends nothing", async () => {
    const t = await sentOnce();
    fakeSite();
    const res = await publish(t.id, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_published");
    expect(calls).toHaveLength(0);
  });

  it("with again, updates the stored post id, sends no status, and uploads no second image", async () => {
    const t = await sentOnce(withArt);
    fakeSite({ postStatus: "publish" });
    const res = await publish(t.id, { again: true });
    expect(res.status).toBe(200);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe(`${SITE}/wp-json/wp/v2/posts/501`);
    expect(posts()[0].body).not.toHaveProperty("status");
    expect(calls.some((c) => c.url.endsWith("/media"))).toBe(false);
    // The owner published it in WordPress meanwhile: the record says what the site says.
    expect((await res.json()).result.status).toBe("published");
  });

  it("again with live: true updates the post and publishes it", async () => {
    const t = await sentOnce();
    fakeSite();
    await publish(t.id, { again: true, live: true });
    expect(posts()[0].url).toBe(`${SITE}/wp-json/wp/v2/posts/501`);
    expect(sentStatus()).toBe("publish");
  });

  it("never takes the post id from the request", async () => {
    const t = await sentOnce();
    fakeSite();
    await publish(t.id, { again: true, updateId: "9", id: "9", postId: "9" });
    expect(posts()[0].url).toBe(`${SITE}/wp-json/wp/v2/posts/501`);
  });

  it("an id that is not a plain number is never put in the address", async () => {
    const t = await sentOnce();
    const scope = await scopeOf();
    const cur = (await getTask(scope, t.id))!;
    cur.published = cur.published!.map((p) => ({ ...p, id: "501/../../users/1" }));
    await saveTask(scope, cur);
    fakeSite();
    const res = await publish(t.id, { again: true });
    expect(res.status).toBe(200);
    expect(posts().map((c) => c.url)).toEqual([`${SITE}/wp-json/wp/v2/posts`]);
  });

  it("when the earlier post was deleted on the site, a new draft is made", async () => {
    const t = await sentOnce();
    fakeSite({ missing: true });
    const res = await publish(t.id, { again: true });
    expect(res.status).toBe(200);
    expect(posts().map((c) => c.url)).toEqual([`${SITE}/wp-json/wp/v2/posts/501`, `${SITE}/wp-json/wp/v2/posts`]);
    expect(sentStatus(1)).toBe("draft");
  });

  it("an item sent before ids were recorded gets a new draft on again, not a guess", async () => {
    fakeSite();
    const t = await seed(article({ published: [{ provider: "wordpress", url: `${SITE}/?p=1`, status: "draft", at: new Date().toISOString() }] }));
    const res = await publish(t.id, { again: true });
    expect(res.status).toBe(200);
    expect(posts().map((c) => c.url)).toEqual([`${SITE}/wp-json/wp/v2/posts`]);
  });
});

describe("the record keeps the post id for WordPress only (rule 622)", () => {
  it("a Shopify publish writes no id into the item's record", async () => {
    const t = await seed(article());
    await saveConnection(email, { provider: "shopify", connectedAt: new Date().toISOString(), data: { access_token: "shpat" }, meta: { shop: "a.myshopify.com" } });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).host !== "a.myshopify.com") return new Response("not mocked", { status: 500 });
      const q = JSON.parse(String(init?.body)).query as string;
      if (q.includes("query Blog")) return Response.json({ data: { shop: { name: "متجر" }, blogs: { nodes: [{ id: "gid://shopify/Blog/7", handle: "news" }] } } });
      return Response.json({ data: { articleCreate: { article: { id: "gid://shopify/Article/99", handle: "oud" }, userErrors: [] } } });
    }) as typeof fetch;
    const res = await publish(t.id, { provider: "shopify" });
    expect(res.status).toBe(200);
    for (const p of (await getTask(await scopeOf(), t.id))!.published ?? []) expect(p).not.toHaveProperty("id");
  });
});
