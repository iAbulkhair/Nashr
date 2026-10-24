import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Line notes on a draft, sent in one revision (rules 2490-2499; pattern 3 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md).
 * The real route and pipeline run over a scripted SDK: the revision's reply, a failure, or a write that lands while the agent
 * works. The agent-scope classifier is mocked so a test sets its verdict.
 */
const h = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fail" | "empty",
  reply: { title: "", body: "" },
  calls: [] as { system: unknown; messages: { content: string }[] }[],
  during: null as null | (() => Promise<unknown>),
  state: "on" as "on" | "paused" | "mock",
}));
vi.mock("@anthropic-ai/sdk", () => {
  const msg = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = {
        messages: {
          stream: (p: { system: unknown; messages: { content: string }[] }) => ({
            finalMessage: async () => {
              h.calls.push(p);
              const during = h.during;
              h.during = null;
              await during?.();
              if (h.mode === "fail") throw new Error("upstream down");
              return msg(h.mode === "empty" ? "[]" : JSON.stringify([{ channel: "instagram", ...h.reply }]));
            },
          }),
        },
      };
      messages = { create: async () => msg("[]"), stream() { return { finalMessage: async () => msg("[]") }; } };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => h.state }));
const cls = vi.hoisted(() => ({ verdict: "in" as string, calls: [] as { kind: string; text: string }[] }));
vi.mock("@/lib/agent-scope-classify", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent-scope-classify")>()),
  classify: async (input: { kind: string; text: string }) => {
    cls.calls.push(input);
    return { ok: true, verdict: cls.verdict };
  },
}));

import { db } from "@/lib/db";
import { getUser, saveUser, sc, type User } from "@/lib/auth";
import { getTask, listPreferences, saveBrand, saveTask, updateTask, type Brand, type Task } from "@/lib/brand";
import { readFile } from "@/lib/files";
import { saveGov } from "@/lib/governance";
import { listActivity } from "@/lib/activity";
import { listDecisions } from "@/lib/decisions";
import { taskVersion } from "@/lib/task-version";
import { AGENT_SCOPE_KEYS } from "@/lib/agent-scope";
import { accountKey, globalKey } from "@/lib/keys";
import { creditsFor } from "@/lib/models/credits";
import { DRAFT_MIN_CREDITS, draftCredits } from "@/lib/task-costs";
import { REVISE_MAX_NOTES, linesOf, parseNotes, revisePrice } from "@/lib/revise";
import { reviseDraft } from "@/lib/noor";
import LineNotes, { LINE_NOTES, MAX_NOTES, NOTE_MAX as UI_NOTE_MAX, errorOf, sendOutcome } from "@/components/app/LineNotes";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NOTE_MAX } from "@/lib/task-notes";
import { acct } from "@/lib/account-id";
import * as reviseRoute from "@/app/api/tasks/[id]/revise/route";
import { json, newMember, newUser, params, settle, signIn, signOut } from "./helpers/session";

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const BODY = "قهوتنا الجديدة وصلت\n\nجرّبها اليوم في فرعنا\n#قهوة";
let seq = 0;
const taskOf = (extra: Partial<Task> = {}): Task => ({ id: `ln${(++seq).toString(16).padStart(14, "0")}`, type: "social", channel: "instagram", title: "قهوة جديدة", body: BODY, status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...extra });
type Res = { ok?: boolean; error?: string; task?: Task; credits?: number; charged?: number; message?: string; need?: number };

async function owner(prefix: string, credits = 50): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, credits });
  await saveBrand(sc(u), brand);
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}
const balance = async (u: User) => (await getUser(acct(u)))!.credits;
const send = async (id: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await reviseRoute.POST(json(`/api/tasks/${id}/revise`, "POST", body, headers), params({ id }));
  return { status: res.status, body: (await res.json()) as Res };
};
const note = (t: Task, line: number, text: string) => ({ line, quote: linesOf(t)[line], note: text });

beforeEach(async () => {
  h.mode = "ok";
  h.reply = { title: "قهوة جديدة", body: "قهوتنا الجديدة وصلت أخيراً\n\nجرّبها اليوم في فرعنا\n#قهوة" };
  h.calls = [];
  h.during = null;
  h.state = "on";
  cls.verdict = "in";
  cls.calls = [];
  await db.del(AGENT_SCOPE_KEYS.modes);
});
afterEach(async () => {
  await settle();
  signOut();
});

