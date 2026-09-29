import { describe, expect, it } from "vitest";
import { json, newUser, signIn } from "./helpers/session";
import { getTask, listTasks, pendingCount, saveBrand, type Brand } from "@/lib/brand";
import { getUser } from "@/lib/auth";
import { createMcpToken } from "@/lib/mcp";
import { saveGov } from "@/lib/governance";
import { saveBrands, scopeFor, setActiveBrand } from "@/lib/brands";
import { DRAFTS_PER_HOUR } from "@/lib/rate";
import { DRAFT_LIMITS, parseDraft } from "@/lib/external-drafts";
import * as mcpRoute from "@/app/api/mcp/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";

const BRAND: Brand = { name: "محمصة ريف", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "دافئ", products: "قهوة", audience: "محبو القهوة", offers: "", competitors: "", banned: "مضمون، cheap", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29" };

const rpc = (method: string, p: Record<string, unknown>, token?: string) =>
  new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: p }) });
const call = (args: Record<string, unknown>, token?: string) => mcpRoute.POST(rpc("tools/call", { name: "save_draft", arguments: args }, token));
type Result = { result: { isError?: boolean; content: { text: string }[] } };
const result = async (res: Response) => ((await res.json()) as Result).result;
const report = async (res: Response) => JSON.parse((await result(res)).content[0].text);

async function owner(prefix = "draft") {
  const u = await newUser(prefix);
  await saveBrand(u.email, BRAND);
  return { u, token: await createMcpToken(u.email) };
}

