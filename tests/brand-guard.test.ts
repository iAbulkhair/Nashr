import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { newUser, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { acct, currentUser } from "@/lib/auth";
import { getTask, saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { bannedTerms, brandRules, checkText, gateTask, initialStatus } from "@/lib/brand-rules";
import { saveConnection } from "@/lib/connectors/store";
import { createMcpToken } from "@/lib/mcp";
import { runTool } from "@/lib/chat";
import { computeJourney, decisionStreak, levelFor } from "@/lib/journey";

const published: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: Task, provider: string) => { published.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as mcpRoute from "@/app/api/mcp/route";

const BRAND: Brand = { name: "محمصة ريف", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "دافئ", products: "قهوة", audience: "محبو القهوة", offers: "", competitors: "", banned: "مضمون، الأفضل في المملكة, cheap; رخيص", preferred: "محمّص طازج", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-28" };
const task = (id: string, body: string, status: Task["status"] = "pending", type: Task["type"] = "social"): Task => ({ id, type, channel: "instagram", title: id, body, status, createdAt: new Date().toISOString(), lang: "ar" });
const hits = (text: string, banned = BRAND.banned) => checkText(brandRules({ banned }), text).map((v) => v.term);

describe("brand rules: the banned list as code (rule 77)", () => {
  it("splits on Arabic and Latin commas, semicolons and new lines, and drops duplicates and single letters", () => {
    expect(bannedTerms("مضمون، الأفضل, cheap; رخيص\nx\nمضمون")).toEqual(["مضمون", "الأفضل", "cheap", "رخيص"]);
    expect(bannedTerms(undefined)).toEqual([]);
  });

  it("matches Arabic through prefixes, suffixes, diacritics and alef forms", () => {
    expect(hits("قهوتنا بالأفضل في المملكة")).toEqual(["الأفضل في المملكة"]);
    expect(hits("نتيجة مَضْمونة من أول كوب")).toEqual(["مضمون"]);
    expect(hits("وأرخص سعر", "أرخص")).toEqual(["أرخص"]);
    expect(hits("بالافضل دائماً", "الأفضل")).toEqual(["الأفضل"]);
    expect(hits("والرخيص غالي")).toEqual(["رخيص"]);
  });

  it("does not fire inside an unrelated word", () => {
    expect(hits("حصلنا على ترخيص وزارة التجارة")).toEqual([]); // "ترخيص" (licence) contains "رخيص" (cheap)
    expect(hits("our cheapest bag", "cheap")).toEqual([]); // a Latin term must stand alone
    expect(hits("Cheap flights", "cheap")).toEqual(["cheap"]);
    expect(hits("بعد العمل", "عد")).toEqual([]); // a two-letter Arabic term only as a whole word
  });

  it("quotes the original text around the match, not the folded one", () => {
    const [v] = checkText(brandRules(BRAND), "جرّب قهوتنا، النتيجة مَضْمونة 100٪ لكل من يحضّرها في البيت");
    expect(v.excerpt).toContain("مَضْمونة");
    expect(v.ruleId).toBe("banned:مضمون");
  });

  it("holds customer-facing copy only, and checks the edited text and the title", () => {
    expect(gateTask(BRAND, task("a", "كلام عادي"))).toEqual([]);
    expect(gateTask(BRAND, { ...task("a", "كلام عادي"), editedBody: "نتيجة مضمونة" })).toHaveLength(1);
    expect(gateTask(BRAND, { ...task("a", "كلام عادي"), title: "الأفضل في المملكة" })).toHaveLength(1);
    expect(gateTask(BRAND, task("a", "لا تقل مضمون أبداً", "pending", "strategy_review"))).toEqual([]);
  });

  it("auto-approval never skips the gate", () => {
    expect(initialStatus(true, BRAND, task("a", "قهوة طازجة"))).toBe("approved");
    expect(initialStatus(true, BRAND, task("a", "قهوة مضمونة"))).toBe("pending");
    expect(initialStatus(false, BRAND, task("a", "قهوة طازجة"))).toBe("pending");
  });

  it("every path that creates a task decides its status through initialStatus", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
    const direct = walk("src").filter((p) => /autoApprove(\[type\]|\.\w+) \? "approved"/.test(readFileSync(p, "utf8")));
    expect(direct).toEqual([]);
  });
});

describe("the approve and publish routes enforce the brand rules in code (rule 78)", () => {
  const patch = async (id: string, body: unknown) => taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });

  it("refuses to approve an item that breaks a rule, and saves nothing", async () => {
    const u = await newUser("guard");
    await signIn(u.email);
    await saveBrand(acct(u), BRAND);
    await saveTask(acct(u), task("bad", "قهوة مضمونة"), true);
    const res = await patch("bad", { status: "approved" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toBe("brand_violation");
    expect(j.violations[0].term).toBe("مضمون");
    expect((await getTask(acct(u), "bad"))!.status).toBe("pending");
  });

  it("approves once the owner's edit removes the word, and refuses an edit that adds one to an approved item", async () => {
    const u = await newUser("guard");
    await signIn(u.email);
    await saveBrand(acct(u), BRAND);
    await saveTask(acct(u), task("fix", "قهوة مضمونة"), true);
    expect((await patch("fix", { editedBody: "قهوة محمّصة طازج", status: "approved" })).status).toBe(200);
    expect((await getTask(acct(u), "fix"))!.status).toBe("approved");
    expect((await patch("fix", { editedBody: "أرخص قهوة، رخيص جداً" })).status).toBe(409);
    expect((await getTask(acct(u), "fix"))!.editedBody).toBe("قهوة محمّصة طازج");
    // Saving the draft as pending is allowed: the rule holds approval, not the owner's own editing.
    expect((await patch("fix", { editedBody: "قهوة رخيص", status: "pending" })).status).toBe(200);
  });

  it("the publish route and the chat tool refuse an item that breaks a rule, even one approved before the rule existed", async () => {
    published.length = 0;
    const u = await newUser("guard");
    await signIn(u.email);
    await saveBrand(acct(u), BRAND);
    await saveConnection(acct(u), { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(acct(u), { ...task("old", "أفضل قهوة وأرخص... رخيص", "approved"), decidedAt: new Date().toISOString() }, true);
    const res = await publishRoute.POST(await vjson("/api/publish/old", "POST", { provider: "telegram" }), { params: Promise.resolve({ id: "old" }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("brand_violation");
    expect(await runTool((await currentUser())!, "publish_item", { task_id: "old", provider: "telegram" }, [])).toMatch(/Not published.*رخيص/);
    expect(published).toEqual([]);
    await saveTask(acct(u), task("clean", "قهوة طازجة من المحمصة", "approved"), true);
    expect((await publishRoute.POST(await vjson("/api/publish/clean", "POST", { provider: "telegram" }), { params: Promise.resolve({ id: "clean" }) })).status).toBe(200);
    expect(published).toEqual(["clean"]);
  });
});

describe("MCP brand tools (rule 79)", () => {
  const rpc = (method: string, p: Record<string, unknown>, token?: string) =>
    new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: p }) });
  const call = async (name: string, args: Record<string, unknown>, token?: string) => mcpRoute.POST(rpc("tools/call", { name, arguments: args }, token));
  const body = async (res: Response) => JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text);

  it("lists both tools, and neither answers without a token", async () => {
    const list = await (await mcpRoute.POST(rpc("tools/list", {}))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["get_brand_rules", "check_brand"]));
    expect((await call("check_brand", { text: "x" })).status).toBe(401);
    expect((await call("get_brand_rules", {})).status).toBe(401);
  });

  it("returns the caller's own rules and checks with the same code as the approve button", async () => {
    const u = await newUser("mcpguard");
    await saveBrand(acct(u), BRAND);
    const token = await createMcpToken(acct(u));
    const rules = await body(await call("get_brand_rules", {}, token));
    expect(rules.brand).toBe("محمصة ريف");
    expect(rules.enforced.map((r: { term: string }) => r.term)).toEqual(["مضمون", "الأفضل في المملكة", "cheap", "رخيص"]);
    const bad = await body(await call("check_brand", { text: "قهوة مضمونة للجميع" }, token));
    expect(bad.pass).toBe(false);
    expect(bad.violations[0].term).toBe("مضمون");
    expect((await body(await call("check_brand", { text: "قهوة طازجة" }, token))).pass).toBe(true);
    expect((await body(await call("check_brand", { text: "لا تقل مضمون", type: "strategy_review" }, token))).pass).toBe(true);
  });

  it("another account's token sees its own brand, never this one", async () => {
    const a = await newUser("mcpguard");
    await saveBrand(acct(a), BRAND);
    const b = await newUser("mcpguard");
    const token = await createMcpToken(acct(b));
    const res = await call("get_brand_rules", {}, token);
    expect((await res.json()).result.isError).toBe(true);
  });
});

describe("launch journey (rule 80)", () => {
  const base = { hasBrand: true, bannedWords: 0, tasks: [], connections: 0, aiLinked: false, today: "2026-09-28" };
  it("reads milestones from the workspace, and an auto-approved item is not the owner's first approval", () => {
    expect(computeJourney({ ...base, hasBrand: false }).done).toBe(0);
    const auto = computeJourney({ ...base, tasks: [{ status: "approved", published: 0 }] });
    expect(auto.milestones.find((m) => m.id === "approve")!.done).toBe(false);
    const owner = computeJourney({ ...base, bannedWords: 2, tasks: [{ status: "approved", decidedAt: "2026-09-28T10:00:00Z", scheduledFor: "2026-10-01", published: 1 }], connections: 1, aiLinked: true });
    expect(owner.done).toBe(7);
    expect(owner.level).toBe("oasis");
    expect(owner.next).toBeNull();
    expect(owner.points).toBe(owner.maxPoints);
  });
  it("levels grow seed, sapling, palm, oasis", () => {
    expect([0, 1, 2, 3, 4, 6, 7].map((n) => levelFor(n).level)).toEqual(["seed", "seed", "sapling", "sapling", "palm", "palm", "oasis"]);
    expect(levelFor(3)).toEqual({ level: "sapling", nextAt: 4, nextLevel: "palm" });
    expect(levelFor(7).nextAt).toBeNull();
  });
  it("the streak counts consecutive decision days ending today or yesterday, in UTC", () => {
    expect(decisionStreak(["2026-09-28T01:00:00Z", "2026-09-27T23:00:00Z", "2026-09-26T08:00:00Z", "2026-09-24T08:00:00Z"], "2026-09-28")).toBe(3);
    expect(decisionStreak(["2026-09-27T08:00:00Z", "2026-09-26T08:00:00Z"], "2026-09-28")).toBe(2);
    expect(decisionStreak(["2026-09-25T08:00:00Z", undefined], "2026-09-28")).toBe(0);
  });
});
