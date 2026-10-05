import { describe, expect, it, vi } from "vitest";
import { newUser, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { PROVIDERS } from "@/lib/connectors/registry";
import { copyOnlyNote, targetsFor } from "@/lib/connectors/targets";
import { appDict } from "@/lib/app-i18n";
import { saveConnection } from "@/lib/connectors/store";
import { getTask, saveTask, type Task } from "@/lib/brand";

// Rule 628: Salla has no article API, so an article is never sent to a Salla store; the inbox says so.
vi.mock("dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

const article = (over: Partial<Task> = {}) => ({ type: "article", channel: "blog", title: "t", body: "b", ...over }) as Task;

describe("Salla articles (rule 628)", () => {
  it("the registry lists Salla without publish_article", () => {
    const salla = PROVIDERS.find((p) => p.id === "salla")!;
    expect(salla.capabilities).toEqual(["products", "orders"]);
    expect(salla.capabilities).not.toContain("publish_article");
  });

  it("targetsFor never offers Salla for any item", () => {
    for (const type of ["article", "social", "gbp", "whatsapp", "cart_recovery"] as const) {
      expect(targetsFor(article({ type }), ["salla"])).toEqual([]);
    }
    // Other stores keep their article targets.
    expect(targetsFor(article(), ["salla", "wordpress", "shopify"])).toEqual(["wordpress", "shopify"]);
  });

  it("the note shows for an article when Salla is connected, and only then", () => {
    expect(copyOnlyNote(article(), ["salla"])).toBe(true);
    expect(copyOnlyNote(article(), ["salla", "wordpress"])).toBe(true);
    expect(copyOnlyNote(article(), ["wordpress"])).toBe(false);
    expect(copyOnlyNote(article({ type: "social" }), ["salla"])).toBe(false);
  });

  it("the note is written in both languages and says nothing is sent", () => {
    expect(appDict.ar.inbox.sallaArticle).toMatch(/سلة/);
    expect(appDict.ar.inbox.sallaArticle).toMatch(/انسخ/);
    expect(appDict.en.inbox.sallaArticle).toMatch(/Salla/);
    expect(appDict.en.inbox.sallaArticle).toMatch(/nothing is sent/i);
  });

  it("the publish route refuses Salla for an article and sends nothing", async () => {
    const { POST } = await import("@/app/api/publish/[id]/route");
    const u = await newUser("salla");
    await signIn(u.email);
    await saveConnection(u.email, { provider: "salla", data: { access_token: "x" }, meta: {}, connectedAt: new Date().toISOString() });
    const t: Task = { id: "art1", type: "article", channel: "blog", title: "مقال", body: "نص المقال", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(u.email, t);
    const fetchSpy = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetchSpy as never;
    const r = await POST(await vjson(`/api/publish/${t.id}`, "POST", { provider: "salla" }), { params: Promise.resolve({ id: t.id }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("wrong_target");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getTask(u.email, t.id))?.published ?? []).toEqual([]);
  });
});
