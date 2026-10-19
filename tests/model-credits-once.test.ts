import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credits by tier on the claim path (rule 333's `chargeOnce`, plan Task 4 review round 1). A run killed after its charge
 * leaves its hold for the retry; when the retry runs on another model, the hold's credits are not the retry's price. The
 * hold is reused only when its credits equal the batch's price; otherwise it is given back and the batch charged at its
 * own price in the same locked save (no moment with nothing held), and when that charge cannot be paid nothing moves and
 * the hold waits for the daily sweep (rule 337). The balance, the activity row and `BatchDone.cost` always agree with
 * what was finally charged.
 */
const h = vi.hoisted(() => ({ mode: "ok" as "ok" | "hang" }));
vi.mock("@anthropic-ai/sdk", () => {
  const reply = (text: string) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
  // A full batch (10 items, the most any type asks for): a batch of fewer is a short one, charged per item (rule 2276).
  const items = JSON.stringify(Array.from({ length: 10 }, () => ({ channel: "instagram", title: "منشور القهوة", body: "قهوة مختصة في الرياض" })));
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: () => ({ finalMessage: () => (h.mode === "hang" ? new Promise(() => {}) : Promise.resolve(reply(items))) }) } };
      messages = { create: async () => reply(JSON.stringify([{ ok: true }])), stream(p: unknown, o?: unknown) { return { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; } };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Brand } from "@/lib/brand";
import { listActivity } from "@/lib/activity";
import { agentSpendFor, chargeOnce, resolveOnceHolds } from "@/lib/credits";
import { generateBatch, type BatchOpts } from "@/lib/generate-batch";
import { newUser, settle } from "./helpers/session";

// Since 2026-10-09 (rule 809) only the 5.5 models can be picked or routed to; Opus 5 and Sonnet 5 stay for their rates.
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function owner(prefix: string, credits: number): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, credits });
  await db.set(`brand:${u.email}`, brand);
  return (await getUser(u.email))!;
}
const balance = async (email: string) => (await getUser(email))!.credits;
const opts = (claim: string, model?: string): BatchOpts => ({ type: "social", source: "manual", via: "app", once: claim, ...(model ? { model } : {}) });

/** A run on `model` killed after its charge: the platform stops it while it generates, so its hold stays. */
async function killedRun(u: User, claim: string, model: string, price: number) {
  h.mode = "hang";
  const before = await balance(u.email);
  void generateBatch(u, u.email, opts(claim, model));
  for (let i = 0; i < 200 && (await balance(u.email)) === before; i++) await sleep(5);
  expect(await balance(u.email), "the killed run was charged").toBe(before - price);
  expect((await getUser(u.email))!.paidOnce?.[claim]?.credits).toBe(price);
  h.mode = "ok";
}
const generatedRow = async (email: string) => (await listActivity(email, { kind: "generated" })).rows[0];