describe("MCP save_draft: the owner's own assistant saves into the inbox (rules 116-120)", () => {
  it("is listed, and refuses without a bearer token (401) or with an unknown one, saving nothing", async () => {
    const list = await (await mcpRoute.POST(rpc("tools/list", {}))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("save_draft");
    expect((await call({ type: "social", body: "قهوة طازجة" })).status).toBe(401);
    expect((await call({ type: "social", body: "قهوة طازجة" }, "nashr_notarealtoken")).status).toBe(401);
  });

  it("saves one pending item with source external in the caller's scope, and charges nothing", async () => {
    const { u, token } = await owner();
    const before = (await getUser(u.email))!.credits;
    const r = await report(await call({ type: "social", channel: "Instagram", title: "  كوب الصباح ", body: "قهوة طازجة من المحمصة كل صباح", notes: "for the weekend" }, token));
    expect(r).toMatchObject({ saved: true, status: "pending", type: "social", channel: "instagram", title: "كوب الصباح", credits: 0 });
    expect(r.brandCheck.pass).toBe(true);
    const t = await getTask(u.email, r.id);
    expect(t).toMatchObject({ status: "pending", source: "external", type: "social", channel: "instagram", body: "قهوة طازجة من المحمصة كل صباح", brief: "for the weekend", lang: "ar" });
    expect(await pendingCount(u.email)).toBe(1);
    expect((await getUser(u.email))!.credits).toBe(before);
  });

  it("is never auto-approved, even when the owner auto-approves that type", async () => {
    const { u, token } = await owner();
    await saveGov(u.email, { autoApprove: { social: true } });
    const r = await report(await call({ type: "social", body: "قهوة طازجة" }, token));
    expect(r.status).toBe("pending");
    expect((await getTask(u.email, r.id))!.status).toBe("pending");
  });

  it("writes only to the bearer's own active brand: scope, email or id in the arguments are ignored", async () => {
    const a = await owner("drafta");
    const b = await owner("draftb");
    const r = await report(await call({ type: "social", body: "قهوة طازجة", scope: b.u.email, email: b.u.email, owner: b.u.email, id: "fixed" }, a.token));
    expect(r.id).not.toBe("fixed");
    expect(await getTask(a.u.email, r.id)).not.toBeNull();
    expect(await getTask(b.u.email, r.id)).toBeNull();
    expect(await listTasks(b.u.email)).toHaveLength(0);

    // A second brand active: the draft goes to that brand, not the account's default one.
    await saveBrands(a.u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
    await saveBrand(scopeFor(a.u.email, "b2"), { ...BRAND, name: "Two" });
    await setActiveBrand(a.u.email, "b2");
    const r2 = await report(await call({ type: "social", body: "قهوة طازجة" }, a.token));
    expect(await getTask(scopeFor(a.u.email, "b2"), r2.id)).not.toBeNull();
    expect(await getTask(a.u.email, r2.id)).toBeNull();
  });

  it("runs the brand gate in code: a banned word is saved held, named in the answer, and cannot be approved", async () => {
    const { u, token } = await owner();
    await saveGov(u.email, { autoApprove: { social: true } });
    const r = await report(await call({ type: "social", body: "نتيجة مضمونة من أول كوب" }, token));
    expect(r.status).toBe("pending");
    expect(r.brandCheck.pass).toBe(false);
    expect(r.brandCheck.violations[0].term).toBe("مضمون");
    expect(r.next).toMatch(/cannot approve/);
    // The same gate the approve button uses holds it.
    await signIn(u.email);
    const res = await taskRoute.PATCH(json(`/api/tasks/${r.id}`, "PATCH", { status: "approved" }), { params: Promise.resolve({ id: r.id }) });
    expect(res.status).toBe(409);
    expect((await getTask(u.email, r.id))!.status).toBe("pending");
    // The title is checked too, and an internal document may quote the word.
    expect((await report(await call({ type: "ads", title: "cheap coffee", body: "قهوة طازجة" }, token))).brandCheck.pass).toBe(false);
    expect((await report(await call({ type: "strategy_review", body: "لا تقل مضمون في الإعلانات" }, token))).brandCheck.pass).toBe(true);
  });

  it("rejects bad input and saves nothing", async () => {
    const { u, token } = await owner();
    const bad = [
      {},
      { type: "constructor", body: "x" },
      { type: "hacker", body: "x" },
      { type: "social" },
      { type: "social", body: "   \u0000​  " },
      { type: "social", body: 42 },
      { type: "social", body: "x".repeat(DRAFT_LIMITS.body + 1) },
      { type: "social", body: "x", title: "t".repeat(DRAFT_LIMITS.title + 1) },
      { type: "social", body: "x", notes: "n".repeat(DRAFT_LIMITS.notes + 1) },
      { type: "social", body: "x", channel: "../../etc" },
      { type: "social", body: "x", channel: "<script>" },
      { type: "social", body: "x", lang: "fr" },
    ];
    for (const args of bad) {
      const res = await result(await call(args, token));
      expect(res.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    }
    expect(await listTasks(u.email)).toHaveLength(0);
  });

  it("strips control and direction-override characters and defaults the title and channel", () => {
    const p = parseDraft({ type: "article", body: "‮عنوان\r\nنص\u0007 المقال" });
    expect(p.ok && p.draft).toEqual({ type: "article", channel: "article", title: "عنوان", body: "عنوان\nنص المقال" });
  });

  it("refuses without a brand file, saving nothing", async () => {
    const u = await newUser("nobrand");
    const token = await createMcpToken(u.email);
    expect((await result(await call({ type: "social", body: "قهوة" }, token))).isError).toBe(true);
    expect(await listTasks(u.email)).toHaveLength(0);
  });

  it(`stops at ${DRAFTS_PER_HOUR} drafts an hour per account, across its brands`, async () => {
    const { u, token } = await owner("draftrate");
    for (let i = 0; i < DRAFTS_PER_HOUR; i++) expect((await result(await call({ type: "social", body: `قهوة ${i}` }, token))).isError).toBeUndefined();
    const over = await result(await call({ type: "social", body: "قهوة أخرى" }, token));
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toMatch(/Too many drafts/);
    expect(await pendingCount(u.email)).toBe(DRAFTS_PER_HOUR);
    // Switching brand does not reset the allowance.
    await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
    await saveBrand(scopeFor(u.email, "b2"), BRAND);
    await setActiveBrand(u.email, "b2");
    expect((await result(await call({ type: "social", body: "قهوة" }, token))).isError).toBe(true);
    expect(await listTasks(scopeFor(u.email, "b2"))).toHaveLength(0);
  });
});
