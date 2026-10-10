import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { getUser, saveUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Brand } from "@/lib/brand";
import { appDict } from "@/lib/app-i18n";
import { entitlements } from "@/lib/entitlements";
import { writeFile } from "@/lib/files";
import { skippedCount } from "@/lib/agent-instructions";
import { activate, diffSets as storeDiffSets, editBase, getLayer, saveDraft, type Draft, type Revision } from "@/lib/instructions-store";
import { diffSets, summarizeRevision } from "@/lib/instructions-diff";
import { testOptionsFor, testPrice } from "@/lib/instructions-test";
import { INSTRUCTION_ERROR_CODES, agentsControl, editBaseOf, errorText, formAfterWrite, newNonce, parseTestResult, restoreBlocked, sameDrafts, showRefs, toDraft } from "@/lib/instructions-ui";
import InstructionEditor from "@/components/app/InstructionEditor";
import * as activateRoute from "@/app/api/instructions/activate/route";
import * as restoreRoute from "@/app/api/instructions/restore/route";
import { saveConnection } from "@/lib/connectors/store";
import { TEST_BRIEF_CHARS } from "@/lib/instructions-safety";
import { AGENT_IDS } from "@/lib/agents";
import { DRAFT_TYPES } from "@/lib/tasks";
import { generateRouteFor } from "@/lib/models/overrides";
import { countCost } from "@/lib/generate-batch";
import { creditsFor } from "@/lib/models/credits";
import * as testRoute from "@/app/api/instructions/test/route";
import { TestOutput } from "@/components/app/InstructionsPanel";

// The app router only exists inside Next: the page's client component gets a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// The test route calls the model: a recorder stands in, as in tests/instructions-test-route.test.ts.
vi.mock("@/lib/noor", async (orig) => ({
  ...(await orig<typeof import("@/lib/noor")>()),
  generate: async () => [{ channel: "instagram", title: "t", body: "b" }],
}));
import Page from "@/app/[lang]/app/instructions/page";

/**
 * Rule 957: the customer page `/{lang}/app/instructions` (agent skills portal, spec 8.1, task 10). The server renders
 * everything from props (the live set, the draft, the history, the plan's limits, the files, the price of a test) and the
 * browser fetches only when someone acts. Pinned here: the dictionary in both languages, the props (a member reads and
 * cannot test, a trial has no per-agent targets or reference files, `skipped` follows a downgrade, the platform layer is
 * never in them), the price on the Test button is the price the route charges, model and imported text render as plain
 * text, and the sidebar row.
 */

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "" } as unknown as Brand;
const item = (text: string, extra: Partial<Draft> = {}): Draft => ({ text, agents: "all", on: true, ...extra });
type Props = Record<string, unknown>;
// The page returns the panel element: its props are what the browser is sent.
const propsOf = async (lang: "ar" | "en" = "ar"): Promise<Props> => (await Page({ params: Promise.resolve({ lang }) })).props as Props;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const html = async (lang: "ar" | "en" = "ar") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();