describe("rule 2491: notes are anchored to the lines the owner saw", () => {
  const lines = BODY.split("\n");
  it("parseNotes keeps 1-10 notes, one per non-blank line, whose quote is that line, sorted by line", () => {
    expect(parseNotes([{ line: 2, quote: lines[2], note: "  أقصر  " }, { line: 0, quote: lines[0], note: "أوضح" }], lines)).toEqual([
      { line: 0, quote: lines[0], note: "أوضح" },
      { line: 2, quote: lines[2], note: "أقصر" },
    ]);
  });
  it("anything it cannot anchor is null", () => {
    const ok = { line: 0, quote: lines[0], note: "x" };
    for (const bad of [
      undefined, "notes", {}, [],
      Array.from({ length: REVISE_MAX_NOTES + 1 }, () => ok),
      [{ ...ok, line: 9 }], [{ ...ok, line: -1 }], [{ ...ok, line: 0.5 }], [{ ...ok, line: "0" }],
      [{ ...ok, quote: "نص آخر" }],
      [{ line: 1, quote: lines[1], note: "x" }], // a blank line
      [ok, { ...ok, note: "y" }], // two notes on one line
      [{ ...ok, note: "" }], [{ ...ok, note: "\u202e\u200f " }], [{ ...ok, note: 5 }],
      [null],
    ]) expect(parseNotes(bad, lines), JSON.stringify(bad)).toBeNull();
  });
  it("a note is one cleaned line of at most NOTE_MAX characters, and the inbox uses the same limits", () => {
    const [n] = parseNotes([{ line: 0, quote: lines[0], note: `اجعلها\n## عنوان\u2028${"ب".repeat(400)}` }], lines)!;
    expect(n.note).not.toMatch(/[\n\u2028]/);
    expect(n.note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(UI_NOTE_MAX).toBe(NOTE_MAX);
    expect(MAX_NOTES).toBe(REVISE_MAX_NOTES);
  });

  it("a request without a version, or sent from an older view, is refused before anything is charged", async () => {
    const u = await owner("ln-ver");
    const t = taskOf();
    await saveTask(sc(u), t);
    expect((await send(t.id, { notes: [note(t, 0, "أوضح")] })).body.error).toBe("version_required");
    await updateTask(sc(u), t.id, (cur) => ({ ...cur, editedBody: "نص الزميل\nسطر" }));
    const late = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("changed");
    expect(late.body.task?.editedBody).toBe("نص الزميل\nسطر");
    // Notes on the text as it is now anchor to the edited lines.
    const now = (await getTask(sc(u), t.id))!;
    const stale = await send(t.id, { version: taskVersion(now), notes: [note(t, 0, "أوضح")] });
    expect(stale.body.error, "the old line's text is not a line of the current text").toBe("bad_notes");
    expect(h.calls).toHaveLength(0);
    expect(await balance(u)).toBe(50);
  });
});

describe("rule 2490: only a pending draft-type item, for a role that may edit", () => {
  it("not signed in is 401; another type is not_revisable; a decided item is not_pending; nothing is charged", async () => {
    signOut();
    expect((await send("x", {})).status).toBe(401);
    const u = await owner("ln-type");
    const article = taskOf({ type: "article", channel: "blog" });
    const approved = taskOf({ status: "approved" });
    await Promise.all([saveTask(sc(u), article), saveTask(sc(u), approved)]);
    expect((await send(article.id, { version: taskVersion(article), notes: [note(article, 0, "x")] })).body.error).toBe("not_revisable");
    const late = await send(approved.id, { version: taskVersion(approved), notes: [note(approved, 0, "x")] });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("not_pending");
    expect((await send("ffffffffffffffff", { version: "v", notes: [] })).status).toBe(404);
    expect(h.calls).toHaveLength(0);
    expect(await balance(u)).toBe(50);
  });

  it("a member may send line notes; the owner's account is charged", async () => {
    const u = await owner("ln-member");
    const t = taskOf();
    await saveTask(sc(u), t);
    const m = await newMember(u, "member");
    await signIn(m.email);
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(r.status).toBe(200);
    expect(await balance(u)).toBe(50 - revisePrice(u, brand, "social")!);
  });
});

describe("rule 2492: one draft's price, charged before the call and refunded on any failure", () => {
  it("the price is draftCredits(type, 1) at the model's tier, at least the type's draft minimum, and none for a type that is not a draft type", async () => {
    const u = await owner("ln-price");
    const p = revisePrice(u, brand, "social");
    expect(p).toBeGreaterThan(0);
    // Sonnet 5.5 on social is x0.5, so 1 credit by the tier alone; social's draft minimum makes it 2 (rule 4032).
    expect(creditsFor(draftCredits("social", 1), "claude-sonnet-5-5", "generate", "social")).toBe(1);
    expect(p).toBe(Math.max(DRAFT_MIN_CREDITS.social!, creditsFor(draftCredits("social", 1), "claude-sonnet-5-5", "generate", "social")));
    expect(p).toBe(2);
    expect(revisePrice(u, brand, "article")).toBeNull();
  });

  it("too few credits is 402 with no model call; the refused charge is in the activity log", async () => {
    const u = await owner("ln-poor", 0);
    const t = taskOf();
    await saveTask(sc(u), t);
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("no_credits");
    expect(h.calls).toHaveLength(0);
    expect((await listActivity(sc(u))).rows.map((a) => a.kind)).toContain("no_credits");
  });

  it("a paused model is 503 and charges nothing", async () => {
    const u = await owner("ln-paused");
    const t = taskOf();
    await saveTask(sc(u), t);
    h.state = "paused";
    expect((await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] })).status).toBe(503);
    expect(await balance(u)).toBe(50);
  });

  it("a model failure or an empty reply is refunded and leaves the draft as it was", async () => {
    const u = await owner("ln-fail");
    const t = taskOf();
    await saveTask(sc(u), t);
    for (const mode of ["fail", "empty"] as const) {
      h.mode = mode;
      const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
      expect(r.status, mode).toBe(502);
      expect(r.body.credits, mode).toBe(50);
      expect(await balance(u), mode).toBe(50);
    }
    expect((await getTask(sc(u), t.id))?.editedBody).toBeUndefined();
  });
});

