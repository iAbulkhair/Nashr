import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, params, signIn, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { deleteFile, listFiles, writeFile } from "@/lib/files";
import { deleteConnection, listConnections, saveConnection, saveState } from "@/lib/connectors/store";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { EDITABLE_BRAND_FIELDS, runTool } from "@/lib/chat";
import { CHAT_PER_HOUR, chatAllowed } from "@/lib/rate";
import { isAdminCookie } from "@/lib/auth";

/** Each test here is a bug that was live in the code and is now fixed; the test is what keeps it fixed. */

import * as filesRoute from "@/app/api/files/route";
import * as waitlistRoute from "@/app/api/waitlist/route";
import * as supportRoute from "@/app/api/support/route";
import * as affiliatesRoute from "@/app/api/affiliates/route";
import * as chatRoute from "@/app/api/chat/route";
import * as callbackRoute from "@/app/api/connect/[provider]/callback/route";

const ip = (addr: string) => ({ "x-real-ip": addr });
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
    const actions: string[] = [];
    // Crawled pages, catalogs and uploads reach this agent, so the model naming a field is not permission to write it.
    for (const field of ["channels", "languages", "social", "updatedAt", "__proto__"]) {
      expect(await runTool(u, "update_brand", { field, value: "instagram" }, actions)).toMatch(/Cannot change brand/);
    }
    const after = (await getBrand(u.email))!;
    expect(Array.isArray(after.channels)).toBe(true);
    expect(after.channels).toEqual(["instagram", "whatsapp"]);
    expect(Array.isArray(after.languages)).toBe(true);
  });
  it("still writes the fields the tool is meant for", async () => {
    const u = await newUser("brandtool");
    await saveBrand(u.email, brand());
    const actions: string[] = [];
    expect(await runTool(u, "update_brand", { field: "tone", value: "رسمي" }, actions)).toMatch(/Updated brand\.tone/);
    expect((await getBrand(u.email))!.tone).toBe("رسمي");
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
    for (let i = 0; i < 11; i++) aff.push((await post(affiliatesRoute, "/api/affiliates", { email: "a@test.example", name: "A" }, "9.9.9.3")).status);
    expect(aff.filter((c) => c === 429)).toHaveLength(1);
  });
});

describe("chat is bounded per account", () => {
  it("stops a single account after the hourly ceiling and answers 429", async () => {
    const u = await newUser("chatcap");
    await signIn(u.email);
    for (let i = 0; i < CHAT_PER_HOUR; i++) expect(await chatAllowed(u.email)).toBe(true);
    expect(await chatAllowed(u.email)).toBe(false);
    // A turn is free in credits and can run five model calls, so this is the only ceiling on one account's model spend.
    expect((await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا" }))).status).toBe(429);
  });
});

describe("the Shopify callback only ever talks to a Shopify host", () => {
  it("refuses a shop that is not a myshopify.com domain instead of posting the client secret to it", async () => {
    const u = await newUser("shop");
    const exchange = vi.fn();
    vi.doMock("@/lib/connectors/oauth", () => ({ exchangeCode: exchange, REDIRECT: (id: string) => `https://nashr.test/api/connect/${id}/callback` }));
    await saveState("st-evil", { email: u.email, provider: "shopify", lang: "ar", shop: "evil.example", verifier: "" });
    const res = await callbackRoute.GET(new Request("https://nashr.test/api/connect/shopify/callback?state=st-evil&code=c"), params({ provider: "shopify" }));
    expect(res.headers.get("location")).toContain("error=bad_shop");
    expect(exchange).not.toHaveBeenCalled();
    expect(await listConnections(u.email)).toEqual([]);
  });
});

describe("the admin cookie is compared like a secret", () => {
  it("accepts only the exact key, and a prefix of it is not enough", async () => {
    const prev = process.env.WAITLIST_ADMIN_KEY;
    process.env.WAITLIST_ADMIN_KEY = "s3cret-admin-key";
    try {
      const { jar } = await import("./helpers/session");
      jar().clear();
      jar().set("nashr_admin", "s3cret-admin-ke");
      expect(await isAdminCookie()).toBe(false);
      jar().set("nashr_admin", "s3cret-admin-key");
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
