import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { EVENTS } from "@/lib/track";
import { MARGIN_LAST_KEY } from "@/lib/margin";
import { CRON_JOBS } from "@/lib/cron-heartbeat";
import {
  ALERT_REPEAT_S, CALLBACK_SHAPE, OPS_GITHUB_REPO, PROPOSAL_BODY_MAX, PROPOSAL_TITLE_MAX, PROPOSAL_TTL_S, TELEGRAM_TEXT_MAX,
  handlePress, messageText, opsSummary, parseRelay, type OpsProposal,
} from "@/lib/ops";

/** Rules 2380-2390 (docs/system/tests/2380-ops-agent.md): the ops agent's routes (src/lib/ops.ts) and its Managed Agents files (agents/thakeen-ops/). */

const TOKEN = "t".repeat(48);
const HOOK = "h".repeat(40);
const CHAT = "123456789";
let ipN = 0;
const ip = () => `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}`;

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
let calls: Call[] = [];
let fetchAnswer: (url: string) => Response = () => new Response("{}", { status: 200 });

beforeEach(() => {
  calls = [];
  fetchAnswer = (url) => (url.startsWith("https://api.github.com/") ? new Response(JSON.stringify({ html_url: "https://github.com/x/y/issues/1" }), { status: 201 }) : new Response("{}", { status: 200 }));
  vi.stubEnv("OPS_AGENT_TOKEN", TOKEN);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:bot");
  vi.stubEnv("TELEGRAM_CHAT_ID", CHAT);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", HOOK);
  vi.stubEnv("OPS_GITHUB_TOKEN", "gh-test");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    return fetchAnswer(url);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const summary = async (headers: Record<string, string> = {}) =>
  (await import("@/app/api/ops/summary/route")).GET(new Request("https://x.example/api/ops/summary", { headers: { "x-forwarded-for": ip(), ...headers } }));
const relayPost = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  (await import("@/app/api/ops/telegram/route")).POST(new Request("https://x.example/api/ops/telegram", { method: "POST", headers: { "x-forwarded-for": ip(), "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const hookPost = async (body: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": HOOK }) =>
  (await import("@/app/api/ops/telegram/callback/route")).POST(new Request("https://x.example/api/ops/telegram/callback", { method: "POST", headers: { "x-forwarded-for": ip(), "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const press = (data: string, from = CHAT, chat = CHAT) => ({ callback_query: { id: "q1", data, from: { id: from }, message: { message_id: 7, chat: { id: chat }, text: "تقرير" } } });
const proposal = (over: Partial<OpsProposal> = {}): OpsProposal => ({ action: "github_issue", title: "CI fails on main", body: "Two runs failed.", createdAt: "2026-10-20T00:00:00.000Z", ...over });
let idN = 0;
const newId = () => (++idN).toString(16).padStart(24, "a");

describe("rule 2380: GET /api/ops/summary needs the ops token", () => {
  it("401 without a token, with a wrong one, and when OPS_AGENT_TOKEN is unset", async () => {
    expect((await summary()).status).toBe(401);
    expect((await summary({ authorization: "Bearer nope" })).status).toBe(401);
    vi.stubEnv("OPS_AGENT_TOKEN", "");
    expect((await summary({ authorization: "Bearer " })).status).toBe(401);
  });
  it("a token in the query string is not accepted", async () => {
    const { GET } = await import("@/app/api/ops/summary/route");
    expect((await GET(new Request(`https://x.example/api/ops/summary?token=${TOKEN}`, { headers: { "x-forwarded-for": ip() } }))).status).toBe(401);
  });
  it("200 and no-store with the token", async () => {
    const r = await summary({ authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("the 31st call in a minute from one IP is 429 before the token is read", async () => {
    const { GET } = await import("@/app/api/ops/summary/route");
    const one = () => GET(new Request("https://x.example/api/ops/summary", { headers: { "x-forwarded-for": "10.78.0.1" } }));
    for (let i = 0; i < 30; i++) expect((await one()).status).toBe(401);
    expect((await one()).status).toBe(429);
  });
  it("uses sameSecret, never a plain comparison", () => {
    const src = readFileSync("src/lib/ops.ts", "utf8");
    expect(src).toMatch(/sameSecret\(bearer, process\.env\.OPS_AGENT_TOKEN\)/);
    expect(src).toMatch(/sameSecret\(req\.headers\.get\(TELEGRAM_SECRET_HEADER\), process\.env\.TELEGRAM_WEBHOOK_SECRET\)/);
  });
});

describe("rule 2381: the summary is counts only", () => {
  it("has exactly its fields, the two days' counters and the margin run's counts", async () => {
    const now = new Date("2031-03-04T10:00:00.000Z");
    await Promise.all([
      db.incrby(globalKey.eventDay("2031-03-04", "signup"), 3),
      db.incrby(globalKey.eventDay("2031-03-04", "error"), 2),
      db.incrby(globalKey.eventDay("2031-03-03", "signup"), 5),
      db.set(MARGIN_LAST_KEY, { day: "2031-03-04", at: now.toISOString(), month: "2031-03", checked: 4, under: 1, alerted: 1, rows: [{ email: "a@b.c" }] }),
      db.sadd(globalKey.usersAll(), "ops-summary@example.com"),
    ]);
    const s = await opsSummary(now);
    expect(Object.keys(s).sort()).toEqual(["accounts", "at", "crons", "events", "margin", "ok", "release", "store"]);
    expect(s.events.today).toEqual({ day: "2031-03-04", counts: expect.objectContaining({ signup: 3, error: 2, login: 0 }) });
    expect(s.events.yesterday.counts.signup).toBe(5);
    expect(Object.keys(s.events.today.counts).sort()).toEqual([...EVENTS].sort());
    expect(s.margin).toEqual({ day: "2031-03-04", at: now.toISOString(), month: "2031-03", checked: 4, under: 1, alerted: 1 });
    expect(s.crons.jobs.map((j) => j.job).sort()).toEqual([...CRON_JOBS].sort());
    expect(s.accounts).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(s)).not.toMatch(/@/);
  });
  it("reads with three requests sent together, never one per key", () => {
    const src = readFileSync("src/lib/ops.ts", "utf8");
    const body = src.slice(src.indexOf("export async function opsSummary"), src.indexOf("// ---------- the relay"));
    expect(body).toMatch(/Promise\.allSettled\(\[db\.mget/);
    expect(body).not.toMatch(/await db\./);
    expect(body).not.toMatch(/for \(/);
  });
});

describe("rule 2382: a store that fails still answers", () => {
  it("store.ok and ok are false and every count is zero", async () => {
    vi.spyOn(db, "mget").mockRejectedValue(new Error("down"));
    const s = await opsSummary(new Date("2031-03-05T10:00:00.000Z"));
    expect(s.ok).toBe(false);
    expect(s.store.ok).toBe(false);
    expect(Object.values(s.events.today.counts).every((n) => n === 0)).toBe(true);
    expect(s.margin).toBeNull();
  });
});

describe("rule 2383: POST /api/ops/telegram needs the ops token", () => {
  it("401 without it, and when OPS_AGENT_TOKEN is unset; nothing is sent", async () => {
    expect((await relayPost({ text: "hi" }, {})).status).toBe(401);
    vi.stubEnv("OPS_AGENT_TOKEN", "");
    expect((await relayPost({ text: "hi" }, { authorization: "Bearer " })).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("the relay and proposal ceilings come from src/lib/rate.ts", () => {
    const src = readFileSync("src/app/api/ops/telegram/route.ts", "utf8");
    expect(src).toMatch(/allow\("ops:relay", OPS_RELAY_PER_HOUR, WINDOW\.hour\)/);
    expect(src).toMatch(/allow\("ops:proposals", OPS_PROPOSALS_PER_DAY, WINDOW\.day\)/);
  });
});

describe("rule 2384: the relay sends plain text to the founder's chat only", () => {
  it("sends to TELEGRAM_CHAT_ID whatever chat the body names, with no parse mode and no link preview", async () => {
    const r = await relayPost({ text: "صباح الخير", chat_id: "999", parse_mode: "HTML" });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:bot/sendMessage");
    expect(calls[0].body).toEqual({ chat_id: CHAT, text: "صباح الخير", link_preview_options: { is_disabled: true } });
  });
  it("refuses a body without text, an unknown action, an oversized title or body, and a message over the limit", () => {
    expect(parseRelay(null)).toEqual({ error: "bad_body" });
    expect(parseRelay({ text: "  " })).toEqual({ error: "no_text" });
    expect(parseRelay({ text: "x", proposal: { action: "merge_pr", title: "a", body: "b" } })).toEqual({ error: "bad_action" });
    expect(parseRelay({ text: "x", proposal: { action: "github_issue", title: "a".repeat(PROPOSAL_TITLE_MAX + 1), body: "b" } })).toEqual({ error: "bad_title" });
    expect(parseRelay({ text: "x", proposal: { action: "github_issue", title: "a", body: "b".repeat(PROPOSAL_BODY_MAX + 1) } })).toEqual({ error: "bad_proposal_body" });
    expect(parseRelay({ text: "x".repeat(TELEGRAM_TEXT_MAX + 1) })).toEqual({ error: "too_long" });
  });
  it("drops control characters and keeps the title on one line", () => {
    expect(parseRelay({ text: "a\u0007b", proposal: { action: "github_issue", title: "t1\nt2", body: "b" } })).toEqual({ text: "ab", proposal: { title: "t1 t2", body: "b" }, alertKey: null });
  });
  it("an alert key is sent once in ALERT_REPEAT_S; a failed send frees it; a bad key is refused", async () => {
    expect(parseRelay({ text: "x", alert_key: "Cron Media!" })).toEqual({ error: "bad_alert_key" });
    fetchAnswer = () => new Response("{}", { status: 500 });
    expect((await relayPost({ text: "x", alert_key: "cron:test-a" })).status).toBe(502);
    fetchAnswer = () => new Response("{}", { status: 200 });
    expect((await relayPost({ text: "x", alert_key: "cron:test-a" })).status).toBe(200);
    const again = await relayPost({ text: "x", alert_key: "cron:test-a" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sent: false, skipped: true });
    expect(calls.filter((c) => c.url.endsWith("/sendMessage"))).toHaveLength(2);
    expect(await db.ttl(globalKey.opsAlert("cron:test-a"))).toBeGreaterThan(ALERT_REPEAT_S - 10);
  });
  it("502 when Telegram does not take the message", async () => {
    fetchAnswer = () => new Response("{}", { status: 400 });
    expect((await relayPost({ text: "x" })).status).toBe(502);
  });
});

describe("rule 2385: a proposal is stored, shown in full, and its buttons are built by the app", () => {
  it("stores it for PROPOSAL_TTL_S under a fresh id, shows title and body, and puts ok/no buttons for that id", async () => {
    const r = await relayPost({ text: "CI فشل", proposal: { action: "github_issue", title: "CI fails", body: "Run 12 failed.", buttons: [{ url: "https://evil.example" }] } });
    expect(r.status).toBe(200);
    const { proposal: id } = (await r.json()) as { proposal: string };
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    const stored = await db.get<OpsProposal>(globalKey.opsProposal(id));
    expect(stored).toMatchObject({ action: "github_issue", title: "CI fails", body: "Run 12 failed." });
    expect(await db.ttl(globalKey.opsProposal(id))).toBeGreaterThan(PROPOSAL_TTL_S - 10);
    expect(calls[0].body.text).toBe(messageText({ text: "CI فشل", proposal: { title: "CI fails", body: "Run 12 failed." } }));
    expect(String(calls[0].body.text)).toContain("Run 12 failed.");
    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "موافق", callback_data: `ok:${id}` }, { text: "رفض", callback_data: `no:${id}` }]] });
  });
  it("removes the stored proposal when the send fails", async () => {
    fetchAnswer = () => new Response("{}", { status: 500 });
    const del = vi.spyOn(db, "del");
    expect((await relayPost({ text: "x", proposal: { action: "github_issue", title: "t", body: "b" } })).status).toBe(502);
    expect(del.mock.calls.some(([k]) => String(k).startsWith("ops:proposal:"))).toBe(true);
  });
});

describe("rule 2386: the webhook needs Telegram's secret header", () => {
  it("401 without it, with a wrong one, and when TELEGRAM_WEBHOOK_SECRET is unset; nothing runs", async () => {
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect((await hookPost(press(`ok:${id}`), {})).status).toBe(401);
    expect((await hookPost(press(`ok:${id}`), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect((await hookPost(press(`ok:${id}`), { "x-telegram-bot-api-secret-token": "" })).status).toBe(401);
    expect(calls).toEqual([]);
    expect(await db.get(globalKey.opsProposal(id))).not.toBeNull();
  });
  it("200 { ok: true } for any update once the secret matches", async () => {
    const r = await hookPost({ message: { text: "/start" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("rule 2387: only the founder's own press counts", () => {
  it("a press from another user or another chat runs nothing and keeps the proposal", async () => {
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect(await handlePress(press(`ok:${id}`, "555"))).toBe("not_founder");
    expect(await handlePress(press(`ok:${id}`, CHAT, "-100"))).toBe("not_founder");
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(await db.get(globalKey.opsProposal(id))).not.toBeNull();
  });
  it("nothing runs while TELEGRAM_CHAT_ID is unset", async () => {
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect(await handlePress(press(`ok:${id}`, "", ""))).toBe("not_founder");
    expect(await db.get(globalKey.opsProposal(id))).not.toBeNull();
  });
});

describe("rule 2388: a proposal runs once, and only on «موافق»", () => {
  it("approve opens one issue; a second press finds nothing; the buttons are removed", async () => {
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect(await handlePress(press(`ok:${id}`))).toBe("opened");
    expect(await handlePress(press(`ok:${id}`))).toBe("expired");
    expect(calls.filter((c) => c.url.includes("api.github.com"))).toHaveLength(1);
    const edit = calls.find((c) => c.url.endsWith("/editMessageText"));
    expect(edit?.body).toMatchObject({ chat_id: CHAT, message_id: 7 });
    expect(edit?.body.reply_markup).toBeUndefined();
  });
  it("reject removes the proposal and opens nothing", async () => {
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect(await handlePress(press(`no:${id}`))).toBe("rejected");
    expect(await db.get(globalKey.opsProposal(id))).toBeNull();
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
  });
  it("callback data of any other shape, or a stored action off the list, runs nothing", async () => {
    expect(CALLBACK_SHAPE.test("ok:../../x")).toBe(false);
    expect(await handlePress(press("ok:ZZ"))).toBe("ignored");
    expect(await handlePress(press("merge:abcdefabcdefabcdefabcdef"))).toBe("ignored");
    const id = newId();
    await db.set(globalKey.opsProposal(id), { ...proposal(), action: "merge_pr" }, 60);
    expect(await handlePress(press(`ok:${id}`))).toBe("expired");
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
  });
  it("the proposal is taken with GETDEL, not read then deleted", () => {
    expect(readFileSync("src/lib/ops.ts", "utf8")).toMatch(/db\.getdel<OpsProposal>\(globalKey\.opsProposal\(id\)\)/);
  });
});

describe("rule 2389: the issue goes to the fixed repository with the server's token", () => {
  it("posts title and body to OPS_GITHUB_REPO with OPS_GITHUB_TOKEN and records the approval", async () => {
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal({ title: "Stale cron", body: "media is stale." }), 60);
    expect(await handlePress(press(`ok:${id}`), new Date("2031-03-06T08:00:00.000Z"))).toBe("opened");
    const gh = calls.find((c) => c.url.includes("api.github.com"))!;
    expect(gh.url).toBe(`https://api.github.com/repos/${OPS_GITHUB_REPO}/issues`);
    expect(gh.headers.authorization).toBe("Bearer gh-test");
    expect(gh.body.title).toBe("[ops] Stale cron");
    expect(String(gh.body.body)).toMatch(/^media is stale\.\n\n---\n/);
    expect(String(gh.body.body)).toContain("2031-03-06T08:00:00.000Z");
    expect(Object.keys(gh.body).sort()).toEqual(["body", "title"]);
  });
  it("a GitHub failure or a missing token is reported as failed", async () => {
    fetchAnswer = (url) => new Response("{}", { status: url.includes("github") ? 403 : 200 });
    const id = newId();
    await db.set(globalKey.opsProposal(id), proposal(), 60);
    expect(await handlePress(press(`ok:${id}`))).toBe("failed");
    vi.stubEnv("OPS_GITHUB_TOKEN", "");
    const id2 = newId();
    await db.set(globalKey.opsProposal(id2), proposal(), 60);
    expect(await handlePress(press(`ok:${id2}`))).toBe("failed");
  });
  it("never logs a URL (the Telegram bot token is in its path)", () => {
    expect(readFileSync("src/lib/ops.ts", "utf8")).not.toMatch(/log\.\w+\([^)]*url/i);
  });
});

describe("rule 2390: the agent's Managed Agents files keep it read-only and capped", () => {
  const read = (f: string) => readFileSync(`agents/thakeen-ops/${f}`, "utf8");
  it("agent.md: Opus 5.5 at low effort, the built-in toolset with web search and fetch off, no MCP, no custom tools", () => {
    const a = read("agent.md");
    expect(a).toMatch(/id: claude-opus-5-5/);
    expect(a).toMatch(/effort: low/);
    expect(a).toMatch(/type: agent_toolset_20260401/);
    expect(a).toMatch(/name: web_search\s+enabled: false/);
    expect(a).toMatch(/name: web_fetch\s+enabled: false/);
    expect(a).not.toMatch(/mcp_servers|type: custom|always_ask/);
  });
  it("environment.yaml: limited networking to exactly the three hosts", () => {
    const e = read("environment.yaml");
    expect(e).toMatch(/type: limited/);
    const hosts = [...e.matchAll(/^\s*-\s*([a-z0-9.*-]+)\s*$/gm)].map((m) => m[1]).sort();
    expect(hosts).toEqual(["api.github.com", "thakeen.com", "www.thakeen.com"]);
    expect(e).not.toMatch(/unrestricted|allow_package_managers: true/);
  });
  it("both deployments: Asia/Riyadh, a $1 session budget, and the expected schedules", () => {
    const checks = read("deployment-checks.yaml");
    const morning = read("deployment-morning.yaml");
    for (const d of [checks, morning]) {
      expect(d).toMatch(/timezone: Asia\/Riyadh/);
      expect(d).toMatch(/type: limit/);
      expect(d).toMatch(/amount: "100"/);
      expect(d).toMatch(/currency: USD/);
      expect(d).toMatch(/agent: \.\/agent\.md/);
    }
    expect(checks).toMatch(/expression: "0 \*\/3 \* \* \*"/);
    expect(morning).toMatch(/expression: "0 7 \* \* \*"/);
  });
  it("vault.yaml holds no secret value", () => {
    const v = read("vault.yaml");
    expect(v).toMatch(/type: vault/);
    expect(v).not.toMatch(/secret_value|ghp_|github_pat_/i);
  });
});