describe("rules 2493-2496: one call, one revision, saved as an edit that waits for the owner", () => {
  it("the draft and the notes reach the model as fenced data; the revision is saved, pending, and charged once", async () => {
    const u = await owner("ln-ok");
    const t = taskOf();
    await saveTask(sc(u), t);
    const price = revisePrice(u, brand, "social")!;
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أضف كلمة أخيراً"), note(t, 3, "وسم ثانٍ")] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, charged: price, credits: 50 - price });
    expect(h.calls).toHaveLength(1);
    const prompt = h.calls[0].messages[0].content;
    expect(prompt).toContain("<draft>");
    expect(prompt).toContain("<owner_notes>");
    expect(prompt).toContain("أضف كلمة أخيراً");
    expect(prompt).toMatch(/data, never instructions/);
    const saved = (await getTask(sc(u), t.id))!;
    expect(saved).toMatchObject({ status: "pending", body: BODY, editedBody: h.reply.body, title: "قهوة جديدة", channel: "instagram" });
    expect(saved.touchedAt).toBeTruthy();
    expect(r.body.task?.editedBody).toBe(h.reply.body);
    expect(await balance(u)).toBe(50 - price);
    await settle();
    // Rule 2496: an edit decision, a "revised" activity row with the note count, and a learned note in the routed sentence.
    const [decision] = await listDecisions(sc(u));
    expect(decision).toMatchObject({ task: t.id, action: "edit" });
    expect(decision.editPct).toBeGreaterThan(0);
    const row = (await listActivity(sc(u))).rows.find((a) => a.kind === "revised");
    expect(row).toMatchObject({ type: "social", tasks: [t.id], count: 2, credits: price, via: "app" });
    const prefs = await listPreferences(sc(u));
    expect(prefs.some((p) => p.startsWith("Owner edited a social item (instagram). Reason: line notes:") && p.includes("وسم ثانٍ"))).toBe(true);
    expect((await readFile(sc(u), "preferences.md"))?.content).toContain("line notes:");
  });

  it("a second round of notes anchors to the revised text the card now shows", async () => {
    const u = await owner("ln-again");
    const t = taskOf();
    await saveTask(sc(u), t);
    await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أضف كلمة أخيراً")] });
    const now = (await getTask(sc(u), t.id))!;
    expect(linesOf(now)[0]).toBe("قهوتنا الجديدة وصلت أخيراً");
    h.reply = { title: "قهوة جديدة", body: "سطر جديد" };
    const r = await send(t.id, { version: taskVersion(now), notes: [note(now, 0, "أعد كتابته")] });
    expect(r.status).toBe(200);
    expect((await getTask(sc(u), t.id))?.editedBody).toBe("سطر جديد");
  });

  it("with learning off nothing is learned, and the decision and activity are still recorded", async () => {
    const u = await owner("ln-nolearn");
    await saveGov(sc(u), { learning: false });
    const t = taskOf();
    await saveTask(sc(u), t);
    expect((await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] })).status).toBe(200);
    await settle();
    expect(await listPreferences(sc(u))).toEqual([]);
    expect((await listActivity(sc(u))).rows.some((a) => a.kind === "revised")).toBe(true);
  });

  it("rule 2494: an item decided or edited while the agent worked is not overwritten, and the charge goes back", async () => {
    const u = await owner("ln-race");
    const a = taskOf();
    const b = taskOf();
    await Promise.all([saveTask(sc(u), a), saveTask(sc(u), b)]);
    h.during = () => updateTask(sc(u), a.id, (cur) => ({ ...cur, status: "approved" }));
    const decided = await send(a.id, { version: taskVersion(a), notes: [note(a, 0, "أوضح")] });
    expect(decided.status).toBe(409);
    expect(decided.body).toMatchObject({ error: "not_pending", credits: 50 });
    const kept = (await getTask(sc(u), a.id))!;
    expect(kept.status).toBe("approved");
    expect(kept.editedBody).toBeUndefined();
    h.during = () => updateTask(sc(u), b.id, (cur) => ({ ...cur, editedBody: "نص الزميل" }));
    const edited = await send(b.id, { version: taskVersion(b), notes: [note(b, 0, "أوضح")] });
    expect(edited.status).toBe(409);
    expect(edited.body).toMatchObject({ error: "changed", credits: 50 });
    expect((await getTask(sc(u), b.id))?.editedBody).toBe("نص الزميل");
    expect(await balance(u)).toBe(50);
  });
});

