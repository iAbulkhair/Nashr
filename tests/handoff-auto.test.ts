import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { claudeOn } from "./helpers/model";
import { json, newMember, newUser, settle, signIn, signOut } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { CAPS, db } from "@/lib/db";
import { isAutonomous, listLite, listTasks, saveTask, type Brand, type Task } from "@/lib/brand";
import { agentById, agentForTask, type AgentId } from "@/lib/agents";
import { TASK_COST, TASK_COUNT, type TaskType } from "@/lib/tasks";
import { agentSpendFor } from "@/lib/credits";
import { listActivity } from "@/lib/activity";
import { listNotifs } from "@/lib/notifications";
import { DEFAULT_GOV, GovRefusedError, HANDOFF_AGENTS, getGov, govDiff, govRefusal, hasHandoffCap, listGovHistory, restorePatch, saveGov, type Governance } from "@/lib/governance";
import { saveSchedule, runWeekly } from "@/lib/schedule";
import { wipeAccount } from "@/lib/account";
import { addBrand, scopeFor } from "@/lib/brands";
import { runTool } from "@/lib/chat";
import { AUTO_HANDOFF_MAX_AGE_DAYS, AUTO_HANDOFF_MAX_CREDITS, AUTO_HANDOFF_MAX_ITEMS, HANDOFF_TYPES, autoBlock, autoItems, autoUnderFloor, createHandoff, getHandoff, handoffKeys, handoffView, markShown, proposalText, type Handoff, type HandoffView } from "@/lib/handoffs";
import { AUTO_HANDOFF_CRON_ID, AUTO_HANDOFF_MAX_UNSETTLED, AUTO_HANDOFF_SCAN, autoQueue, dueHandoffs } from "@/lib/handoff-auto";
import { deleteConversation } from "@/lib/conversations";
import { leadBriefBlock } from "@/lib/json";
import type { By } from "@/lib/actor";
import { appDict } from "@/lib/app-i18n";
import { CHANGELOG } from "@/lib/changelog";
import { HELP } from "@/lib/help";
import { estimateBatch } from "@/lib/task-costs";
import { maxCostPerCreditUsd } from "@/lib/pricing";
import * as govRoute from "@/app/api/governance/route";
import * as rollbackRoute from "@/app/api/governance/rollback/route";
import GovPage from "@/app/[lang]/app/b/[brand]/settings/governance/page";
import InboxPage from "@/app/[lang]/app/b/[brand]/page";
import ActivityPage from "@/app/[lang]/app/b/[brand]/activity/page";
import { HandoffCard } from "@/components/app/ChatPanel";

/**
 * Rules 283-292: Majed's auto-run (step 3b, part O item 5). The Governance switch is off by default and can be on only
 * with a cap on an agent Majed hands work to, and only with an explicit confirmation (283); the page shows it truly
 * (284); the cron finds at most one item per brand without scanning everything (285); every guard, checked under the
 * handoff's lock, leaves the item and the credits alone (286); a run charges the agent under its cap, keeps every task
 * pending, tells the owner once and logs itself as the system's `auto_handoff` job (287); a failure is refunded and the
 * item is left to the owner (288); `isAutonomous` is the one test the weekly cap and Dana's routine use, and MCP drafts
 * are not autonomous (289); the chat reply, the card and the inbox never say "nothing runs" when it may, and only a
 * proposal whose card reached the thread is ever eligible (290); the cron route runs one item per brand a day, and every
 * item needs 180 s of the invocation left (291); the wipe (292); the Governance page lists what may start, with
 * Decline (295); and it never starts a type whose batch breaks the 60% margin floor on the cold cache its cron usually
 * finds (296).
 */

// Client components read the router; outside Next there is none. Server-only helpers (redirect, notFound) stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app",
  useSearchParams: () => new URLSearchParams(),
}));

// Since rule 901 every handoff type keeps the floor cold, so the floor guard is tested against a lower ceiling: while
// `floor.tight` is set, `maxCostPerCreditUsd()` (called with no arguments, as `autoUnderFloor` calls it) returns it.
const floor = vi.hoisted(() => ({ tight: null as number | null }));
vi.mock("@/lib/pricing", async (orig) => {
  const real = await orig<typeof import("@/lib/pricing")>();
  return { ...real, maxCostPerCreditUsd: (...a: Parameters<typeof real.maxCostPerCreditUsd>) => (a.length === 0 && floor.tight !== null ? floor.tight : real.maxCostPerCreditUsd(...a)) };
});
/** Just under article's cold cost: article (and any type as dear) fails the floor, everything cheaper keeps it. */
const tighten = () => { floor.tight = estimateBatch("article", { cache: "cold" }).usdPerCredit - 1e-6; };
afterEach(() => { floor.tight = null; });

const brand: Brand = { name: "متجر العود", website: "", industry: "متجر إلكتروني", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "عود وبخور", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const en = appDict.en, ar = appDict.ar;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const CONV = "abc123def456";
const DAY = 864e5;
/** Layan's types: a one-item batch each, not cross-reviewed, no store data needed. */
const PRD_AGENT = agentForTask("prd").id;
const ONE = [{ type: "prd" as TaskType, brief: "مواصفة لصفحة الاشتراك" }];
const TWO = [...ONE, { type: "roadmap" as TaskType, brief: "خارطة طريق للربع" }];
const LATE = () => Date.now() + 300_000;

async function owner(prefix: string, credits?: number): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, brand);
  if (credits !== undefined) await saveUser({ ...(await getUser(u.email))!, credits });
  return (await getUser(u.email))!;
}
const ownerBy = (u: User): By => ({ kind: "owner", email: u.email });
/** The conversation a card sits in, stored as `createConversation` stores one (the auto-run checks it still exists). */
const thread = (scope: string, id: string) => db.set(`conv:${scope}:${id}`, { id, title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 2, agent: "majed" });
/**
 * An owner with the switch on and a cap on Layan, and one proposal made in chat by the owner (or `by`), in a thread that
 * exists, whose reply with the card was saved (chat() marks it shown, rule 290).
 */
async function eligible(prefix: string, o: { items?: { type: TaskType; brief: string }[]; by?: (u: User) => By; caps?: Partial<Record<AgentId, number>>; credits?: number; origin?: "web_chat" | "mcp" } = {}) {
  const u = await owner(prefix, o.credits);
  await Promise.all([saveGov(u.email, { majedAutoHandoff: true, agentCaps: o.caps ?? { [PRD_AGENT]: 20 } }), thread(u.email, CONV)]);
  const created = await createHandoff(u.email, { proposal: { items: o.items ?? ONE }, requestedBy: o.by ? o.by(u) : ownerBy(u), origin: o.origin ?? "web_chat", conv: CONV, ownerMsg: "أبغى نطلق الاشتراك" });
  expect(await markShown(u.email, created.id)).toBe(true);
  return { u: (await getUser(u.email))!, h: (await getHandoff(u.email, created.id))! };
}
/** Change the stored record directly (a state no route writes on purpose: an old proposal, a run that died). */
const rewrite = async (scope: string, h: Handoff, f: (h: Handoff) => Handoff) => db.set(`handoff:${scope}:${h.id}`, f((await getHandoff(scope, h.id))!));
const credits = async (email: string) => (await getUser(email))!.credits;
const rows = async (scope: string) => (await listActivity(scope, { limit: CAPS.activity })).rows;
const statuses = async (scope: string, id: string) => (await getHandoff(scope, id))!.items.map((i) => i.status);

type Params = { system: string | { text: string }[]; messages: { role: string; content: unknown }[] };
const reply = (text: string) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
/**
 * The SDK, replaced and counted, with Claude "on" (or paused). `made` counts clients, so "no model call" is a number;
 * `prompts` holds each generation's user message and `judge` each judge's.
 */
