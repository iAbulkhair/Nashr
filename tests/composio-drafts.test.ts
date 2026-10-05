import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { composioStageFile, composioWrite, setComposioClientForTests, type ComposioClient } from "@/lib/connectors/composio";
import { TOOLKITS } from "@/lib/connectors/composio-catalog";
import { connectViaComposio, submitWhatsAppTemplateVia, uploadToYouTubeVia, whatsappTemplate } from "@/lib/connectors/via-composio";
import { connectedTargets, targetsFor } from "@/lib/connectors/targets";
import { publishTask } from "@/lib/connectors/publish";
import { gateTask } from "@/lib/brand-rules";
import { mayHavePosted } from "@/lib/publish-once";
import type { Task } from "@/lib/brand";

/**
 * Rules 641-644: drafts through Composio and by API key. Nothing here reaches a customer or the public: a WhatsApp
 * message becomes a template for Meta's review, a clip a private YouTube video, an email a Brevo draft campaign or a
 * Klaviyo template. Composio's client and fetch are fakes; answers follow Composio's output schemas.
 */
type Result = { data?: unknown; error?: string | null; successful: boolean };
let calls: { slug: string; accountId: string; args: Record<string, unknown> }[];
let staged: { file: string; toolSlug: string; toolkitSlug: string }[];
let answers: Record<string, Result>;

function fake(): ComposioClient {
  return {
    connectedAccounts: {
      link: async () => ({ id: "ca_new", redirectUrl: "https://connect.composio.dev/link/lk_1" }),
      waitForConnection: async (id) => ({ id, status: "ACTIVE" }),
      list: async () => ({ items: [] }),
      revoke: async () => {},
      delete: async () => {},
    },
    tools: {
      execute: async (slug, body) => {
        calls.push({ slug, accountId: body.connectedAccountId, args: body.arguments });
        return answers[slug] ?? { successful: false, error: "not mocked" };
      },
    },
    files: {
      upload: async (p) => { staged.push(p); return { name: "clip.mp4", mimetype: "video/mp4", s3key: "proj/youtube/YOUTUBE_UPLOAD_VIDEO/request/k1" }; },
    },
  };
}