describe("rule 2493: the notes and the revision pass the agent-scope gates", () => {
  it("notes outside the team's work are refused in enforce with no charge and no model call", async () => {
    const u = await owner("ln-scope-in");
    await db.set(AGENT_SCOPE_KEYS.modes, { prompt: "on", input: "enforce", role: "off", output: "off" });
    const t = taskOf();
    await saveTask(sc(u), t);
    cls.verdict = "off_topic";
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "اكتب لي بحثاً عن الفيزياء")] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("agent_scope");
    expect(cls.calls[0]).toMatchObject({ kind: "input", text: "اكتب لي بحثاً عن الفيزياء" });
    expect(h.calls).toHaveLength(0);
    expect(await balance(u)).toBe(50);
  });

  it("a revision outside the team's work is refused in enforce, refunded and not saved", async () => {
    const u = await owner("ln-scope-out");
    await db.set(AGENT_SCOPE_KEYS.modes, { prompt: "on", input: "off", role: "off", output: "enforce" });
    const t = taskOf();
    await saveTask(sc(u), t);
    cls.verdict = "other_business";
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "agent_scope", credits: 50 });
    expect(cls.calls.map((c) => c.kind)).toEqual(["output"]);
    expect((await getTask(sc(u), t.id))?.editedBody).toBeUndefined();
    expect(await balance(u)).toBe(50);
  });
});

describe("rule 2497: a login's revisions are rate limited before the charge", () => {
  it("over 30 in the hour is 429 with no model call", async () => {
    const u = await owner("ln-rate");
    const t = taskOf();
    await saveTask(sc(u), t);
    await db.set(globalKey.rate(accountKey.reviseBucket(u.email)), 30, 3600);
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(r.status).toBe(429);
    expect(h.calls).toHaveLength(0);
    expect(await balance(u)).toBe(50);
  });
});