function sdk(o: { state?: "on" | "paused"; genFails?: boolean; hang?: { on: boolean } } = {}) {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  if (o.state === "paused") vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));
  else claudeOn();
  const seen = { made: 0, prompts: [] as string[], judge: [] as string[] };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() { seen.made++; }
      beta = { messages: { stream: (p: Params) => ({ finalMessage: async () => { seen.prompts.push(String(p.messages[0].content)); if (o.genFails) throw new Error("model down"); if (o.hang?.on) return new Promise<never>(() => {}); return reply(JSON.stringify([{ channel: "doc", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" }])); } }) } };
      messages = {
        chat: () => ({ finalMessage: async () => reply("تمام") }),
        create: async (p: Params) => {
          const sys = typeof p.system === "string" ? p.system : p.system[0].text;
          if (sys.startsWith("You are the quality judge")) seen.judge.push(String(p.messages[0].content));
          return reply(sys.startsWith("You are the quality judge") ? JSON.stringify([verdict]) : JSON.stringify([{ ok: true }]));
        },
        stream(p: { tools?: unknown; tool_choice?: unknown; output_config?: { format?: unknown } }, o?: unknown) { return (p.tools && !p.tool_choice) || p.output_config?.format ? (this.chat as (...a: unknown[]) => unknown)(p, o) : { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; },
      };
    },
  }));
  return seen;
}
const loadAuto = () => import("@/lib/handoff-auto");

afterEach(async () => {
  await settle();
  for (const m of ["@anthropic-ai/sdk", "@/lib/model"]) vi.doUnmock(m);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  signOut();
});

// ── Rule 283: the switch ─────────────────────────────────────────────────────────────────────────────────────────

describe("the Governance switch: off by default, a cap and a confirmation to turn on (rule 283)", () => {
  const put = async (body: unknown) => { const r = await govRoute.PUT(json("/api/governance", "PUT", body)); return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string; governance?: Governance; entry?: { id: string; changes: { path: string; before: unknown; after: unknown }[] } | null } }; };
  const restore = async (body: unknown) => { const r = await rollbackRoute.POST(json("/api/governance/rollback", "POST", body)); return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string; governance?: Governance } }; };

  it("is off by default and for a record saved before it existed; only a real boolean changes it", async () => {
    expect(DEFAULT_GOV.majedAutoHandoff).toBe(false);
    const u = await newUser("ha-default");
    await db.set(`gov:${u.email}`, { reviewer: false, weeklyCap: 5 });
    expect((await getGov(u.email)).majedAutoHandoff).toBe(false);
    await signIn(u.email);
    for (const v of ["true", 1, null, "on"]) {
      const r = await put({ majedAutoHandoff: v, confirmAutoHandoff: true, agentCaps: { [PRD_AGENT]: 5 } });
      expect(r.body.governance?.majedAutoHandoff, String(v)).toBe(false);
    }
    expect(govDiff(DEFAULT_GOV, { ...DEFAULT_GOV, majedAutoHandoff: true })).toEqual(["majedAutoHandoff"]);
  });

  it("the agents whose cap counts are the ones Majed hands work to: never Majed or Reem", () => {
    expect([...HANDOFF_AGENTS].sort()).toEqual([...new Set(HANDOFF_TYPES.map((t) => agentForTask(t).id))].sort());
    expect(HANDOFF_AGENTS).not.toContain("majed");
    expect(HANDOFF_AGENTS).not.toContain("reem");
    expect(hasHandoffCap({ agentCaps: {} })).toBe(false);
    expect(hasHandoffCap({ agentCaps: { majed: 50, reem: 10 } })).toBe(false);
    expect(hasHandoffCap({ agentCaps: { razan: 0 } }), "a cap of 0 is a cap").toBe(true);
    const on = { ...DEFAULT_GOV, majedAutoHandoff: true, agentCaps: { razan: 5 } };
    expect(govRefusal(DEFAULT_GOV, { ...on, agentCaps: {} }, true)).toBe("auto_handoff_needs_cap");
    expect(govRefusal(DEFAULT_GOV, on, false)).toBe("auto_handoff_confirm");
    expect(govRefusal(DEFAULT_GOV, on, true)).toBeNull();
    expect(govRefusal(on, on, false), "keeping it on needs no new confirmation").toBeNull();
    expect(govRefusal(on, { ...on, majedAutoHandoff: false, agentCaps: {} }, false), "off needs nothing").toBeNull();
  });

  it("saveGov (no login) throws the typed refusal and writes nothing without a cap", async () => {
    const u = await newUser("ha-savegov");
    await expect(saveGov(u.email, { majedAutoHandoff: true })).rejects.toThrow(GovRefusedError);
    await expect(saveGov(u.email, { majedAutoHandoff: true, agentCaps: { majed: 10 } })).rejects.toMatchObject({ code: "auto_handoff_needs_cap" });
    expect(await db.get(`gov:${u.email}`)).toBeNull();
    expect((await saveGov(u.email, { majedAutoHandoff: true, agentCaps: { razan: 10 } })).majedAutoHandoff).toBe(true);
    await expect(saveGov(u.email, { agentCaps: { razan: null } }), "the last cap cannot go while it is on").rejects.toMatchObject({ code: "auto_handoff_needs_cap" });
    expect((await getGov(u.email)).agentCaps).toEqual({ razan: 10 });
  });

  it("PUT: no cap is 400 needs_cap, no confirmation is 400 confirm, nothing written or recorded; with both it saves once", async () => {
    const u = await newUser("ha-put");
    await signIn(u.email);
    expect(await put({ majedAutoHandoff: true, confirmAutoHandoff: true })).toEqual({ status: 400, body: { ok: false, error: "auto_handoff_needs_cap" } });
    for (const flag of [undefined, false, "true", 1]) {
      expect(await put({ majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 }, confirmAutoHandoff: flag }), String(flag)).toEqual({ status: 400, body: { ok: false, error: "auto_handoff_confirm" } });
    }
    // Refused as a whole: the cap sent with it was not saved either.
    expect(await getGov(u.email)).toEqual(DEFAULT_GOV);
    expect(await listGovHistory(u.email)).toEqual([]);
    const on = await put({ majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 }, confirmAutoHandoff: true });
    expect(on.status).toBe(200);
    expect(on.body.governance).toMatchObject({ majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 } });
    expect(on.body.governance).not.toHaveProperty("confirmAutoHandoff");
    expect(await db.get(`gov:${u.email}`)).not.toHaveProperty("confirmAutoHandoff");
    expect(on.body.entry!.changes).toEqual([{ path: `agentCaps.${PRD_AGENT}`, before: null, after: 20 }, { path: "majedAutoHandoff", before: false, after: true }]);
    // Once on, other saves need no confirmation; the last cap cannot be removed while it is on; off needs nothing.
    expect((await put({ reviewer: false })).status).toBe(200);
    expect(await put({ agentCaps: { [PRD_AGENT]: null } })).toEqual({ status: 400, body: { ok: false, error: "auto_handoff_needs_cap" } });
    const off = await put({ majedAutoHandoff: false, agentCaps: { [PRD_AGENT]: null } });
    expect(off.status).toBe(200);
    expect(off.body.governance).toMatchObject({ majedAutoHandoff: false, agentCaps: {} });
    expect((await listGovHistory(u.email)).map((r) => r.changed)).toEqual([[`agentCaps.${PRD_AGENT}`, "majedAutoHandoff"], ["reviewer"], [`agentCaps.${PRD_AGENT}`, "majedAutoHandoff"]].reverse());
  });

  it("a restore that would switch it back on needs the same confirmation; one that switches it off does not", async () => {
    const u = await newUser("ha-restore");
    await signIn(u.email);
    const on = await put({ majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 }, confirmAutoHandoff: true });
    const off = await put({ majedAutoHandoff: false });
    expect(off.body.governance?.majedAutoHandoff).toBe(false);
    // Put back what was before "off": on.
    expect(await restore({ id: off.body.entry!.id })).toEqual({ status: 400, body: { ok: false, error: "auto_handoff_confirm" } });
    expect(await restore({ id: off.body.entry!.id, confirmAutoHandoff: "true" })).toEqual({ status: 400, body: { ok: false, error: "auto_handoff_confirm" } });
    expect((await getGov(u.email)).majedAutoHandoff).toBe(false);
    expect(await listGovHistory(u.email)).toHaveLength(2);
    const back = await restore({ id: off.body.entry!.id, confirmAutoHandoff: true });
    expect(back.status).toBe(200);
    expect(back.body.governance?.majedAutoHandoff).toBe(true);
    // Put back what was before "on": off, and no cap. No confirmation needed to switch it off.
    const undo = await restore({ id: on.body.entry!.id });
    expect(undo.status).toBe(200);
    expect(undo.body.governance).toMatchObject({ majedAutoHandoff: false, agentCaps: {} });
    // The full restore patch names it: an old snapshot without it restores it to off.
    expect(restorePatch({ reviewer: true } as Partial<Governance>).majedAutoHandoff).toBe(false);
    expect(restorePatch({ ...DEFAULT_GOV, majedAutoHandoff: true, agentCaps: { razan: 1 } }).majedAutoHandoff).toBe(true);
  });

  it("only the owner switches it: a member or admin is refused before anything is read", async () => {
    const u = await owner("ha-roles");
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(u, role);
      await signIn(m.email);
      expect((await put({ majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 }, confirmAutoHandoff: true })).status, role).toBe(403);
    }
    expect((await getGov(u.email)).majedAutoHandoff).toBe(false);
  });
});