beforeEach(() => {
  calls = [];
  staged = [];
  answers = {};
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  setComposioClientForTests(fake());
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const ok = (data: unknown): Result => ({ successful: true, data });
const via = (provider: string, data: Record<string, string>, meta: Record<string, string> = {}): Connection => ({ provider, data, meta: { via: "composio", ...meta }, connectedAt: new Date().toISOString() });
const keyed = (provider: string): Connection => ({ provider, data: { apiKey: "k_test" }, connectedAt: new Date().toISOString() });
const CLIP = `https://s1.public.blob.vercel-storage.com/media/${"b2".repeat(16)}.mp4`;
const item = (over: Partial<Task> = {}): Task => ({ id: `t${Math.random().toString(16).slice(2, 10)}`, type: "whatsapp", channel: "whatsapp", title: "عرض العيد", body: "هلا {{1}}، وصل عطر العود الجديد. اطلبه من {{2}} اليوم. للإيقاف أرسل: إلغاء", status: "approved", createdAt: new Date().toISOString(), lang: "ar", ...over } as Task);

describe("a draft stays a draft in code (rule 641)", () => {
  it("refuses a public YouTube upload or a direct TikTok post before anything is sent", async () => {
    const yt = { title: "t", description: "d", tags: [], categoryId: "22", videoFilePath: {} };
    await expect(composioWrite("s", "youtube", "YOUTUBE_UPLOAD_VIDEO", { ...yt, privacyStatus: "public" }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    await expect(composioWrite("s", "youtube", "YOUTUBE_UPLOAD_VIDEO", yt, "ca"), "a missing value is not the pinned one").rejects.toThrow("composio_argument_not_allowed");
    await expect(composioWrite("s", "tiktok", "TIKTOK_POST_PHOTO", { photo_images: ["x"], post_mode: "DIRECT_POST" }, "ca")).rejects.toThrow("composio_argument_not_allowed");
    expect(calls).toEqual([]);
  });

  it("lists no tool that sends, deletes or publishes for WhatsApp and YouTube", () => {
    for (const t of ["whatsapp", "youtube"] as const) {
      const slugs = [...Object.keys(TOOLKITS[t].read), ...Object.keys(TOOLKITS[t].write)];
      for (const s of slugs) expect(s).not.toMatch(/SEND|DELETE|UPDATE|PUBLISH|BROADCAST/);
    }
    expect(TOOLKITS.whatsapp.write.WHATSAPP_CREATE_MESSAGE_TEMPLATE, "the business account comes from the connection").not.toContain("waba_id");
  });

  it("hands Composio only our own Blob copy of a file, for a listed write tool", async () => {
    await expect(composioStageFile("s", "youtube", "YOUTUBE_UPLOAD_VIDEO", "https://evil.example/clip.mp4")).rejects.toThrow("composio_file_not_allowed");
    await expect(composioStageFile("s", "youtube", "YOUTUBE_UPLOAD_VIDEO", "http://169.254.169.254/latest")).rejects.toThrow("composio_file_not_allowed");
    await expect(composioStageFile("s", "youtube", "YOUTUBE_LIST_CHANNELS", CLIP)).rejects.toThrow("composio_tool_not_allowed");
    expect(staged).toEqual([]);
    expect(await composioStageFile("s", "youtube", "YOUTUBE_UPLOAD_VIDEO", CLIP)).toEqual({ name: "clip.mp4", mimetype: "video/mp4", s3key: "proj/youtube/YOUTUBE_UPLOAD_VIDEO/request/k1" });
    expect(staged).toEqual([{ file: CLIP, toolSlug: "YOUTUBE_UPLOAD_VIDEO", toolkitSlug: "youtube" }]);
  });
});

describe("WhatsApp templates and private YouTube uploads (rule 642)", () => {
  it("renumbers the variables in order of first use and gives each a neutral example", () => {
    const t = whatsappTemplate("T-9x", "**مرحبا** {{2}}، طلبك {{1}} جاهز. شكراً {{2}} على ثقتك", "ar", "k1");
    expect(t).toMatchObject({ name: "thakeen_t9x_k1", category: "MARKETING", language: "ar", allow_category_change: true });
    expect(t.components).toEqual([{ type: "BODY", text: "مرحبا {{1}}، طلبك {{2}} جاهز. شكراً {{1}} على ثقتك", example: { body_text: [["مثال1", "مثال2"]] } }]);
    expect(whatsappTemplate("x", "Hello there", "en", "k").components).toEqual([{ type: "BODY", text: "Hello there" }]);
    expect(whatsappTemplate("x", "Hi", "en", "k").language).toBe("en");
  });

  it("refuses what Meta would refuse, before sending", () => {
    expect(() => whatsappTemplate("x", "{{1}} وصل طلبك", "ar", "k")).toThrow("whatsapp_variable_at_edge");
    expect(() => whatsappTemplate("x", "وصل طلبك يا {{1}}.", "ar", "k")).toThrow("whatsapp_variable_at_edge");
    expect(() => whatsappTemplate("x", "ا".repeat(1025), "ar", "k")).toThrow("whatsapp_too_long");
    expect(() => whatsappTemplate("x", "  ", "ar", "k")).toThrow("whatsapp_empty");
    for (const code of ["whatsapp_variable_at_edge", "whatsapp_too_long", "whatsapp_empty", "youtube_needs_video", "composio_stage_failed", "composio_file_not_allowed"]) expect(mayHavePosted(new Error(code))).toBe(false);
  });

  it("submits the template to review and reports a draft; an immediate rejection is a refusal", async () => {
    const u = await newUser("watpl");
    await saveConnection(u.email, via("whatsapp", { whatsapp: "ca_wa" }, { account: "Ward" }));
    answers.WHATSAPP_CREATE_MESSAGE_TEMPLATE = ok({ id: "tpl_1", status: "PENDING", category: "MARKETING" });
    expect(await publishTask(u.email, item(), "whatsapp")).toMatchObject({ id: "tpl_1", provider: "whatsapp", status: "draft" });
    expect(calls[0]).toMatchObject({ slug: "WHATSAPP_CREATE_MESSAGE_TEMPLATE", accountId: "ca_wa" });
    expect(Object.keys(calls[0].args).sort()).toEqual(["allow_category_change", "category", "components", "language", "name"]);
    answers.WHATSAPP_CREATE_MESSAGE_TEMPLATE = ok({ id: "tpl_2", status: "REJECTED", category: "MARKETING" });
    const e = await submitWhatsAppTemplateVia("s", via("whatsapp", { whatsapp: "ca_wa" }), "t1", item().body, "ar").catch((x: Error) => x);
    expect((e as Error).message).toBe("whatsapp 400: template_rejected");
    expect(mayHavePosted(e)).toBe(false);
    expect(mayHavePosted(new Error("whatsapp 502: no id"))).toBe(true);
  });

  it("uploads a clip as a private video after staging our own copy, and refuses an item with no clip of ours", async () => {
    answers.YOUTUBE_UPLOAD_VIDEO = ok({ response_data: { id: "vid_1", kind: "youtube#video", etag: "e", snippet: {}, status: { privacyStatus: "private" } } });
    const r = await uploadToYouTubeVia("s", via("youtube", { youtube: "ca_yt" }), "عرض <العيد>", "**جديد** العود", CLIP);
    expect(r).toEqual({ id: "vid_1", url: "https://studio.youtube.com/video/vid_1/edit" });
    expect(staged).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ title: "عرض العيد", description: "جديد العود", privacyStatus: "private", videoFilePath: { s3key: "proj/youtube/YOUTUBE_UPLOAD_VIDEO/request/k1" } });
    const u = await newUser("ytpriv");
    await saveConnection(u.email, via("youtube", { youtube: "ca_yt" }));
    expect(await publishTask(u.email, item({ type: "social", channel: "tiktok", videoUrl: CLIP }), "youtube")).toMatchObject({ id: "vid_1", status: "draft" });
    const e = await publishTask(u.email, item({ type: "social", channel: "tiktok", videoUrl: "https://cdn.example/clip.mp4" }), "youtube").catch((x: Error) => x);
    expect((e as Error).message).toBe("youtube_needs_video");
    expect(staged).toHaveLength(2);
  });

  it("connects only a business account or a channel that exists", async () => {
    answers.WHATSAPP_GET_BUSINESS_ACCOUNT_DETAILS = ok({ id: "1116516570186501", name: "Ward Perfumes" });
    expect((await connectViaComposio("s", "whatsapp", "whatsapp", "ca_wa", null)).meta).toMatchObject({ via: "composio", account: "Ward Perfumes" });
    answers.WHATSAPP_GET_BUSINESS_ACCOUNT_DETAILS = ok({});
    await expect(connectViaComposio("s", "whatsapp", "whatsapp", "ca_wa", null)).rejects.toThrow("no_whatsapp_business");
    answers.YOUTUBE_LIST_CHANNELS = ok({ items: [{ id: "UCddiUEpeqJcYeBxX1IVBKvQ", snippet: { title: "Ward TV" } }] });
    expect((await connectViaComposio("s", "youtube", "youtube", "ca_yt", null)).meta).toMatchObject({ channelId: "UCddiUEpeqJcYeBxX1IVBKvQ", account: "Ward TV" });
    answers.YOUTUBE_LIST_CHANNELS = ok({ items: [] });
    await expect(connectViaComposio("s", "youtube", "youtube", "ca_yt", null)).rejects.toThrow("no_youtube_channel");
  });
});

describe("where a draft can go (rule 643)", () => {
  const conns = [via("whatsapp", { whatsapp: "a" }), via("youtube", { youtube: "b" }), keyed("brevo"), keyed("klaviyo")];
  it("sends a WhatsApp message to templates, an email to Brevo and Klaviyo, and our own clip to YouTube", () => {
    const c = connectedTargets(conns);
    expect(targetsFor(item(), c)).toEqual(["whatsapp"]);
    expect(targetsFor(item({ type: "cart_recovery" }), c)).toEqual(["whatsapp"]);
    expect(targetsFor(item({ type: "followup_seq", channel: "email" }), c)).toEqual(["brevo", "klaviyo"]);
    expect(targetsFor(item({ type: "social", channel: "tiktok", videoUrl: CLIP }), c)).toEqual(["youtube"]);
    expect(targetsFor(item({ type: "social", channel: "tiktok", videoUrl: "https://cdn.example/clip.mp4" }), c), "a clip that is not our copy").toEqual([]);
    expect(targetsFor(item({ type: "social", channel: "instagram" }), c)).toEqual([]);
  });

  it("does not treat a direct WhatsApp or YouTube record as a target", () => {
    expect(connectedTargets([{ provider: "whatsapp" }, { provider: "youtube" }])).toEqual([]);
  });

  it("lets a template keep its {{n}} variables at publish, and holds every other placeholder", () => {
    const t = item();
    expect(gateTask(null, t, { publish: true }).map((v) => v.term)).toEqual(["{{1}}", "{{2}}"]);
    expect(gateTask(null, t, { publish: true, provider: "telegram" })).toHaveLength(2);
    expect(gateTask(null, t, { publish: true, provider: "whatsapp" })).toEqual([]);
    expect(gateTask(null, item({ body: "هلا [الاسم]، عرضنا [رقم]% لين {{1}} بكرة" }), { publish: true, provider: "whatsapp" }).map((v) => v.term)).toEqual(["[الاسم]", "[رقم]"]);
    expect(gateTask({ banned: "مجاني" }, item({ body: "شحن مجاني يا {{1}} اليوم" }), { publish: true, provider: "whatsapp" }).map((v) => v.kind)).toEqual(["banned"]);
  });
});

describe("email drafts by API key (rule 644)", () => {
  type Req = { url: string; init: RequestInit };
  let reqs: Req[] = [];
  const stub = (answer: (url: string) => { status: number; body: unknown }) => {
    reqs = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      reqs.push({ url, init });
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
    });
  };
  const email = () => item({ type: "followup_seq", channel: "email", title: "متابعة العرض", body: "## متابعة\nنص **مهم** <script>alert(1)</script>" });

  it("makes a Brevo campaign with no recipients and no send time, from rendered HTML", async () => {
    const u = await newUser("brevodraft");
    await saveConnection(u.email, keyed("brevo"));
    stub((url) => (url.endsWith("/senders") ? { status: 200, body: { senders: [{ id: 3, active: false }, { id: 7, active: true }] } } : { status: 201, body: { id: 41 } }));
    expect(await publishTask(u.email, email(), "brevo")).toMatchObject({ id: "41", provider: "brevo", status: "draft" });
    expect(reqs.map((r) => r.url)).toEqual(["https://api.brevo.com/v3/senders", "https://api.brevo.com/v3/emailCampaigns"]);
    const body = JSON.parse(String(reqs[1].init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["htmlContent", "name", "sender", "subject"]);
    expect(body).toMatchObject({ sender: { id: 7 }, subject: "متابعة العرض" });
    expect(String(body.htmlContent)).toContain("<strong>مهم</strong>");
    expect(String(body.htmlContent)).not.toContain("<script");
  });

  it("refuses with no active sender, and reads Brevo's errors like any connector's", async () => {
    const u = await newUser("brevonosender");
    await saveConnection(u.email, keyed("brevo"));
    stub(() => ({ status: 200, body: { senders: [] } }));
    const e = await publishTask(u.email, email(), "brevo").catch((x: Error) => x);
    expect((e as Error).message).toBe("brevo_no_sender");
    expect(mayHavePosted(e)).toBe(false);
    expect(reqs).toHaveLength(1);
    stub((url) => (url.endsWith("/senders") ? { status: 200, body: { senders: [{ id: 1 }] } } : { status: 400, body: { message: "invalid html" } }));
    const e2 = await publishTask(u.email, email(), "brevo").catch((x: Error) => x);
    expect((e2 as Error).message).toBe("brevo 400: invalid html");
    expect(mayHavePosted(e2)).toBe(false);
    expect(mayHavePosted(new Error("brevo 502: failed"))).toBe(true);
  });

  it("puts a Klaviyo template in the library and nothing else", async () => {
    const u = await newUser("klaviyodraft");
    await saveConnection(u.email, keyed("klaviyo"));
    stub(() => ({ status: 201, body: { data: { type: "template", id: "XyZ12" } } }));
    expect(await publishTask(u.email, email(), "klaviyo")).toMatchObject({ id: "XyZ12", status: "draft" });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].url).toBe("https://a.klaviyo.com/api/templates");
    const body = JSON.parse(String(reqs[0].init.body)) as { data: { type: string; attributes: Record<string, unknown> } };
    expect(body.data.type).toBe("template");
    expect(Object.keys(body.data.attributes).sort()).toEqual(["editor_type", "html", "name"]);
    expect(String(body.data.attributes.html)).not.toContain("<script");
  });
});