beforeEach(() => { h.mode = "ok"; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(async () => { await settle(); vi.unstubAllEnvs(); });

describe("a retry on another model never reuses a hold priced for a different model (rule 333 by tier)", () => {
  it("a Sonnet hold of 5, retried on Opus at 10: the 5 is given back and 10 charged; balance, row and cost say 10", async () => {
    const u = await owner("once-up", 40);
    const claim = `weekly:${u.email}:2026-10-04`;
    await killedRun(u, claim, SONNET, 5);
    const r = await generateBatch((await getUser(u.email))!, u.email, opts(claim, OPUS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await getUser(u.email))!;
    expect([r.cost, after.credits, r.credits, after.paidOnce?.[claim]?.credits, agentSpendFor(after, u.email).noor]).toEqual([10, 30, 30, 10, 10]);
    expect((await generatedRow(u.email))?.credits).toBe(10);
  });

  it("an Opus hold of 10, retried on Sonnet at 5: the 10 is given back and 5 charged; balance, row and cost say 5", async () => {
    const u = await owner("once-down", 40);
    const claim = `weekly:${u.email}:2026-10-04`;
    await killedRun(u, claim, OPUS, 10);
    const r = await generateBatch((await getUser(u.email))!, u.email, opts(claim, SONNET));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = (await getUser(u.email))!;
    expect([r.cost, after.credits, r.credits, after.paidOnce?.[claim]?.credits, agentSpendFor(after, u.email).noor]).toEqual([5, 35, 35, 5, 5]);
    expect((await generatedRow(u.email))?.credits).toBe(5);
  });

  it("the same model reuses the hold: nothing more is charged, and the row and cost report the hold's credits", async () => {
    const u = await owner("once-same", 40);
    const claim = `weekly:${u.email}:2026-10-04`;
    await killedRun(u, claim, SONNET, 5);
    const r = await generateBatch((await getUser(u.email))!, u.email, opts(claim, SONNET));
    expect(r.ok && [r.cost, r.receipt.credits]).toEqual([5, 35]);
    expect([await balance(u.email), (await generatedRow(u.email))?.credits]).toEqual([35, 5]);
  });

  it("when the new price cannot be paid nothing moves: the old hold stays for the daily sweep, which gives it back", async () => {
    const u = await owner("once-short", 8);
    const claim = `weekly:${u.email}:2026-10-04`;
    await killedRun(u, claim, SONNET, 5);
    const r = await generateBatch((await getUser(u.email))!, u.email, opts(claim, OPUS));
    expect(r).toMatchObject({ ok: false, reason: "no_credits", need: 10, credits: 3 });
    const after = (await getUser(u.email))!;
    expect([after.credits, after.paidOnce?.[claim]?.credits, agentSpendFor(after, u.email).noor]).toEqual([3, 5, 5]);
    // The hold is not stranded: the sweep of a week with no plan refunds it (rule 337).
    expect((await resolveOnceHolds(u.email, { [claim]: false })).credits).toBe(8);
  });

  it("the ledger: chargeOnce swaps a hold of another price in one save, and reuses one of the same price", async () => {
    const u = await owner("once-ledger", 20);
    const meta = { scope: u.email, agent: "noor" as const };
    expect(await chargeOnce(u.email, 5, meta, "c")).toMatchObject({ ok: true, reused: false, credits: 15 });
    expect(await chargeOnce(u.email, 5, meta, "c")).toMatchObject({ ok: true, reused: true, credits: 15, hold: { credits: 5 } });
    expect(await chargeOnce(u.email, 10, meta, "c")).toMatchObject({ ok: true, reused: false, credits: 10, replaced: 5 });
    expect(await chargeOnce(u.email, 3, meta, "c")).toMatchObject({ ok: true, reused: false, credits: 17, replaced: 10 });
    const after = (await getUser(u.email))!;
    expect([after.paidOnce?.c?.credits, agentSpendFor(after, u.email).noor]).toEqual([3, 3]);
    // Too dear even with the old hold given back: refused, and the record is as it was.
    expect(await chargeOnce(u.email, 30, meta, "c")).toMatchObject({ ok: false, reason: "no_credits", need: 30, credits: 17 });
    expect([(await getUser(u.email))!.credits, (await getUser(u.email))!.paidOnce?.c?.credits]).toEqual([17, 3]);
  });

  it("a swap refused at the agent's cap reports the record as it was: the balance, and the agent's spend with the old hold still in it", async () => {
    const u = await owner("once-cap", 20);
    const meta = { scope: u.email, agent: "noor" as const, cap: 8 };
    expect(await chargeOnce(u.email, 5, meta, "c")).toMatchObject({ ok: true, reused: false, credits: 15, spent: 5, cap: 8 });
    // 10 is over the cap of 8 even with the hold's 5 given back. Nothing is saved, so the refusal says what the record
    // says: 5 spent of 8 (not the 0 the in-memory give-back left before the refusal), 15 credits.
    expect(await chargeOnce(u.email, 10, meta, "c")).toEqual({ ok: false, reason: "agent_cap", credits: 15, agent: "noor", spent: 5, cap: 8 });
    const after = (await getUser(u.email))!;
    expect([after.credits, after.paidOnce?.c?.credits, agentSpendFor(after, u.email).noor]).toEqual([15, 5, 5]);
    // Within the cap with the hold given back (5 spent - 5 + 7 = 7 of 8): the swap goes through.
    expect(await chargeOnce(u.email, 7, meta, "c")).toMatchObject({ ok: true, reused: false, credits: 13, spent: 7, replaced: 5 });
  });
});