// ── Rule 284: the page ───────────────────────────────────────────────────────────────────────────────────────────

describe("the Governance page shows the switch truly (rule 284)", () => {
  it("the switch, its words and the change in the history, in both languages; read-only for other roles", async () => {
    const u = await owner("ha-page");
    await signIn(u.email);
    await govRoute.PUT(json("/api/governance", "PUT", { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 }, confirmAutoHandoff: true }));
    const page = async (lang: "ar" | "en") => renderToStaticMarkup((await GovPage({ params: Promise.resolve({ lang }) })) as ReactElement);
    const html = await page("en");
    expect(html).toContain(`>${esc(en.governance.autoHandoff)}</h2>`);
    expect(html).toContain(esc(en.governance.autoHandoffSub));
    const row = html.slice(html.indexOf(esc(en.governance.autoHandoffSub)));
    expect(row).toMatch(/role="switch" aria-checked="true"/);
    // Every switch is named by its row's title, so a screen reader says what it turns on, not only "switch, on".
    expect(row).toContain(`role="switch" aria-checked="true" aria-label="${esc(en.governance.autoHandoff)}"`);
    const switches = html.match(/role="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBe(5);
    expect(switches.map((sw) => /aria-label="([^"]+)"/.exec(sw)?.[1])).toEqual([en.governance.reviewer, en.governance.crossReview, en.governance.learning, en.governance.noEmDash, en.governance.autoHandoff].map(esc));
    expect(await page("ar")).toContain(`aria-label="${ar.governance.autoHandoff}"`);
    const hist = html.slice(html.indexOf('id="gov-history"'));
    expect(hist).toMatch(new RegExp(`<span dir="auto">${esc(en.governance.autoHandoff)}</span>: <bdi>Off</bdi> → <bdi[^>]*>On</bdi>`));
    expect(await page("ar")).toContain(`>${ar.governance.autoHandoff}</h2>`);
    const m = await newMember(u, "admin");
    await signIn(m.email);
    const ro = await page("en");
    expect(ro).toContain("<fieldset disabled=\"\"");
    expect(ro.slice(ro.indexOf("<fieldset"), ro.indexOf("</fieldset>"))).toContain(esc(en.governance.autoHandoffSub));
  });

  it("the words match the code: the window, the ceiling and the time, in both languages; turning on asks first", () => {
    for (const s of [en.governance.autoHandoffSub, en.governance.autoHandoffConfirm, en.handoff.subAuto]) expect(s).toMatch(/06:00 UTC|7 days|once a day|one item a day/);
    expect(en.governance.autoHandoffSub).toContain(`last ${AUTO_HANDOFF_MAX_AGE_DAYS} days`);
    expect(en.governance.autoHandoffSub).toContain(`at most ${AUTO_HANDOFF_MAX_ITEMS} items and ${AUTO_HANDOFF_MAX_CREDITS} credits`);
    expect(en.governance.autoHandoffSub).toContain("06:00 UTC");
    expect(ar.governance.autoHandoffSub).toContain(`${AUTO_HANDOFF_MAX_AGE_DAYS} أيام`);
    expect(ar.governance.autoHandoffSub).toContain(`${AUTO_HANDOFF_MAX_ITEMS} بنود`);
    expect(ar.governance.autoHandoffSub).toContain(`${AUTO_HANDOFF_MAX_CREDITS} كريدت`);
    expect(ar.governance.autoHandoffSub).toContain("06:00");
    // The routines cron, where the auto-run runs, is daily at 06:00 UTC.
    expect(JSON.parse(readFileSync("crons.json", "utf8")).crons).toContainEqual({ path: "/api/cron/routines", schedule: "0 6 * * *" });
    for (const k of ["autoHandoff", "autoHandoffSub", "autoHandoffConfirm", "autoHandoffNeedsCap", "autoHandoffConfirmNeeded"] as const) {
      expect(en.governance[k], k).toBeTruthy();
      expect(ar.governance[k], k).toBeTruthy();
    }
    // The changelog names the same rule as the code: a cap on an agent Majed hands work to (a cap on Majed is refused).
    const entry = CHANGELOG.find((c) => c.title.en === "Opt-in auto-run for handoffs")!;
    expect(entry.desc.en).toContain("a monthly cap on at least one agent Majed hands work to");
    expect(entry.desc.ar).toContain("حداً شهرياً لوكيل واحد على الأقل ممن يسلّمهم ماجد العمل");
    const panel = readFileSync("src/components/app/GovernancePanel.tsx", "utf8");
    // Turning it on asks first, in the app's confirmation dialog (rule 697), with the words above.
    expect(panel).toMatch(/if \(on && !\(await askAutoHandoff\(\)\)\) return;/);
    expect(panel).toContain("const askAutoHandoff = () => ask({ title: g.autoHandoff, message: g.autoHandoffConfirm,");
    expect(panel).toContain("confirmAutoHandoff: true");
    expect(panel).toContain('code === "auto_handoff_needs_cap" ? g.autoHandoffNeedsCap');
  });
});

// ── Rule 285: finding candidates ─────────────────────────────────────────────────────────────────────────────────

