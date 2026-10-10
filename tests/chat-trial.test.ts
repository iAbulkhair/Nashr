import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 330-331 (issue #24). Chat ran up to five Opus calls a turn, charged nothing and never asked whether the trial had
 * ended: an account that never paid could keep chatting at the old 200 turns a day, about $52 of model spend a day. Now an ended
 * trial is refused before any model call on the web route and on MCP `ask_noor` (and by chat() itself), with the way to
 * the Subscription page in the owner's language. The ended trial is refused before the ceilings and before the plan's
 * chat allowance (src/lib/chat-allowance.ts), so it uses up neither.
 */
const sdk = vi.hoisted(() => ({ made: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static BadRequestError = class extends Error {};
    constructor() { sdk.made++; }
    messages = {
      stream: () => ({ finalMessage: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "أهلاً" }] }) }),
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { chat, history } from "@/lib/chat";
import { createMcpToken } from "@/lib/mcp";
import { CHAT_CAPS, chatCaps, chatRefusal } from "@/lib/rate";
import { CHAT_ALLOWANCE } from "@/lib/pricing";
import { chatTrialKey } from "@/lib/usage";
import { json, newUser, signIn } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";

const past = () => new Date(Date.now() - 864e5).toISOString();
/** A trial account whose three days are over, saved so every route reads it that way. */
async function expired(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, trialEnds: past() });
  return (await getUser(u.email))!;
}
async function paid(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, plan: "starter", credits: 300 });
  return (await getUser(u.email))!;
}
const askNoor = async (email: string) => {
  const token = await createMcpToken(email);
  const res = await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_noor", arguments: { message: "مرحبا" } } }) }));
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
};

beforeEach(() => { sdk.made = 0; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("an ended trial gets no chat turn and no model call (rule 330)", () => {
  it("the web route answers 402 trial_over with the subscription link, streaming or not, in the reader's language", async () => {
    const u = await expired("ct-web");
    await signIn(u.email);
    for (const stream of [false, true]) {
      const res = await chatRoute.POST(json("/api/chat", "POST", { text: "اكتب لي منشوراً", stream }));
      expect(res.status, `stream ${stream}`).toBe(402);
      const body = (await res.json()) as { ok: boolean; error: string; limit: string; message: { role: string; content: string } };
      // `limit: "trial"` raises the subscription dialog in the chat; the message is what the chat shows.
      expect([body.ok, body.error, body.limit, body.message.role]).toEqual([false, "trial_over", "trial", "assistant"]);
      expect(body.message.content).toContain("](/ar/app/billing)");
      expect(body.message.content).toContain("لم يُخصم أي كريدت");
    }
    const en = (await (await chatRoute.POST(new Request("https://nashr.test/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-lang": "en" }, body: JSON.stringify({ text: "hi" }) }))).json()) as { message: { content: string } };
    expect(en.message.content).toMatch(/^Your free trial has ended.*\]\(\/en\/app\/billing\)/);
    expect(sdk.made, "no model client was ever made").toBe(0);
    // Nothing was written: not the owner's message, not a reply, and no ceiling was used up.
    expect(await history(u.email)).toEqual([]);
    expect(await db.get(`rate:chat:h:${u.email}`)).toBeNull();
    expect(await db.get(chatTrialKey(u.email)), "no message of the trial's allowance was reserved").toBeNull();
  });

  it("MCP ask_noor answers a tool error with an absolute link, before any model call", async () => {
    const u = await expired("ct-mcp");
    const r = await askNoor(u.email);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("https://nashr-tau.vercel.app/ar/app/billing");
    expect(sdk.made).toBe(0);
    expect(await history(u.email)).toEqual([]);
    expect(await db.get(`rate:chat:h:${u.email}`), "no ceiling was used up").toBeNull();
    expect(await db.get(`rate:chat:d:${u.email}`)).toBeNull();
    expect(await db.get(chatTrialKey(u.email))).toBeNull();
  });

  it("chat() itself refuses an ended trial, for any caller", async () => {
    const u = await expired("ct-fn");
    const m = await chat(u, "hello", undefined, "noor", { lang: "en" });
    expect(m.limit).toBe("trial");
    expect(m.content).toContain("/en/app/billing");
    expect(sdk.made).toBe(0);
    expect(await history(u.email)).toEqual([]);
  });

  it("a live trial and a paid account still reach the model", async () => {
    for (const u of [await newUser("ct-live"), await paid("ct-paid")]) {
      await signIn(u.email);
      const res = await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا" }));
      expect(res.status, u.plan).toBe(200);
      expect(((await res.json()) as { message: { content: string } }).message.content).toBe("أهلاً");
    }
    expect(sdk.made).toBe(2);
  });
});