async function account(prefix: string, plan: User["plan"], credits = 100): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, plan, credits });
  await db.set(`brand:${u.email}`, brand);
  await signIn(u.email);
  return (await getUser(u.email))!;
}
const by = { kind: "owner" as const, email: "owner@test.example" };
const put = async (u: User, items: Draft[], base?: number) => {
  const r = await saveDraft(sc(u), items, by, { platform: false, ...(base !== undefined ? { base } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.layer;
};
const live = async (u: User, items: Draft[]) => {
  await put(u, items);
  const r = await activate(sc(u), by, { platform: false, limits: entitlements(u).instructions });
  if (!r.ok) throw new Error(r.error);
  return r;
};

beforeEach(() => signOut());

describe("rule 957: the dictionary", () => {
  const walk = (o: unknown, path = ""): [string, unknown][] =>
    o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => walk(v, path ? `${path}.${k}` : k)) : [[path, o]];

  it("every key under instructions and nav.instructions exists in Arabic and English, non-empty, with the same placeholders", () => {
    const ar = walk(appDict.ar.instructions);
    const en = walk(appDict.en.instructions);
    expect(ar.length).toBeGreaterThan(60);
    expect(ar.map(([k]) => k)).toEqual(en.map(([k]) => k));
    for (const [side, rows] of [["ar", ar], ["en", en]] as const) {
      for (const [k, v] of rows) {
        expect(typeof v, `${side} ${k}`).toBe("string");
        expect((v as string).trim(), `${side} ${k}`).not.toBe("");
      }
    }
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (let i = 0; i < ar.length; i++) expect(holes(ar[i][1] as string), ar[i][0]).toBe(holes(en[i][1] as string));
    expect(appDict.ar.nav.instructions.trim()).not.toBe("");
    expect(appDict.en.nav.instructions.trim()).not.toBe("");
  });

  it("every code a route can answer has a message in both languages, and an unknown code gets the generic one", () => {
    for (const lang of ["ar", "en"] as const) {
      const t = appDict[lang];
      for (const code of INSTRUCTION_ERROR_CODES) {
        const msg = errorText(t, code);
        expect(msg, `${lang} ${code}`).toBeTruthy();
        expect(msg, `${lang} ${code}`).not.toBe(t.instructions.errors.failed);
      }
      expect(errorText(t, "something_new")).toBe(t.instructions.errors.failed);
      expect(errorText(t, undefined)).toBe(t.instructions.errors.failed);
      // A prototype name is not a code (`in` would find it).
      expect(errorText(t, "constructor")).toBe(t.instructions.errors.failed);
    }
    // The codes the spec names are all in the list.
    for (const c of ["injection", "authority", "secret", "too_long", "too_many", "instructions_limit", "per_agent_plan", "refs_plan", "stale", "busy", "no_credits", "agent_cap", "duplicate", "slow_down", "model_paused", "not_connected", "files_full"]) {
      expect(INSTRUCTION_ERROR_CODES).toContain(c);
    }
  });
});

describe("rule 957: the page's props", () => {
  it("an owner: reads and writes, can test, the live set and the draft come from the server with the edit base", async () => {
    const u = await account("p957a", "pro");
    await live(u, [item("Keep it short")]);
    await put(u, [item("Keep it short"), item("Mention the menu")]);
    const p = await propsOf();
    expect(p.readOnly).toBe(false);
    expect(p.canTest).toBe(true);
    const layer = p.layer as { active: { items: { text: string }[] }; draft: { items: { text: string }[] } };
    expect(layer.active.items.map((i) => i.text)).toEqual(["Keep it short"]);
    expect(layer.draft.items.map((i) => i.text)).toEqual(["Keep it short", "Mention the menu"]);
    expect(p.base).toBe(editBase(await getLayer(sc(u))));
    expect(p.limits).toEqual(entitlements(u).instructions);
    expect(p.skipped).toBe(0);
    expect((p.history as unknown[]).length).toBe(1);
  });

  it("a member: read only, cannot test; the page still lists the set and the history", async () => {
    const owner = await account("p957b", "pro");
    await live(owner, [item("Never promise delivery dates")]);
    const m = await newMember(owner, "member");
    signOut();
    await signIn(m.email);
    const p = await propsOf();
    expect(p.readOnly).toBe(true);
    expect(p.canTest).toBe(false);
    expect(p.testOptions).toEqual([]);
    expect(JSON.stringify(p.layer)).toContain("Never promise delivery dates");
    expect((p.history as unknown[]).length).toBe(1);
    const page = await html("en");
    expect(page).toContain(appDict.en.readOnly.admin);
  });

  it("an admin member can write and test (instructions.write and instructions.test are admin)", async () => {
    const owner = await account("p957c", "pro");
    const a = await newMember(owner, "admin");
    signOut();
    await signIn(a.email);
    const p = await propsOf();
    expect(p.readOnly).toBe(false);
    expect(p.canTest).toBe(true);
  });

  it("a trial: no per-agent targets, no reference files, no Import", async () => {
    await account("p957d", "trial");
    const p = await propsOf();
    const limits = p.limits as { max: number; perAgent: boolean; refs: boolean };
    expect(limits).toMatchObject({ max: 3, perAgent: false, refs: false });
    expect(p.googleOn).toBe(false);
  });

  it("skipped is skippedCount of the live set after a pro to starter downgrade", async () => {
    const u = await account("p957e", "pro");
    const items = Array.from({ length: 12 }, (_, i) => item(`Rule number ${i}`));
    await live(u, [...items, item("Only for Noor", { agents: ["noor"] })]);
    await saveUser({ ...(await getUser(u.email))!, plan: "starter" });
    const p = await propsOf();
    const layer = await getLayer(sc(u));
    const starter = entitlements((await getUser(u.email))!).instructions;
    expect(p.skipped).toBe(skippedCount(layer.active, starter));
    // 13 on, starter keeps 10 of the "all" items: the per-agent one and two more are out.
    expect(p.skipped).toBe(3);
  });

  it("the platform layer is never in the props, whatever it holds", async () => {
    const u = await account("p957f", "pro");
    await db.set("skills:platform", { active: { items: [{ id: "aaaaaaaaaaaa", text: "PLATFORM-SECRET-STANDARD-7731", agents: "all", on: true, lock: true, src: "admin", at: new Date().toISOString() }], v: 1 }, draft: { items: [{ id: "bbbbbbbbbbbb", text: "PLATFORM-DRAFT-9902", agents: "all", on: true, src: "admin", at: new Date().toISOString() }], v: 1 }, at: new Date().toISOString(), by: { kind: "founder", email: "f@test.example", imp: "key" } });
    await live(u, [item("My own rule")]);
    for (const lang of ["ar", "en"] as const) {
      const wire = JSON.stringify(await propsOf(lang));
      expect(wire).not.toContain("PLATFORM-SECRET-STANDARD-7731");
      expect(wire).not.toContain("PLATFORM-DRAFT-9902");
      const page = await html(lang);
      expect(page).not.toContain("PLATFORM-SECRET-STANDARD-7731");
    }
  });

  it("who impersonated never reaches the page (history and layer go through the public shapes)", async () => {
    const u = await account("p957g", "pro");
    await saveDraft(sc(u), [item("Helped by support")], { kind: "founder", email: "support@test.example", imp: "founder-console" }, { platform: false });
    await activate(sc(u), { kind: "founder", email: "support@test.example", imp: "founder-console" }, { platform: false, limits: entitlements(u).instructions });
    const wire = JSON.stringify(await propsOf());
    expect(wire).not.toContain("founder-console");
    expect(wire).not.toContain('"imp"');
  });

  it("the history rows carry counts, never the sets (a long history stays small)", async () => {
    const u = await account("p957h", "pro");
    await live(u, [item("One"), item("Two")]);
    // Items keep their ids across versions, so One is unchanged and Two/Three are the difference.
    const kept = (await getLayer(sc(u))).active.items[0];
    await live(u, [{ id: kept.id, text: kept.text, agents: "all", on: true }, item("Three")]);
    const rows = (await propsOf()).history as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ v: 2, count: 2, added: 1, removed: 1, changed: 0 });
    expect(rows[0].before).toBeUndefined();
    expect(rows[0].after).toBeUndefined();
  });

  it("files come from the workspace; refs hold what was imported, with where it came from", async () => {
    const u = await account("p957i", "pro");
    await writeFile(sc(u), "tone.md", "Warm");
    await db.hset(`skillrefs:${sc(u)}`, "ref-menu.md", { source: "gdocs", id: "1AbCdEfGhIjK", title: "Menu", at: "2026-10-10T10:00:00.000Z" });
    const p = await propsOf();
    expect(p.files).toContain("tone.md");
    expect(p.refs).toMatchObject({ "ref-menu.md": { source: "gdocs", title: "Menu" } });
  });

  it("not signed in goes to the login, an unknown language is a 404", async () => {
    signOut();
    await expect(propsOf("ar")).rejects.toMatchObject({ digest: expect.stringContaining("/ar/app/login") });
    await account("p957j", "pro");
    await expect(Page({ params: Promise.resolve({ lang: "fr" }) })).rejects.toBeTruthy();
  });
});