describe("the cron finds at most one item per brand, only where the switch is on (rule 285)", () => {
  it("off, no cap, a member's proposal, an old one: nothing; else the oldest open item whose agent has a cap", async () => {
    const off = await owner("ha-due-off");
    await createHandoff(off.email, { proposal: { items: ONE }, requestedBy: ownerBy(off), origin: "web_chat", ownerMsg: "m" });
    const mem = await eligible("ha-due-member", { by: () => ({ kind: "member", email: "sara@team.example", role: "member" }) });
    const { u, h: first } = await eligible("ha-due", { items: [{ type: "pricing_review", brief: "b" }, ...ONE] });
    const second = await createHandoff(u.email, { proposal: { items: ONE }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" });
    await markShown(u.email, second.id);
    const due = await dueHandoffs([off, mem.u, u]);
    // Razan has no cap, so the first proposal's item 0 is left for the owner and its item 1 (Layan's) is picked.
    expect(due.map((d) => ({ email: d.user.email, id: d.id, item: d.item }))).toEqual([{ email: u.email, id: first.id, item: 1 }]);
    // Once that item has run, the next candidate is the newer proposal; a proposal older than the window is not one.
    await rewrite(u.email, first, (h) => ({ ...h, items: h.items.map((it, i) => (i === 1 ? { ...it, status: "done" } : it)) }));
    expect((await dueHandoffs([u])).map((d) => [d.id, d.item])).toEqual([[second.id, 0]]);
    await rewrite(u.email, second, (h) => ({ ...h, createdAt: new Date(Date.now() - (AUTO_HANDOFF_MAX_AGE_DAYS + 1) * DAY).toISOString() }));
    expect(await dueHandoffs([u])).toEqual([]);
  });

  it("reads only the newest proposals of a brand with the switch on, in two requests, and every brand in parallel", async () => {
    const { u, h: oldest } = await eligible("ha-due-scan");
    for (let i = 0; i < AUTO_HANDOFF_SCAN; i++) await createHandoff(u.email, { proposal: { items: [{ type: "pricing_review", brief: "b" }] }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" });
    // The eligible proposal is now 21st newest: past the scan, so it waits for the owner.
    expect(await dueHandoffs([u])).toEqual([]);
    const off = await owner("ha-due-scan-off");
    const spy = { lrange: vi.spyOn(db, "lrange"), mget: vi.spyOn(db, "mget") };
    await dueHandoffs([u, off]);
    expect(spy.lrange.mock.calls.map((c) => c[0])).toEqual([`handoffs:${u.email}`]);
    expect(spy.lrange.mock.calls[0].slice(1)).toEqual([0, AUTO_HANDOFF_SCAN - 1]);
    expect(spy.mget).toHaveBeenCalledTimes(1);
    expect(await getHandoff(u.email, oldest.id)).not.toBeNull();
    const src = readFileSync("src/lib/handoff-auto.ts", "utf8");
    expect(src).toMatch(/await pmap\(users,/);
  });
});

// ── Rule 286: every guard ────────────────────────────────────────────────────────────────────────────────────────

describe("every guard is checked in code under the lock, and leaves the item and the credits alone (rule 286)", () => {
  /** Nothing moved: the credits, the item, no task, no model client, the lock and the hold free. */
  async function untouched(u: User, h: Handoff, seen: { made: number }, before: number) {
    expect(await credits(u.email)).toBe(before);
    expect(await statuses(u.email, h.id)).toEqual(h.items.map(() => "proposed"));
    expect((await listLite(u.email)).filter((l) => l.source === "handoff")).toEqual([]);
    expect(seen.made).toBe(0);
    expect(await db.get(`handofflock:${u.email}:${h.id}`)).toBeNull();
    expect(await db.get(`handoffhold:${u.email}`)).toBeNull();
    expect(await db.get(`handofftry:${u.email}:${h.id}:0`) ?? 0).toBe(0);
  }

  it("switch off (read again under the lock), another origin, and a proposal by a member, support, a token or the system", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const a = await eligible("ha-g-off");
    await saveGov(a.u.email, { majedAutoHandoff: false });
    expect(await autoRunHandoff(a.u, a.h.id, 0, LATE())).toBe("skip:off");
    await untouched(a.u, a.h, seen, 50);
    const mcp = await eligible("ha-g-mcp", { origin: "mcp" });
    expect(await autoRunHandoff(mcp.u, mcp.h.id, 0, LATE())).toBe("skip:origin");
    await untouched(mcp.u, mcp.h, seen, 50);
    const who: ((u: User) => By)[] = [
      () => ({ kind: "member", email: "sara@team.example", role: "member" }),
      () => ({ kind: "member", email: "omar@team.example", role: "admin" }),
      (u) => ({ kind: "founder", email: u.email, imp: "founder@nashr.example" }),
      (u) => ({ kind: "token", email: u.email }),
      () => ({ kind: "system", job: "auto_handoff" }),
    ];
    for (const by of who) {
      const x = await eligible("ha-g-who", { by });
      expect(await autoRunHandoff(x.u, x.h.id, 0, LATE()), x.h.requestedBy.kind).toBe("skip:requester");
      await untouched(x.u, x.h, seen, 50);
    }
    // A record that is not Majed's is not a handoff at all; the rule is also pinned on its own.
    const n = await eligible("ha-g-agent");
    await db.set(`handoff:${n.u.email}:${n.h.id}`, { ...n.h, agent: "noor" });
    expect(await autoRunHandoff(n.u, n.h.id, 0, LATE())).toBe("skip:not_found");
    expect(autoBlock({ ...n.h, agent: "noor" as "majed" }, 0, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 5 } })).toBe("not_majed");
    expect(await autoRunHandoff(n.u, "../x", 0, LATE())).toBe("skip:not_found");
  });

  it("the owner has its card: never a proposal whose reply was not saved, or whose conversation was deleted", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const G = { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 5 } };
    // Saved by Majed's tool, but the reply that carries its card never reached the thread (the turn failed after it).
    const u = await owner("ha-g-unshown");
    await Promise.all([saveGov(u.email, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 } }), thread(u.email, CONV)]);
    const h = await createHandoff(u.email, { proposal: { items: ONE }, requestedBy: ownerBy(u), origin: "web_chat", conv: CONV, ownerMsg: "m" });
    expect(h.shownAt).toBeUndefined();
    expect(autoBlock(h, 0, G)).toBe("not_shown");
    expect(autoBlock({ ...h, shownAt: "" }, 0, G)).toBe("not_shown");
    expect(autoItems(h, G, Date.now(), { beforeCard: true }), "the tool's own reply, which carries the card").toEqual([0]);
    expect(await dueHandoffs([u])).toEqual([]);
    expect(await autoQueue(u.email, await getGov(u.email))).toEqual([]);
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe("skip:not_shown");
    await untouched(u, h, seen, 50);
    // Shown, then the owner deleted the conversation its card was in: no card left to decline it from.
    const x = await eligible("ha-g-thread");
    expect((await dueHandoffs([x.u])).map((d) => d.id)).toEqual([x.h.id]);
    await deleteConversation(x.u.email, CONV);
    expect(await dueHandoffs([x.u])).toEqual([]);
    expect(await autoQueue(x.u.email, await getGov(x.u.email))).toEqual([]);
    expect(await autoRunHandoff(x.u, x.h.id, 0, LATE())).toBe("skip:thread_gone");
    await untouched(x.u, x.h, seen, 50);
    expect(autoBlock(x.h, 0, G, Date.now(), { threadGone: true })).toBe("thread_gone");
    // The default thread cannot be deleted: a shown proposal made there is eligible.
    const d = await owner("ha-g-default");
    await saveGov(d.email, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 } });
    const dh = await createHandoff(d.email, { proposal: { items: ONE }, requestedBy: ownerBy(d), origin: "web_chat", ownerMsg: "m" });
    expect(await markShown(d.email, dh.id)).toBe(true);
    expect((await dueHandoffs([d])).map((c) => c.id)).toEqual([dh.id]);
    // A mark never brings back a record that is gone.
    expect(await markShown(d.email, "0123456789abcdef")).toBe(false);
    expect(await db.get(`handoff:${d.email}:0123456789abcdef`)).toBeNull();
  });

  it("an item that is not proposed, a proposal older than 7 days, no cap on the item's agent, over the ceiling", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    for (const status of ["done", "declined", "failed", "running"] as const) {
      const x = await eligible(`ha-g-${status}`);
      await rewrite(x.u.email, x.h, (h) => ({ ...h, items: [{ ...h.items[0], status, at: new Date().toISOString() }] }));
      expect(await autoRunHandoff(x.u, x.h.id, 0, LATE()), status).toBe("skip:not_proposed");
      expect(await statuses(x.u.email, x.h.id)).toEqual([status]);
      expect(await credits(x.u.email)).toBe(50);
    }
    const old = await eligible("ha-g-old");
    await rewrite(old.u.email, old.h, (h) => ({ ...h, createdAt: new Date(Date.now() - AUTO_HANDOFF_MAX_AGE_DAYS * DAY - 60_000).toISOString() }));
    expect(await autoRunHandoff(old.u, old.h.id, 0, LATE())).toBe("skip:too_old");
    await untouched(old.u, old.h, seen, 50);
    expect(autoBlock({ ...old.h, createdAt: new Date(Date.now() - AUTO_HANDOFF_MAX_AGE_DAYS * DAY + 60_000).toISOString() }, 0, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 5 } }), "just inside the window").toBeNull();
    const nocap = await eligible("ha-g-nocap", { caps: { razan: 20 } });
    expect(await autoRunHandoff(nocap.u, nocap.h.id, 0, LATE())).toBe("skip:no_cap");
    await untouched(nocap.u, nocap.h, seen, 50);
    // An article, with a cap on its agent, against a ceiling it is over on a cold cache (rule 296).
    const art = await eligible("ha-g-floor", { items: [{ type: "article", brief: "مقال عن العود" }], caps: { [agentForTask("article").id]: 50 } });
    tighten();
    expect(await autoRunHandoff(art.u, art.h.id, 0, LATE())).toBe("skip:floor");
    floor.tight = null;
    await untouched(art.u, art.h, seen, 50);
    // social (10) + prd (4) = 14 credits, over the 12-credit ceiling; four items are over it whatever they cost.
    const big = await eligible("ha-g-ceiling", { items: [...ONE, { type: "social", brief: "منشورات" }], caps: { [PRD_AGENT]: 20, noor: 50 } });
    expect(TASK_COST.prd + TASK_COST.social).toBeGreaterThan(AUTO_HANDOFF_MAX_CREDITS);
    expect(await autoRunHandoff(big.u, big.h.id, 0, LATE())).toBe("skip:ceiling");
    await untouched(big.u, big.h, seen, 50);
    const four = { ...big.h, items: Array.from({ length: 4 }, () => ({ ...big.h.items[0], type: "okrs" as TaskType })) };
    expect(TASK_COST.okrs * 4).toBeLessThanOrEqual(AUTO_HANDOFF_MAX_CREDITS);
    expect(autoBlock(four, 0, { majedAutoHandoff: true, agentCaps: { majed: 5 } })).toBe("ceiling");
    expect(autoBlock(big.h, 5, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 5 } })).toBe("bad_item");
  });

  it("paused: retry, before any read or charge, the lock let go", async () => {
    const seen = sdk({ state: "paused" });
    const { autoRunHandoff } = await loadAuto();
    const x = await eligible("ha-g-paused");
    // The modules the auto-run loaded: nothing is read, counted or held once the lock is taken (generateBatch's own
    // paused refusal is only the backstop).
    const { db: store } = await import("@/lib/db");
    const spy = { get: vi.spyOn(store, "get"), incrby: vi.spyOn(store, "incrby"), set: vi.spyOn(store, "set") };
    expect(await autoRunHandoff(x.u, x.h.id, 0, LATE())).toBe("retry:paused");
    expect([spy.get, spy.incrby, spy.set].map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    await untouched(x.u, x.h, seen, 50);
  });

  it("no key (development mock): skip, nothing charged", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { autoRunHandoff } = await loadAuto();
    const x = await eligible("ha-g-mock");
    expect(await autoRunHandoff(x.u, x.h.id, 0, LATE())).toBe("skip:mock");
    await untouched(x.u, x.h, { made: 0 }, 50);
  });

  it("the weekly cap counts what was made on its own and the routines' holds; the auto-run's own hold is let go", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const x = await eligible("ha-g-weekly");
    await saveGov(x.u.email, { weeklyCap: 1 });
    await saveTask(x.u.email, { id: "s1", type: "weekly_plan", channel: "plan", title: "t", body: "b", status: "pending", createdAt: new Date().toISOString(), lang: "ar", source: "scheduled" }, true);
    expect(await autoRunHandoff(x.u, x.h.id, 0, LATE())).toBe("cap_reached");
    await untouched(x.u, x.h, seen, 50);
    const y = await eligible("ha-g-hold");
    await saveGov(y.u.email, { weeklyCap: TASK_COUNT.prd });
    await db.set(`routinehold:${y.u.email}:dana_weekly_report`, 1, 360);
    expect(await autoRunHandoff(y.u, y.h.id, 0, LATE())).toBe("cap_reached");
    await untouched(y.u, y.h, seen, 50);
  });

  it("the attempt counter, a run or decline holding the handoff, and too little of the invocation left", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const x = await eligible("ha-g-tries");
    await db.set(`handofftry:${x.u.email}:${x.h.id}:0`, AUTO_HANDOFF_MAX_UNSETTLED);
    expect(await autoRunHandoff(x.u, x.h.id, 0, LATE())).toBe("attempts_exhausted");
    expect(await credits(x.u.email)).toBe(50);
    expect(await statuses(x.u.email, x.h.id)).toEqual(["proposed"]);
    expect(await db.get(`handoffhold:${x.u.email}`)).toBeNull();
    const y = await eligible("ha-g-locked");
    await db.lock(`handofflock:${y.u.email}:${y.h.id}`, 60);
    expect(await autoRunHandoff(y.u, y.h.id, 0, LATE())).toBe("retry:locked");
    await db.unlock(`handofflock:${y.u.email}:${y.h.id}`);
    await untouched(y.u, y.h, seen, 50);
    const z = await eligible("ha-g-late");
    expect(await autoRunHandoff(z.u, z.h.id, 0, Date.now() + 1000)).toBe("retry:late");
    await untouched(z.u, z.h, seen, 50);
  });
});