describe("chat ceilings are the account's own, by plan (rule 331)", () => {
  // Founder decision 2026-10-01: lowered until the Sonnet chat eval passes, from 40 an hour and 200 a day on every plan.
  // A paid plan (Agency included) gets 30 an hour and 150 a day; a trial 10 an hour, and its day of 30 equals its
  // whole-trial allowance (CHAT_ALLOWANCE.trial, counted once), so the allowance stays what bounds a trial.
  it("the numbers", async () => {
    expect(CHAT_CAPS).toEqual({ paid: { hour: 30, day: 150 }, trial: { hour: 10, day: 30 } });
    expect(chatCaps({ plan: "trial" })).toEqual({ hour: 10, day: 30 });
    for (const plan of ["starter", "pro", "business", "agency"] as const) expect(chatCaps({ plan }), plan).toEqual({ hour: 30, day: 150 });
    expect(CHAT_ALLOWANCE.trial, "the trial's allowance, not its daily ceiling, bounds a trial").toBe(30);
    expect(chatCaps(await newUser("ct-caps-new")), "a new account is a trial").toEqual(CHAT_CAPS.trial);
  });

  it("a trial account stops at 10 an hour and a paid one at 30", async () => {
    for (const u of [await newUser("ct-cap-trial"), await paid("ct-cap-paid")]) {
      const { hour } = chatCaps(u);
      for (let i = 0; i < hour; i++) expect(await chatRefusal(u), `${u.plan} ${i}`).toBeNull();
      expect(await chatRefusal(u), u.plan).toBe("hour");
    }
  });

  it("a paid account stops at 150 a day", async () => {
    const p = await paid("ct-day-paid");
    await db.set(`rate:chat:d:${p.email}`, CHAT_CAPS.paid.day - 1, 86400);
    expect(await chatRefusal(p), "the 150th turn of the day").toBeNull();
    expect(await chatRefusal(p)).toBe("day");
  });

  it("refused attempts inside the hour do not use up the day", async () => {
    for (const u of [await newUser("ct-retry"), await paid("ct-retry-paid")]) {
      const caps = chatCaps(u);
      for (let i = 0; i < caps.hour; i++) expect(await chatRefusal(u)).toBeNull();
      for (let i = 0; i < 20; i++) expect(await chatRefusal(u), `refusal ${i}`).toBe("hour");
      expect(Number(await db.get(`rate:chat:d:${u.email}`))).toBe(caps.hour);
      // The next hour: the hour's bucket has expired, and the day still has room.
      await db.del(`rate:chat:h:${u.email}`);
      for (let i = 0; i < caps.hour; i++) expect(await chatRefusal(u), `next hour ${i}`).toBeNull();
      expect(Number(await db.get(`rate:chat:d:${u.email}`))).toBe(2 * caps.hour);
      // A refusal by the hour names the day when the day is spent too, being the longer wait, and adds nothing to it.
      await db.set(`rate:chat:d:${u.email}`, caps.day, 86400);
      expect(await chatRefusal(u)).toBe("day");
      expect(Number(await db.get(`rate:chat:d:${u.email}`))).toBe(caps.day);
      // The hour allows, the day refuses.
      await db.del(`rate:chat:h:${u.email}`);
      expect(await chatRefusal(u)).toBe("day");
    }
  });

  it("the route's 429 says which window refused, with the account's own ceiling, never reaches the model and counts no message", async () => {
    const u = await newUser("ct-429");
    await signIn(u.email);
    await db.set(`rate:chat:d:${u.email}`, CHAT_CAPS.trial.day, 86400);
    const res = await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا", stream: true }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after"), "the day's window (rule 680)").toBe("86400");
    const body = (await res.json()) as { error: string; retry: string; message: { content: string } };
    expect([body.error, body.retry]).toEqual(["slow_down", "day"]);
    expect(body.message.content).toContain(`(${CHAT_CAPS.trial.day})`);
    expect(sdk.made).toBe(0);
    expect(await db.get(chatTrialKey(u.email)), "the trial's allowance is untouched").toBeNull();

    const p = await paid("ct-429-paid");
    await signIn(p.email);
    await db.set(`rate:chat:h:${p.email}`, CHAT_CAPS.paid.hour, 3600);
    const pr = await chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا" }));
    expect(pr.status).toBe(429);
    const pb = (await pr.json()) as { retry: string; message: { content: string } };
    expect(pb.retry).toBe("hour");
    expect(pb.message.content, "a paid account is told its own hourly ceiling").toContain(`(${CHAT_CAPS.paid.hour})`);
    expect(sdk.made).toBe(0);
  });

  it("MCP ask_noor uses the same buckets and says the account's own ceiling", async () => {
    const u = await newUser("ct-mcp-cap");
    await db.set(`rate:chat:h:${u.email}`, CHAT_CAPS.trial.hour, 3600);
    const r = await askNoor(u.email);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`(${CHAT_CAPS.trial.hour})`);
    expect(sdk.made).toBe(0);
    const p = await paid("ct-mcp-paid");
    await db.set(`rate:chat:h:${p.email}`, CHAT_CAPS.paid.hour - 1, 3600);
    expect((await askNoor(p.email)).isError, "below the ceiling").toBeFalsy();
    expect(sdk.made).toBe(1);
    const again = await askNoor(p.email);
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain(`(${CHAT_CAPS.paid.hour})`);
    expect(sdk.made).toBe(1);
  });
});