describe("rule 2499: the item is read only from the caller's own scope", () => {
  it("another account's task id is 404 and stays as it was", async () => {
    const a = await owner("ln-iso-a");
    const t = taskOf();
    await saveTask(sc(a), t);
    const b = await owner("ln-iso-b");
    const r = await send(t.id, { version: taskVersion(t), notes: [note(t, 0, "أوضح")] });
    expect(r.status).toBe(404);
    expect(h.calls).toHaveLength(0);
    expect(await getTask(sc(a), t.id)).toEqual(t);
    expect(await balance(b)).toBe(50);
  });
});

describe("rule 2498: the inbox's copy and error mapping", () => {
  it("every refusal the route answers has words in both languages, and an unknown one reads as a failure", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(Object.keys(LINE_NOTES[lang].errors).sort()).toEqual(Object.keys(LINE_NOTES.en.errors).sort());
      expect(LINE_NOTES[lang].send).toContain("{c}");
    }
    expect(errorOf(403)).toBe("forbidden");
    expect(errorOf(429, "slow_down")).toBe("slow_down");
    expect(errorOf(402, "no_credits")).toBe("no_credits");
    expect(errorOf(502, "something_new")).toBe("failed");
  });

  it("the dev mock appends a marker instead of calling the model", async () => {
    h.state = "mock";
    const r = await reviseDraft("social", brand, [], { channel: "instagram", title: "t", body: "b" }, [{ line: 0, quote: "b", note: "x" }], { model: "claude-sonnet-5-5" });
    expect(r.body).toBe("b\n\nDEV MOCK revision: 1 note(s) applied.");
    expect(h.calls).toHaveLength(0);
  });
});

describe("rule 2498: the panel", () => {
  const noop = () => {};
  const render = (lang: "ar" | "en", body: string, price: number) =>
    renderToStaticMarkup(createElement(LineNotes, { task: taskOf({ body }), body, lang, price, onDone: noop, onChanged: noop, onCancel: noop }));

  it("shows every line, a + only on a line with text, the price on the send button and the count, disabled until a note exists", () => {
    const html = render("en", "first line\n\nthird line", 7);
    expect(html).toContain("first line");
    expect(html).toContain("third line");
    expect(html.match(new RegExp(`aria-label="${LINE_NOTES.en.add}"`, "g"))).toHaveLength(2);
    expect(html).toContain(LINE_NOTES.en.send.replace("{c}", "7"));
    expect(html).toContain(LINE_NOTES.en.count.replace("{n}", "0").replace("{max}", String(MAX_NOTES)));
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Send to the agent/);
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("escapes the draft's text and speaks Arabic in Arabic", () => {
    const html = render("ar", "<img src=x onerror=alert(1)>", 3);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain(LINE_NOTES.ar.send.replace("{c}", "3"));
  });

  it("a refusal (402, 409, 429, a failure) keeps the typed notes and says why; only a saved revision clears them", () => {
    const t = taskOf();
    expect(sendOutcome("en", 200, { ok: true, task: t })).toEqual({ clear: true, task: t });
    expect(sendOutcome("en", 402, { error: "no_credits" })).toEqual({ clear: false, error: LINE_NOTES.en.errors.no_credits });
    expect(sendOutcome("ar", 402, { error: "agent_cap" })).toEqual({ clear: false, error: LINE_NOTES.ar.errors.agent_cap });
    expect(sendOutcome("en", 409, { error: "changed", task: t })).toEqual({ clear: false, error: LINE_NOTES.en.errors.changed, changed: t });
    expect(sendOutcome("en", 429, {})).toEqual({ clear: false, error: LINE_NOTES.en.errors.slow_down });
    expect(sendOutcome("en", 502, { error: "failed" })).toEqual({ clear: false, error: LINE_NOTES.en.errors.failed });
    expect(sendOutcome("en", 200, { ok: false })).toMatchObject({ clear: false });
    expect(sendOutcome("en", 422, { error: "agent_scope", message: "Held by the scope check." })).toEqual({ clear: false, error: "Held by the scope check." });
  });
});