// ── Rule 287: a run ──────────────────────────────────────────────────────────────────────────────────────────────

describe("a run: charged under the cap, every task pending, the owner told once, logged as the system's (rule 287)", () => {
  it("runs the item through the shared path as the system's auto_handoff job", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const { u, h } = await eligible("ha-run");
    // Even a type the owner auto-approves waits for the owner when the auto-run made it.
    await saveGov(u.email, { autoApprove: { prd: true } });
    const view0 = await handoffView(u.email, h);
    expect(view0.auto).toEqual([0]);
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe(`ok:${TASK_COUNT.prd}`);
    await settle();
    const tasks = (await listTasks(u.email)).filter((t) => t.source === "handoff");
    expect(tasks).toHaveLength(TASK_COUNT.prd);
    for (const t of tasks) {
      expect(t).toMatchObject({ type: "prd", status: "pending", parent: { handoff: h.id, item: 0, conv: CONV, auto: true } });
      expect(isAutonomous(t)).toBe(true);
    }
    const lite = (await listLite(u.email)).filter((l) => l.source === "handoff");
    expect(lite.map((l) => l.parent)).toEqual(tasks.map(() => ({ handoff: h.id, item: 0, conv: CONV, auto: true })));
    expect(lite.every(isAutonomous)).toBe(true);
    // Charged once, to the item's agent, under its cap. The brief went as the lead brief block.
    expect(await credits(u.email)).toBe(50 - TASK_COST.prd);
    expect(agentSpendFor((await getUser(u.email))!, u.email)).toEqual({ [PRD_AGENT]: TASK_COST.prd });
    expect(seen.prompts).toHaveLength(1);
    expect(seen.prompts[0]).toContain("<lead_brief>");
    // Through generateBatch to the judge too (rule 274): the same block, once, in the judge's message.
    expect(seen.judge).toHaveLength(1);
    expect(seen.judge[0].split(leadBriefBlock(ONE[0].brief)).length - 1).toBe(1);
    const system = { kind: "system", job: "auto_handoff" };
    const rec = (await getHandoff(u.email, h.id))!;
    expect(rec.items[0]).toMatchObject({ status: "done", ranBy: system, cost: TASK_COST.prd });
    expect([...rec.items[0].tasks!].sort()).toEqual(tasks.map((t) => t.id).sort());
    const log = await rows(u.email);
    expect(log.find((r) => r.kind === "handoff_run")).toMatchObject({ agent: "majed", by: system, via: "handoff", type: "prd", count: TASK_COUNT.prd, outcome: `done:${h.id}:0` });
    expect(log.find((r) => r.kind === "generated")).toMatchObject({ agent: PRD_AGENT, by: system, via: "handoff", type: "prd", credits: TASK_COST.prd });
    // One notice, with its fingerprint; the lock and the hold are let go.
    const notes = await listNotifs(u.email);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "pending", agent: PRD_AGENT, title: `${ar.generate.types.prd.t} من ${agentById(PRD_AGENT).name.ar} في صندوق الموافقة` });
    expect(await db.get(`notifseen:${u.email}:handoff:${u.email}:${h.id}:0`)).not.toBeNull();
    expect(await db.get(`handofflock:${u.email}:${h.id}`)).toBeNull();
    expect(await db.get(`handoffhold:${u.email}`)).toBeNull();
    // The card says the auto-run started it; nothing is left for it to start.
    const view = await handoffView(u.email, rec);
    expect(view.items[0].ranAuto).toBe(true);
    expect(view.auto).toBeUndefined();
    // The same item cannot run again, and even if it could, the owner would not be told twice.
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe("skip:not_proposed");
    await rewrite(u.email, h, (x) => ({ ...x, items: [{ ...x.items[0], status: "proposed" }] }));
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toMatch(/^ok:/);
    expect(await listNotifs(u.email)).toHaveLength(1);
  });

  it("the Activity page names the auto-run, and the inbox chip says it started on its own", async () => {
    sdk();
    const { autoRunHandoff } = await loadAuto();
    const { u, h } = await eligible("ha-run-pages");
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toMatch(/^ok:/);
    await settle();
    await signIn(u.email);
    const act = renderToStaticMarkup((await ActivityPage({ params: Promise.resolve({ lang: "en" }) })) as ReactElement);
    expect(act).toContain(esc(en.activity.autoRun));
    const inbox = renderToStaticMarkup((await InboxPage({ params: Promise.resolve({ lang: "en" }) })) as ReactElement);
    expect(inbox).toContain(esc(fill(en.inbox.fromHandoffAuto, { name: en.agents.majed.name })));
    const arInbox = renderToStaticMarkup((await InboxPage({ params: Promise.resolve({ lang: "ar" }) })) as ReactElement);
    expect(arInbox).toContain(fill(ar.inbox.fromHandoffAuto, { name: ar.agents.majed.name }));
  });
});

// ── Rule 288: failures ───────────────────────────────────────────────────────────────────────────────────────────