describe("every page that sends a chat turn shows a refusal instead of an empty chat (rules 330-331)", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(f) ? [p] : []; });
  it("a client component that POSTs /api/chat raises the subscription dialog on trial_over and shows the 429's message", () => {
    const callers = walk("src/components").filter((f) => readFileSync(f, "utf8").includes('fetch("/api/chat"'));
    expect(callers.map((f) => f.split("/").pop()).sort()).toEqual(["ChatPanel.tsx", "InspoPanel.tsx"]);
    // The chat itself reads the body: `message` into the thread, `limit` into the dialog.
    expect(readFileSync("src/components/app/ChatPanel.tsx", "utf8")).toMatch(/j\.limit === "trial"[\s\S]*raiseLimit\(j\.limit\)/);
    // The inspiration page used to ignore the answer and open an empty chat: the message was gone, with no reason given.
    const inspo = readFileSync("src/components/app/InspoPanel.tsx", "utf8");
    expect(inspo).toMatch(/res\.status === 402 \|\| res\.status === 429/);
    expect(inspo).toMatch(/limitFromError\(j\.error\)/);
    expect(inspo).toMatch(/setRefusal\(j\.message\.content\)/);
    // The month's chat messages used up (pricing phase 2, #237): the chat dialog, with the status the server sent.
    expect(inspo).toMatch(/j\.error === "chat_allowance" \|\| j\.error === "chat_credits"\) raiseLimit\(j\.error === "chat_allowance" \? "chat" : "chat_credits", \{ period: j\.chat\?\.period/);
    expect(inspo.indexOf("return;"), "no navigation after a refusal").toBeLessThan(inspo.indexOf("r.push("));
  });
});