describe("rule 957: the price on the Test button is the price the route charges", () => {
  it("testPrice is two items at the brand's model, and testOptions lists the draft types of agents with task types, not Reem", async () => {
    const u = await account("p957k", "agency");
    for (const type of DRAFT_TYPES) {
      const m = generateRouteFor(u, brand, type).model;
      expect(testPrice(u, brand, type)).toBe(2 * creditsFor(countCost(type, 1), m, "generate", type));
    }
    const options = testOptionsFor(u, brand);
    expect(options.map((o) => o.type).sort()).toEqual([...DRAFT_TYPES].sort());
    expect(options.every((o) => o.agent !== "reem" && (AGENT_IDS as string[]).includes(o.agent))).toBe(true);
    expect(options.every((o) => Number.isInteger(o.price) && o.price >= 2)).toBe(true);
  });

  it("the page ships those prices, and a real test spends exactly the price shown", async () => {
    const u = await account("p957l", "agency");
    await live(u, [item("LIVE")]);
    await put(u, [item("DRAFT")]);
    const p = await propsOf();
    const options = p.testOptions as { agent: string; type: string; price: number }[];
    expect(options.length).toBe(DRAFT_TYPES.length);
    for (const o of options) {
      const before = (await getUser(u.email))!.credits;
      const res = await testRoute.POST(json("/api/instructions/test", "POST", { agent: o.agent, type: o.type, brief: "", confirm: true, nonce: newNonce() }));
      expect(res.status, o.type).toBe(200);
      const body = (await res.json()) as { spent: number };
      expect(body.spent).toBe(o.price);
      expect(before - (await getUser(u.email))!.credits).toBe(o.price);
    }
  });

  it("no brand file or no right to test: no options", async () => {
    const u = await account("p957m", "pro");
    await db.del(`brand:${u.email}`);
    expect(((await propsOf()).testOptions as unknown[]).length).toBe(0);
  });

  it("the brief limit is the one the route enforces", async () => {
    expect(TEST_BRIEF_CHARS).toBe(500);
    const u = await account("p957n", "agency");
    await live(u, [item("LIVE")]);
    await put(u, [item("DRAFT")]);
    const res = await testRoute.POST(json("/api/instructions/test", "POST", { agent: "noor", type: "social", brief: "x".repeat(TEST_BRIEF_CHARS + 1), confirm: true, nonce: newNonce() }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("brief_too_long");
  });
});

describe("rule 957: helpers the browser and the server share", () => {
  it("the edit base the page sends is the store's, for a layer with and without the counter", async () => {
    const u = await account("p957o", "pro");
    const layer = await put(u, [item("a")]);
    expect(editBaseOf(layer)).toBe(editBase(layer));
    const { seq: _seq, ...old } = layer;
    void _seq;
    expect(editBaseOf(old)).toBe(editBase(old));
    expect(editBaseOf({ ...old, draft: null })).toBe(editBase({ ...old, draft: null }));
  });

  it("a nonce per confirmed click: unique, and the shape the route accepts", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("diffSets lives in a pure module and the store still exports the same one", () => {
    expect(storeDiffSets).toBe(diffSets);
  });

  it("summarizeRevision counts what changed and keeps only what the list shows", () => {
    const at = new Date().toISOString();
    const mk = (id: string, text: string, on = true) => ({ id, text, agents: "all" as const, on, src: "owner" as const, at });
    const rev: Revision = { id: "cccccccccccc", v: 3, at, by: { kind: "owner" }, before: { v: 2, items: [mk("a1a1a1a1a1a1", "x"), mk("b2b2b2b2b2b2", "y")] }, after: { v: 3, items: [mk("a1a1a1a1a1a1", "x2"), mk("c3c3c3c3c3c3", "z"), mk("d4d4d4d4d4d4", "w", false)] }, rollbackOf: "eeeeeeeeeeee" };
    expect(summarizeRevision(rev)).toEqual({ id: "cccccccccccc", v: 3, at, by: { kind: "owner" }, rollbackOf: "eeeeeeeeeeee", count: 2, added: 2, removed: 1, changed: 1 });
  });

  it("sameDrafts ignores a stored item's edit time and source but sees text, switch, targets and files", () => {
    const base = { id: "a1a1a1a1a1a1", text: "x", agents: "all" as const, on: true, src: "owner" as const, at: "2026-10-10T00:00:00.000Z" };
    const d = toDraft(base);
    expect(d).toEqual({ id: "a1a1a1a1a1a1", text: "x", agents: "all", on: true });
    expect(sameDrafts([d], [toDraft({ ...base, at: "2027-01-01T00:00:00.000Z", src: "chat" })])).toBe(true);
    expect(sameDrafts([d], [{ ...d, text: "y" }])).toBe(false);
    expect(sameDrafts([d], [{ ...d, on: false }])).toBe(false);
    expect(sameDrafts([d], [{ ...d, agents: ["noor"] }])).toBe(false);
    expect(sameDrafts([d], [{ ...d, refs: ["a.md"] }])).toBe(false);
    expect(sameDrafts([d], [d, { text: "", agents: "all", on: true }])).toBe(false);
  });
});

describe("rule 957: model and imported text render as plain text", () => {
  const T = appDict.en;
  it("the test output escapes HTML in the title and the body, and the channel", async () => {
    const out = (title: string, body: string) => ({ channel: "<b>insta</b>", title, body });
    const el = createElement(TestOutput, { t: T, before: out("<script>alert(1)</script>", "<img src=x onerror=alert(2)> **bold**"), after: out("after", "ok"), spent: 4 });
    const page = await new Response(await renderToReadableStream(el)).text();
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>insta</b>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&lt;img");
    expect(page).toContain(T.instructions.before);
    expect(page).toContain(T.instructions.after);
  });

  it("an instruction's text and an imported title are escaped on the server render", async () => {
    const u = await account("p957p", "pro");
    // Seeded directly: the screening would refuse this text on save, but a stored set must still render as text.
    const at = new Date().toISOString();
    await db.set(`skills:${sc(u)}`, { active: { items: [{ id: "cccccccccccc", text: '<img src=x onerror="alert(1)"> and </textarea><script>alert(3)</script>', agents: "all", on: true, src: "owner", at }], v: 1 }, draft: null, at, by: null });
    await db.hset(`skillrefs:${sc(u)}`, "ref-x.md", { source: "gsheets", id: "1AbCdEfGhIjK", title: "<script>alert(4)</script>", at: "2026-10-10T10:00:00.000Z" });
    const page = await html("en");
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x");
  });
});

describe("rule 957: the server render", () => {
  it("shows the page in both languages with the safety note, the not-covered note and the Test button with its price", async () => {
    const u = await account("p957q", "agency");
    await live(u, [item("LIVE")]);
    await put(u, [item("DRAFT")]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const lang of ["ar", "en"] as const) {
      const T = appDict[lang].instructions;
      const page = await html(lang);
      expect(page).toContain(T.title);
      expect(page).toContain(esc(T.safetyNote));
      expect(page).toContain(esc(T.notCovered));
      const social = ((await propsOf(lang)).testOptions as { type: string; price: number }[])[0];
      expect(page).toContain(T.testButton.replace("{n}", String(social.price)));
    }
    // Nothing is fetched while rendering: the browser asks only when someone acts.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("an empty workspace renders, with the empty state and no Activate", async () => {
    await account("p957r", "starter");
    const page = await html("en");
    expect(page).toContain(appDict.en.instructions.empty);
  });

  it("the founder's pause is shown, so a page does not say rules apply when they do not", async () => {
    await account("p957s", "pro");
    await db.set("skills:paused", "1");
    try {
      expect((await propsOf()).paused).toBe(true);
      expect(await html("en")).toContain(appDict.en.instructions.paused);
    } finally {
      await db.del("skills:paused");
    }
  });
});

describe("rule 957: the sidebar row", () => {
  it("is after Governance, before Activity, for every role (no show.owner gate)", () => {
    const src = readFileSync("src/components/app/Sidebar.tsx", "utf8");
    const gov = src.indexOf("${base}/governance");
    const ins = src.indexOf("${base}/instructions");
    const act = src.indexOf("${base}/activity");
    expect(gov).toBeGreaterThan(0);
    expect(ins).toBeGreaterThan(gov);
    expect(act).toBeGreaterThan(ins);
    const line = src.split("\n").find((l) => l.includes("${base}/instructions"))!;
    expect(line).toContain("N.instructions");
    expect(line).not.toContain("show.");
  });
});

describe("rule 957: the browser does not make requests on its own", () => {
  it("the panel and the editor call fetch only inside handlers, and the nonce is made per confirmed click", () => {
    const panel = readFileSync("src/components/app/InstructionsPanel.tsx", "utf8");
    const editor = readFileSync("src/components/app/InstructionEditor.tsx", "utf8");
    expect(panel).not.toMatch(/useEffect\([\s\S]*?fetch\(/);
    expect(editor).not.toContain("fetch(");
    // The route's Authorization for spending is a body flag set only after the dialog says yes.
    expect(panel).toContain("newNonce()");
    expect(panel).toContain("confirm: true");
    // Model and imported text never go in as HTML except through the safe renderer.
    expect(panel.match(/dangerouslySetInnerHTML/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(editor).not.toContain("dangerouslySetInnerHTML");
  });
});


describe("rule 957: fix round 1 (stale base, downgrade fixes, compare race, no network at render)", () => {
  const render = async (el: Parameters<typeof renderToReadableStream>[0]) => new Response(await renderToReadableStream(el)).text();
  const editorProps = (over: Partial<Parameters<typeof InstructionEditor>[0]> = {}) => ({ t: appDict.en, items: [{ id: "aaaaaaaaaaaa", text: "Only for Noor", agents: ["noor" as const], on: true, refs: ["ref-menu.md"] }], onChange: () => {}, maxChars: 600, targets: [...AGENT_IDS, "media" as const], perAgent: true, refsOn: true, files: ["ref-menu.md"], allowLock: false, readOnly: false, ...over });

  it("after any write the form follows the layer the server returned, with that layer's base (never local rows with a newer base)", () => {
    const at = "2026-10-10T10:00:00.000Z";
    const mk = (text: string, id: string) => ({ id, text, agents: "all" as const, on: true, src: "owner" as const, at });
    const layer = { active: { items: [mk("live", "aaaaaaaaaaaa")], v: 2 }, draft: { items: [mk("their draft", "bbbbbbbbbbbb")], v: 3 }, at, by: null, seq: 7 };
    const f = formAfterWrite(layer);
    expect(f.base).toBe(7);
    expect(f.rows.map((r) => r.text)).toEqual(["their draft"]);
    expect(formAfterWrite({ ...layer, draft: null, seq: undefined }).rows.map((r) => r.text)).toEqual(["live"]);
    expect(formAfterWrite({ ...layer, draft: null, seq: undefined }).base).toBe(2);
  });

  it("restore is blocked while the form has unsaved edits, and the panel says why and disables the button", () => {
    expect(restoreBlocked(true)).toBe(true);
    expect(restoreBlocked(false)).toBe(false);
    const panel = readFileSync("src/components/app/InstructionsPanel.tsx", "utf8");
    expect(panel).toContain("disabled={locked || restoreBlocked(dirty)}");
    expect(panel).toContain("I.restoreNeedsSaved");
    expect(panel).not.toContain("adopt(r.j.layer as Layer, ");
    for (const lang of ["ar", "en"] as const) expect(appDict[lang].instructions.restoreNeedsSaved.trim()).not.toBe("");
  });

  it("a downgraded row that names agents keeps its Applies-to control (only All agents can be picked); a plan with per-agent keeps both", async () => {
    expect(agentsControl(false, true, false)).toEqual({ disabled: false, someDisabled: true });
    expect(agentsControl(false, false, false)).toEqual({ disabled: true, someDisabled: true });
    expect(agentsControl(true, true, false)).toEqual({ disabled: false, someDisabled: false });
    expect(agentsControl(false, true, true).disabled).toBe(true);
    const down = await render(createElement(InstructionEditor, editorProps({ perAgent: false })));
    const select = down.match(/<select[^>]*>/)![0];
    expect(select).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(down).toMatch(/<option value="some" disabled/);
    // A row set to All agents on a plan without per-agent has the control off.
    const plain = await render(createElement(InstructionEditor, editorProps({ perAgent: false, items: [{ id: "aaaaaaaaaaaa", text: "x", agents: "all", on: true }] })));
    expect(plain.match(/<select[^>]*>/)![0]).toMatch(/\sdisabled(=|\s|>)/);
  });

  it("a plan without reference files still shows an attached file with its remove button, and no way to add one", async () => {
    expect(showRefs(false, 1)).toBe(true);
    expect(showRefs(false, 0)).toBe(false);
    expect(showRefs(true, 0)).toBe(true);
    const down = await render(createElement(InstructionEditor, editorProps({ refsOn: false, perAgent: true })));
    expect(down).toContain(appDict.en.instructions.refsRemove.replace("{name}", "ref-menu.md"));
    expect(down).toContain(esc(appDict.en.instructions.refsNotApplied));
    expect(down).not.toContain(`aria-label="${appDict.en.instructions.refsAdd}`);
    const none = await render(createElement(InstructionEditor, editorProps({ refsOn: false, items: [{ id: "aaaaaaaaaaaa", text: "x", agents: "all", on: true }] })));
    expect(none).not.toContain(appDict.en.instructions.refs);
  });

  it("the panel ignores a Compare answer that is not the newest request, and keeps the not-connected link on the code", () => {
    const panel = readFileSync("src/components/app/InstructionsPanel.tsx", "utf8");
    expect(panel).toContain("++cmpToken.current");
    expect(panel).toContain("if (cmpToken.current !== mine) return;");
    expect(panel).toContain('impCode === "not_connected"');
    expect(panel).not.toContain('impErr === errorText');
    expect(panel).not.toContain("refreshSkipped");
  });

  it("a test answer is checked before it is rendered: a missing field or a wrong type is not a result", () => {
    const item = { channel: "instagram", title: "t", body: "b" };
    expect(parseTestResult({ ok: true, before: item, after: item, spent: 6 })).toEqual({ before: item, after: item, spent: 6 });
    expect(parseTestResult({ before: item, after: { ...item, body: 4 }, spent: 6 })).toBeNull();
    expect(parseTestResult({ before: item, after: null, spent: 6 })).toBeNull();
    expect(parseTestResult({ before: item, after: item, spent: "6" })).toBeNull();
    expect(parseTestResult({})).toBeNull();
  });

  it("activate and restore answer the number of items the plan leaves out, so the page asks for no other history", async () => {
    const u = await account("p957z1", "pro");
    const items = Array.from({ length: 12 }, (_, i) => item(`Rule number ${i}`));
    await live(u, [...items, item("Only for Noor", { agents: ["noor"] })]);
    const first = (await getLayer(sc(u))).active.items;
    await saveUser({ ...(await getUser(u.email))!, plan: "starter" });
    const limits = entitlements((await getUser(u.email))!).instructions;
    // A restore of the live version is refused by the plan today; a smaller set goes live and restore of it answers its count.
    await put(u, first.slice(0, 3).map((i) => ({ id: i.id, text: i.text, agents: "all" as const, on: true })));
    const act = await activateRoute.POST();
    expect(act.status).toBe(200);
    const body = (await act.json()) as { skipped: number; revision: { id: string } };
    expect(body.skipped).toBe(skippedCount((await getLayer(sc(u))).active, limits));
    const rest = await restoreRoute.POST(json("/api/instructions/restore", "POST", { revisionId: body.revision.id }));
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as { skipped: number }).skipped).toBe(skippedCount((await getLayer(sc(u))).active, limits));
  });

  it("the page never waits on Composio: with it on and a Google login stored, Import is offered from the stored record and nothing is fetched", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_PROVIDERS", "google_workspace");
    try {
      const u = await account("p957z2", "pro");
      await saveConnection(sc(u), { provider: "google_workspace", data: { googledocs: "ca_DOCS" }, meta: { via: "composio" }, connectedAt: new Date().toISOString() });
      const spy = vi.spyOn(globalThis, "fetch");
      const p = await propsOf();
      expect(p.googleOn).toBe(true);
      await html("en");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