describe("a failure is refunded and the item is left to the owner (rule 288)", () => {
  it("a failed generation: credits back, attempt given back, item failed and never auto-started again, no notice", async () => {
    sdk({ genFails: true });
    const { autoRunHandoff } = await loadAuto();
    const { u, h } = await eligible("ha-fail");
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe("failed");
    expect(await credits(u.email)).toBe(50);
    expect(await statuses(u.email, h.id)).toEqual(["failed"]);
    expect(await db.get(`handofftry:${u.email}:${h.id}:0`)).toBe(0);
    expect((await rows(u.email)).find((r) => r.kind === "handoff_run")).toMatchObject({ by: { kind: "system", job: "auto_handoff" }, outcome: `failed:${h.id}:0` });
    expect(await listNotifs(u.email)).toEqual([]);
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe("skip:not_proposed");
    expect(await dueHandoffs([u])).toEqual([]);
  });

  it("the agent's cap or the balance refuses the charge: nothing charged, attempt given back, the item still proposed", async () => {
    const seen = sdk();
    const { autoRunHandoff } = await loadAuto();
    const capped = await eligible("ha-fail-cap", { caps: { [PRD_AGENT]: 0 } });
    expect(await autoRunHandoff(capped.u, capped.h.id, 0, LATE())).toBe("agent_cap");
    expect(await credits(capped.u.email)).toBe(50);
    expect(await statuses(capped.u.email, capped.h.id)).toEqual(["proposed"]);
    expect(await db.get(`handofftry:${capped.u.email}:${capped.h.id}:0`)).toBe(0);
    expect((await rows(capped.u.email)).find((r) => r.kind === "cap_reached")).toMatchObject({ agent: PRD_AGENT, via: "handoff", by: { kind: "system", job: "auto_handoff" } });
    const poor = await eligible("ha-fail-poor", { credits: 1 });
    expect(await autoRunHandoff(poor.u, poor.h.id, 0, LATE())).toBe("no_credits");
    expect(await credits(poor.u.email)).toBe(1);
    expect(await statuses(poor.u.email, poor.h.id)).toEqual(["proposed"]);
    expect(seen.made).toBe(0);
  });

  it("a run the platform kills after the charge is not started again: the item stays running, then shows as not completed", async () => {
    const hang = { on: true };
    const seen = sdk({ hang });
    const { autoRunHandoff } = await loadAuto();
    const { u, h } = await eligible("ha-killed");
    void autoRunHandoff(u, h.id, 0, LATE());
    await vi.waitFor(() => expect(seen.prompts).toHaveLength(1));
    // The platform ends the invocation: the lock and the hold expire before the next day's cron.
    await Promise.all([db.unlock(`handofflock:${u.email}:${h.id}`), db.del(`handoffhold:${u.email}`)]);
    expect(await credits(u.email)).toBe(50 - TASK_COST.prd);
    expect(await statuses(u.email, h.id)).toEqual(["running"]);
    expect(await db.get(`handofftry:${u.email}:${h.id}:0`)).toBe(1);
    hang.on = false;
    expect(await autoRunHandoff(u, h.id, 0, LATE())).toBe("skip:not_proposed");
    expect(await dueHandoffs([u])).toEqual([]);
    expect(seen.prompts).toHaveLength(1);
    expect(await credits(u.email)).toBe(50 - TASK_COST.prd);
  });
});

// ── Rule 289: isAutonomous ───────────────────────────────────────────────────────────────────────────────────────

describe("isAutonomous is the one test of work made on its own (rule 289)", () => {
  const parent = { handoff: "0123456789abcdef", item: 0 };
  const task = (id: string, over: Partial<Task>): Task => ({ id, type: "prd", channel: "doc", title: "t", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar", source: "manual", ...over });

  it("scheduled and auto-run children are; a child a login ran, an MCP draft, chat and manual items are not", () => {
    expect(isAutonomous({ source: "scheduled" })).toBe(true);
    expect(isAutonomous({ source: "handoff", parent: { ...parent, auto: true } })).toBe(true);
    expect(isAutonomous({ source: "handoff", parent })).toBe(false);
    expect(isAutonomous({ source: "handoff" })).toBe(false);
    for (const source of ["external", "chat", "manual", undefined] as const) expect(isAutonomous({ source }), String(source)).toBe(false);
    // Only a real `true` from the run's own code: a parent's other fields never make it autonomous.
    expect(isAutonomous({ source: "external", parent: { ...parent, auto: true } })).toBe(false);
    for (const f of ["src/lib/routines.ts", "src/lib/schedule.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/source\s*[!=]==\s*"scheduled"/);
  });

  it("runWeekly's cap counts auto-run children and not MCP drafts", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const u = await owner("ha-weekly");
    await saveGov(u.email, { weeklyCap: 1 });
    await saveTask(u.email, task("x1", { source: "external" }), true);
    await saveTask(u.email, task("h1", { source: "handoff", parent }), true);
    // No key: the Sunday plan answers with its development items, charged like real ones. Neither counted.
    expect(await runWeekly(u)).toMatch(/^ok:/);
    const v = await owner("ha-weekly-auto");
    await saveGov(v.email, { weeklyCap: 1 });
    await saveTask(v.email, task("a1", { source: "handoff", parent: { ...parent, auto: true } }), true);
    expect(await runWeekly(v)).toBe("cap_reached");
  });

  it("the routines: Dana's gate does not take auto-run work as activity; holdBatch counts it and the auto-run's hold", async () => {
    sdk();
    const { runRoutine } = await import("@/lib/routines");
    const quiet = await owner("ha-gate");
    await saveSchedule(quiet.email, { routines: { dana_weekly_report: true } });
    await saveTask(quiet.email, task("a1", { source: "handoff", parent: { ...parent, auto: true } }), true);
    expect(await runRoutine(quiet, "dana_weekly_report")).toBe("idle");
    const busy = await owner("ha-gate-run");
    await saveSchedule(busy.email, { routines: { dana_weekly_report: true } });
    await saveTask(busy.email, task("r1", { source: "handoff", parent }), true);
    expect(await runRoutine(busy, "dana_weekly_report")).toBe("ok:1");

    const full = await owner("ha-hold-count");
    await Promise.all([saveSchedule(full.email, { routines: { dana_weekly_report: true } }), saveGov(full.email, { weeklyCap: 2 })]);
    await Promise.all([task("m1", {}), task("a1", { source: "handoff", parent: { ...parent, auto: true } }), task("a2", { source: "handoff", parent: { ...parent, item: 1, auto: true } })].map((t) => saveTask(full.email, t, true)));
    expect(await runRoutine(full, "dana_weekly_report"), "2 auto-run items + 1 is over 2").toBe("cap_reached");
    const held = await owner("ha-hold-auto");
    await Promise.all([saveSchedule(held.email, { routines: { dana_weekly_report: true } }), saveGov(held.email, { weeklyCap: 1 }), saveTask(held.email, task("m1", {}), true)]);
    await db.set(`handoffhold:${held.email}`, 1, 360);
    expect(await runRoutine(held, "dana_weekly_report"), "the auto-run's batch in progress is counted").toBe("cap_reached");
    await db.del(`handoffhold:${held.email}`);
    await saveTask(held.email, task("x1", { source: "external" }), true);
    expect(await runRoutine(held, "dana_weekly_report"), "an MCP draft is not").toBe("ok:1");
  });
});

// ── Rule 290: the words never promise "nothing runs" when something may ─────────────────────────────────────────

describe("the chat reply, the card and the tool never say 'nothing runs' when the auto-run may (rule 290)", () => {
  it("proposalText and Majed's tool reply name the items that may start by themselves, only when they may", async () => {
    const { u, h } = await eligible("ha-text");
    expect(proposalText(h, 50)).toContain("Say plainly that nothing runs or is charged until the owner presses Run on the card.");
    const auto = proposalText(h, 50, [0]);
    expect(auto).toContain("Thakeen may start item 1 by itself at the daily run (06:00 UTC), one item a day");
    expect(auto).not.toContain("nothing runs or is charged until");
    expect(auto).toContain("Nothing ran and nothing was charged");
    expect(autoItems(h, await getGov(u.email))).toEqual([0]);
    const tool = (by: By) => runTool(u, "propose_handoff", { items: TWO }, [], [], undefined, { agent: "majed", by, ownerMsg: "m", conv: CONV });
    expect(await tool(ownerBy(u))).toContain("may start items 1, 2 by itself");
    const member = await tool({ kind: "member", email: "sara@team.example", role: "member" });
    expect(member).not.toContain("by itself");
    expect(member).toContain("nothing runs or is charged until the owner presses Run");
    const offU = await owner("ha-text-off");
    const off = await runTool(offU, "propose_handoff", { items: TWO }, [], [], undefined, { agent: "majed", by: ownerBy(offU), ownerMsg: "m" });
    expect(off).toContain("nothing runs or is charged until the owner presses Run");
  });

  it("the card: the auto-run's words and a mark on each item it may start; otherwise the plain words", async () => {
    const { u, h } = await eligible("ha-card", { items: [{ type: "pricing_review", brief: "b" }, ...ONE] });
    const view = await handoffView(u.email, h);
    expect(view.auto).toEqual([1]);
    const html = renderToStaticMarkup(createElement(HandoffCard, { id: h.id, t: en, lang: "en", initial: view }));
    expect(html).toContain(esc(en.handoff.subAuto));
    expect(html).not.toContain(esc(en.handoff.sub));
    // One badge, on the item whose agent has a cap (the words also appear, quoted, in the explanation above).
    expect(html.split(`>${esc(en.handoff.autoItem)}</span>`).length - 1).toBe(1);
    const plain: HandoffView = { ...view, auto: undefined };
    const p = renderToStaticMarkup(createElement(HandoffCard, { id: h.id, t: en, lang: "en", initial: plain }));
    expect(p).toContain(esc(en.handoff.sub));
    expect(p).not.toContain(esc(en.handoff.autoItem));
    const arHtml = renderToStaticMarkup(createElement(HandoffCard, { id: h.id, t: ar, lang: "ar", initial: view }));
    expect(arHtml).toContain(ar.handoff.autoItem);
    // With the switch off, the server's view has no `auto` at all.
    await saveGov(u.email, { majedAutoHandoff: false });
    expect(await handoffView(u.email, h)).not.toHaveProperty("auto");
  });

  it("chat() marks a proposal shown only once the reply carrying its card is saved; one whose turn failed never starts", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    const turns: (Record<string, unknown> | Error)[] = [];
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        static BadRequestError = class extends Error {};
// The agent-scope classifier streams since the 2026-10-12 build batch (rule 980) and forces its `verdict` tool. It gets
        // no answer here, as when it called the `create` this mock never had, so the scripted turns stay the chat's.
        messages = { stream: (p?: { tool_choice?: { name?: string } }) => (p?.tool_choice?.name === "verdict" ? { finalMessage: async () => { throw new Error("no classifier in this test"); } } : { finalMessage: async () => { const t = turns.shift(); if (t instanceof Error) throw t; return { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, ...(t ?? { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }) }; } }) };
      },
    }));
    const { chat, history } = await import("@/lib/chat");
    const lib = await import("@/lib/handoffs");
    const auto = await import("@/lib/handoff-auto");
    const u = await owner("ha-shown");
    await Promise.all([saveGov(u.email, { majedAutoHandoff: true, agentCaps: { [PRD_AGENT]: 20 } }), thread(u.email, CONV)]);
    const propose = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "propose_handoff", input: { items: ONE } }] };
    turns.push(propose, { stop_reason: "end_turn", content: [{ type: "text", text: "اقترحت بنداً لليان." }] });
    const m = await chat(u, "خطة الاشتراك", CONV, "majed", { lang: "ar", by: ownerBy(u) });
    const shown = (await lib.getHandoff(u.email, m.handoff!.id))!;
    expect(shown.shownAt).toEqual(expect.any(String));
    expect((await history(u.email, CONV)).at(-1)?.handoff).toEqual({ id: shown.id });
    expect((await auto.dueHandoffs([u])).map((d) => d.id)).toEqual([shown.id]);
    // The model call after the tool fails: the proposal is saved, but no reply and no card ever reach the thread.
    turns.push(propose, new Error("overloaded"));
    await expect(chat(u, "وخطة ثانية", CONV, "majed", { lang: "ar", by: ownerBy(u) })).rejects.toThrow("overloaded");
    const ids = await db.lrange(`handoffs:${u.email}`, 0, -1);
    expect(ids).toHaveLength(2);
    const orphan = (await lib.getHandoff(u.email, ids[0]))!;
    expect(orphan.id).not.toBe(shown.id);
    expect(orphan.shownAt).toBeUndefined();
    expect((await history(u.email, CONV)).some((x) => x.handoff?.id === orphan.id)).toBe(false);
    expect(lib.autoBlock(orphan, 0, await getGov(u.email))).toBe("not_shown");
    expect((await auto.autoQueue(u.email, await getGov(u.email))).map((q) => q.id), "only the one whose card was shown").toEqual([shown.id]);
    expect(await auto.autoRunHandoff(u, orphan.id, 0, LATE())).toBe("skip:not_shown");
    await settle();
  });
});

// ── Rule 291: the cron route ─────────────────────────────────────────────────────────────────────────────────────

describe("the routines cron runs one auto-run item per brand a day (rule 291)", () => {
  it("the item runs first under its own id; a second call the same day runs no other item of that brand", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    sdk();
    const route = await import("@/app/api/cron/routines/route");
    const { u, h } = await eligible("ha-cron", { items: TWO });
    const call = async () => (await (await route.GET(new Request("https://nashr.test/api/cron/routines", { headers: { authorization: "Bearer cron-secret-abcdef" } }))).json()) as { results: Record<string, string>; alreadyDone: number };
    const first = await call();
    const id = `${u.email}:${AUTO_HANDOFF_CRON_ID}`;
    expect(first.results[id]).toBe(`ok:${TASK_COUNT.prd}`);
    expect(await statuses(u.email, h.id)).toEqual(["done", "proposed"]);
    const second = await call();
    expect(second.results[id]).toBeUndefined();
    expect(second.alreadyDone).toBeGreaterThanOrEqual(1);
    expect(await statuses(u.email, h.id)).toEqual(["done", "proposed"]);
    expect(await credits(u.email)).toBe(50 - TASK_COST.prd);
    // The handoff items are listed before the routines, so they start in the first wave.
    const src = readFileSync("src/app/api/cron/routines/route.ts", "utf8");
    expect(src).toMatch(/const items: Item\[\] = \[\.\.\.handoffs\.map/);
    // Both kinds of item get the invocation's deadline, and run on the account read again at their start (rule 2506).
    expect(src).toMatch(/runAsAccount\(x\.ref, \(u\) => /);
    expect(src).toMatch(/runRoutine\(u, x\.id, deadline\)/);
    expect(src).toMatch(/autoRunHandoff\(u, x\.id, x\.item, deadline\)/);
    await settle();
  });

  it("a routine with less than 180 s of the invocation left answers retry:late before its hold, attempt and charge", async () => {
    sdk();
    const { runRoutine } = await import("@/lib/routines");
    const { BATCH_RUN_MIN_MS } = await import("@/lib/generate-batch");
    const { RETRY_LATE } = await import("@/lib/cron-batch");
    const { HANDOFF_RUN_MIN_MS } = await import("@/lib/handoffs");
    expect([BATCH_RUN_MIN_MS, HANDOFF_RUN_MIN_MS, RETRY_LATE]).toEqual([180_000, 180_000, "retry:late"]);
    const u = await owner("ha-late-routine");
    await saveSchedule(u.email, { routines: { dana_weekly_report: true } });
    await saveTask(u.email, { id: "m1", type: "prd", channel: "doc", title: "t", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar", source: "manual" }, true);
    const before = await credits(u.email);
    expect(await runRoutine(u, "dana_weekly_report", Date.now() + BATCH_RUN_MIN_MS - 5_000)).toBe(RETRY_LATE);
    expect(await credits(u.email)).toBe(before);
    const keys = [...(globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem.kv.keys()].filter((k) => k.includes(u.email) && /^routine(hold|try|last|lock)/.test(k));
    expect(keys).toEqual([]);
    expect((await rows(u.email)).filter((r) => r.kind === "routine_ran" || r.kind === "routine_skipped")).toEqual([]);
    // With the time a batch needs, the same routine runs.
    expect(await runRoutine(u, "dana_weekly_report", Date.now() + 300_000)).toBe("ok:1");
    expect(await credits(u.email)).toBe(before - TASK_COST.weekly_report);
    await settle();
  });
});

// ── Rule 295: the Governance page lists what the auto-run may start, with Decline ─────────────────────────────────

describe("the Governance page lists what Majed's auto-run may start, with Decline (rule 295)", () => {
  it("every eligible item, oldest first, with its agent, cost and conversation; nothing it may not start; Decline for who may", async () => {
    const { u, h } = await eligible("ha-queue", { items: [{ type: "pricing_review", brief: "b" }, ...ONE] });
    const newer = await createHandoff(u.email, { proposal: { items: TWO }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" });
    await markShown(u.email, newer.id);
    // Not eligible, so not listed: a member's proposal, and one whose card never reached the thread.
    await createHandoff(u.email, { proposal: { items: ONE }, requestedBy: { kind: "member", email: "sara@team.example", role: "member" }, origin: "web_chat", ownerMsg: "m" }).then((x) => markShown(u.email, x.id));
    await createHandoff(u.email, { proposal: { items: ONE }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" });
    const q = await autoQueue(u.email, await getGov(u.email));
    // Razan has no cap: item 0 of the first proposal is left to the owner.
    expect(q.map((x) => [x.id, x.item])).toEqual([[h.id, 1], [newer.id, 0], [newer.id, 1]]);
    expect(q[0]).toEqual({ id: h.id, item: 1, type: "prd", agent: PRD_AGENT, cost: TASK_COST.prd, createdAt: h.createdAt, conv: CONV });
    expect(q[1]).not.toHaveProperty("conv");
    expect(await autoQueue(u.email, { ...(await getGov(u.email)), majedAutoHandoff: false })).toEqual([]);

    await signIn(u.email);
    const page = async (lang: "ar" | "en") => renderToStaticMarkup((await GovPage({ params: Promise.resolve({ lang }) })) as ReactElement);
    const html = await page("en");
    const sec = html.slice(html.indexOf('id="gov-auto-queue"'), html.indexOf('id="gov-history"'));
    expect(sec).toContain(`>${esc(en.governance.autoQueue)}</h2>`);
    expect(sec).toContain(esc(fill(en.handoff.to, { agent: en.agents[PRD_AGENT].name, type: en.generate.types.prd.t })));
    expect(sec).toContain(fill(en.handoff.cost, { n: TASK_COST.prd }));
    expect(sec).toContain(`href="/en/app/chat?conv=${CONV}"`);
    expect(sec).toContain('href="/en/app/chat"');
    expect(sec.split(`>${en.handoff.decline}</button>`).length - 1).toBe(3);
    // Outside the settings' fieldset: a member, who cannot change the settings, may still decline.
    expect(html.indexOf('id="gov-auto-queue"')).toBeGreaterThan(html.indexOf("</fieldset>"));
    expect(await page("ar")).toContain(`>${ar.governance.autoQueue}</h2>`);
    const m = await newMember(u, "member");
    await signIn(m.email);
    expect((await page("en")).split(`>${en.handoff.decline}</button>`).length - 1).toBe(3);
    // Declined through the card's route, it leaves the queue.
    const declineRoute = await import("@/app/api/handoffs/[id]/decline/route");
    const r = await declineRoute.POST(json(`/api/handoffs/${h.id}/decline`, "POST", { item: 1 }), { params: Promise.resolve({ id: h.id }) });
    expect(r.status).toBe(200);
    expect((await autoQueue(u.email, await getGov(u.email))).map((x) => [x.id, x.item])).toEqual([[newer.id, 0], [newer.id, 1]]);
    // The panel calls the same route, per item, and takes the item out of the list after it.
    const panel = readFileSync("src/components/app/GovernancePanel.tsx", "utf8");
    expect(panel).toContain("fetch(`/api/handoffs/${q.id}/decline`");
    expect(panel).toContain("JSON.stringify({ item: q.item })");
  });

  it("with the switch off, or nothing eligible, the page shows no queue", async () => {
    const u = await owner("ha-queue-off");
    await createHandoff(u.email, { proposal: { items: ONE }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" }).then((x) => markShown(u.email, x.id));
    await signIn(u.email);
    const html = renderToStaticMarkup((await GovPage({ params: Promise.resolve({ lang: "en" }) })) as ReactElement);
    expect(html).not.toContain('id="gov-auto-queue"');
  });
});

// ── Rule 296: the margin floor on the auto-run's cold cache ──────────────────────────────────────────────────────

describe("the auto-run starts only types that keep the margin floor on a cold cache (rule 296)", () => {
  /** A one-item proposal of `type` that passes every other rule: the owner's, shown, fresh, a cap on the type's agent. */
  const one = (type: TaskType): Handoff => {
    const at = new Date().toISOString();
    return { id: "0123456789abcdef", agent: "majed", requestedBy: { kind: "owner", email: "o@floor.example" }, origin: "web_chat", ownerMsg: "", items: [{ type, agent: agentForTask(type).id, brief: "b", cost: TASK_COST[type], status: "proposed" }], status: "proposed", createdAt: at, shownAt: at };
  };
  const capped = (type: TaskType) => ({ majedAutoHandoff: true, agentCaps: { [agentForTask(type).id]: 50 } });
  const ceiling = maxCostPerCreditUsd();

  it("autoBlock refuses (`floor`) exactly the handoff types over the ceiling on a cold cache: none today (rule 901)", () => {
    expect(HANDOFF_TYPES.filter((t) => autoBlock(one(t), 0, capped(t)) !== null)).toEqual([]);
    // The same estimate and ceiling as the floor test (rule 241), read by the code, not copied into it.
    for (const t of HANDOFF_TYPES) expect(autoUnderFloor(t), t).toBe(estimateBatch(t, { cache: "cold" }).usdPerCredit <= ceiling);
    // Not vacuous: against a ceiling just under article's cold cost, article and only the types as dear are refused,
    // each as `floor`, and all of them still keep the real ceiling on a hit (a login's Run).
    tighten();
    const refused = HANDOFF_TYPES.filter((t) => autoBlock(one(t), 0, capped(t)) !== null);
    expect(refused).toContain("article");
    expect(refused.length).toBeLessThan(HANDOFF_TYPES.length);
    for (const t of HANDOFF_TYPES) expect(refused.includes(t), t).toBe(estimateBatch(t, { cache: "cold" }).usdPerCredit > floor.tight!);
    for (const t of refused) {
      expect(autoBlock(one(t), 0, capped(t)), t).toBe("floor");
      expect(estimateBatch(t).usdPerCredit, t).toBeLessThanOrEqual(ceiling);
    }
    // A type the estimate cannot price is never started.
    expect(autoUnderFloor("not_a_type" as TaskType)).toBe(false);
  });

  it("the cron, the Governance queue, the card and Majed's reply skip such an item and take the next one", async () => {
    const x = await eligible("ha-floor", { items: [{ type: "article", brief: "مقال عن العود" }, ...ONE], caps: { [agentForTask("article").id]: 50, [PRD_AGENT]: 20 } });
    const gov = await getGov(x.u.email);
    tighten();
    expect((await dueHandoffs([x.u])).map((c) => [c.id, c.item])).toEqual([[x.h.id, 1]]);
    expect((await autoQueue(x.u.email, gov)).map((q) => [q.type, q.item])).toEqual([["prd", 1]]);
    expect((await handoffView(x.u.email, x.h)).auto).toEqual([1]);
    expect(autoItems(x.h, gov, Date.now(), { beforeCard: true })).toEqual([1]);
    expect(proposalText(x.h, 50, autoItems(x.h, gov))).toContain("may start item 2 by itself");
  });

  it("no type is left to Run, so the words name none, in both languages", () => {
    expect(HANDOFF_TYPES.filter((t) => !autoUnderFloor(t)), "a type here needs words in the toggle and the FAQ").toEqual([]);
    const faq = HELP.flatMap((t) => t.items).find((i) => i.q.en === "Majed's auto-run?")!;
    for (const text of [en.governance.autoHandoffSub, faq.a.en]) expect(text).not.toContain("SEO articles");
    for (const text of [ar.governance.autoHandoffSub, faq.a.ar]) expect(text).not.toContain("مقالات SEO");
  });
});

// ── Rule 292: the wipe ───────────────────────────────────────────────────────────────────────────────────────────

describe("the auto-run's keys go with the account (rule 292)", () => {
  it("attempt counters, notice markers and the hold of every brand are deleted; nothing named after the account is left", async () => {
    const u = await owner("ha-wipe");
    await saveUser({ ...(await getUser(u.email))!, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const s2 = scopeFor(u.email, second.id);
    const scopes = [u.email, s2];
    const hs = await Promise.all(scopes.map((s) => createHandoff(s, { proposal: { items: TWO }, requestedBy: ownerBy(u), origin: "web_chat", ownerMsg: "m" })));
    const made = scopes.flatMap((s, i) => [`handofftry:${s}:${hs[i].id}:0`, `handofftry:${s}:${hs[i].id}:1`, `notifseen:${u.email}:handoff:${s}:${hs[i].id}:0`, `handoffhold:${s}`]);
    await Promise.all(made.map((k) => db.set(k, 1, 3600)));
    const listed = await handoffKeys(s2, (fp) => `notifseen:${u.email}:${fp}`);
    for (const k of made.filter((k) => k.includes(s2) && !k.startsWith("handoffhold"))) expect(listed, k).toContain(k);
    await wipeAccount(u.email);
    for (const k of made) expect(await db.get(k), k).toBeNull();
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]> } }).__nashrMem;
    const left = [...mem.kv.keys(), ...mem.lists.keys()].filter((k) => /^(handoff|notifseen)/.test(k) && k.includes(u.email));
    expect(left).toEqual([]);
  });
});
