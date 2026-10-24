import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { newUser } from "./helpers/session";
import { acct } from "@/lib/auth";
import { CAPS, db } from "@/lib/db";
import { saveBrands, type BrandMeta } from "@/lib/brands";
import { KINDS } from "@/lib/usage";
import { MODEL_BUDGET } from "@/lib/model";
import {
  AGENT_SCOPE_DEFAULT_MODES,
  AGENT_SCOPE_KEYS,
  AgentScopeRefused,
  VERDICTS,
  agentScopeRefusalText,
  agentScopeRetryText,
  agentScopeSlowText,
  isVerdict,
  itemHash,
  itemText,
  logAgentScope,
  otherBrandNames,
  parseAgentScopeModes,
  readAgentScopeModes,
  type AgentScopeLogEntry,
  type Verdict,
} from "@/lib/agent-scope";

/**
 * Rules 790, 792 and 793 (agent scope, Part B, spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 6): the pure core every later gate uses. The modes and their per-field fallback, the refusal copy written from
 * the owner's own brand names, the 31-day log and the hash of an item's text.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DEFAULTS = { prompt: "on", input: "shadow", role: "shadow", output: "shadow" };
const entry = (over: Partial<Omit<AgentScopeLogEntry, "at">> = {}): Omit<AgentScopeLogEntry, "at"> => ({
  email: "owner@test.example", brandId: "default", agent: "noor", layer: "input", where: "chat", verdict: "off_topic", mode: "shadow", text: "hello", ...over,
});
const refused = VERDICTS.filter((v): v is Exclude<Verdict, "in"> => v !== "in");

describe("rule 790: the modes", () => {
  it("modes: missing key gives the defaults", async () => {
    expect(await readAgentScopeModes()).toEqual(DEFAULTS);
    expect(AGENT_SCOPE_DEFAULT_MODES).toEqual(DEFAULTS);
    expect(AGENT_SCOPE_KEYS.modes).toBe("agent-scope:modes");
    expect(AGENT_SCOPE_KEYS.evalLast).toBe("agent-scope:eval:last");
    expect(AGENT_SCOPE_KEYS.log("2026-10-10")).toBe("agent-scope:log:2026-10-10");
  });

  it("modes: a bad field falls back per field", async () => {
    await db.set("agent-scope:modes", { input: "enforce", output: "loud" });
    const m = await readAgentScopeModes();
    expect(m.input).toBe("enforce");
    expect(m.output).toBe("shadow");
    expect(m.prompt).toBe("on");
    expect(m.role).toBe("shadow");
    await db.del("agent-scope:modes");
  });

  it("modes: a Redis error gives the defaults", async () => {
    vi.spyOn(db, "get").mockRejectedValueOnce(new Error("down"));
    expect(await readAgentScopeModes()).toEqual(DEFAULTS);
  });

  it("modes: the parser takes only the allowed words, field by field, and never shares the defaults", () => {
    expect(parseAgentScopeModes({ prompt: "off", input: "off", role: "enforce", output: "shadow" })).toEqual({ prompt: "off", input: "off", role: "enforce", output: "shadow" });
    // prompt is on/off only: a mode word there is a bad field.
    expect(parseAgentScopeModes({ prompt: "shadow", input: "ON", role: 1, output: null })).toEqual(DEFAULTS);
    for (const raw of [null, undefined, "enforce", 7, true, [], ["enforce"]]) expect(parseAgentScopeModes(raw)).toEqual(DEFAULTS);
    const a = parseAgentScopeModes(null);
    a.input = "enforce";
    expect(parseAgentScopeModes(null).input).toBe("shadow");
    expect(AGENT_SCOPE_DEFAULT_MODES.input).toBe("shadow");
  });

  it("verdicts: the six words, and nothing else is a verdict", () => {
    expect([...VERDICTS]).toEqual(["in", "off_topic", "pro_advice", "other_business", "personal", "other_brand"]);
    for (const v of VERDICTS) expect(isVerdict(v)).toBe(true);
    for (const x of ["", "IN", "refuse", "constructor", "toString", null, undefined, 1, {}, ["in"]]) expect(isVerdict(x)).toBe(false);
  });

  it("the kind, the classifier's time budget and the log cap exist", () => {
    expect(KINDS).toContain("agent_scope");
    expect(MODEL_BUDGET.AGENT_SCOPE_MS).toBe(3_000);
    expect(CAPS.agentScopeLog).toBe(5000);
  });
});

describe("rule 792: the refusal copy", () => {
  const names = { brand: "Qahwa", otherBrands: ["Qahwa East"] };
  const SCOPE_EN = "Thakeen's team works on marketing, sales, growth, finance and analytics for Qahwa. I can't help with this one.";
  const SCOPE_AR = "فريق ذكين يعمل على التسويق والمبيعات والنمو والمالية والتحليلات لـQahwa. لا أستطيع المساعدة في هذا الطلب.";

  it("refusal copy: each verdict in both languages", () => {
    for (const v of ["off_topic", "pro_advice", "personal"] as const) {
      expect(agentScopeRefusalText(v, "en", names)).toBe(SCOPE_EN);
      expect(agentScopeRefusalText(v, "ar", names)).toBe(SCOPE_AR);
    }
    expect(agentScopeRefusalText("other_business", "en", names)).toBe("This is for another business. Add it as a new brand first, then ask again.");
    expect(agentScopeRefusalText("other_business", "ar", names)).toBe("هذا الطلب لنشاط تجاري آخر. أضفه علامةً جديدة أولاً، ثم اسأل مرة أخرى.");
    expect(agentScopeRefusalText("other_brand", "en", { ...names, classified: "Qahwa East" })).toBe("This is about Qahwa East. Switch to it from the brand menu and ask again.");
    expect(agentScopeRefusalText("other_brand", "ar", { ...names, classified: "Qahwa East" })).toBe("هذا الطلب يخص Qahwa East. انتقل إليها من قائمة العلامات ثم اسأل مرة أخرى.");
    expect(agentScopeSlowText("en")).toBe("Too many requests outside what the team works on. Try again later.");
    expect(agentScopeSlowText("ar")).toBe("طلبات كثيرة خارج عمل الفريق. حاول مرة أخرى لاحقاً.");
    expect(agentScopeRetryText("en")).toBe("This item could not be checked right now. Try again in a minute.");
    expect(agentScopeRetryText("ar")).toBe("تعذّر فحص هذا العنصر الآن. حاول مرة أخرى بعد دقيقة.");
  });

  it("refusal copy: empty brand name reads 'your business'", () => {
    expect(agentScopeRefusalText("off_topic", "en", { brand: "", otherBrands: [] })).toContain("for your business.");
    expect(agentScopeRefusalText("off_topic", "ar", { brand: "", otherBrands: [] })).toContain("لـنشاطك");
    // A name of only spaces is empty too: never "for ." in either language.
    for (const lang of ["en", "ar"] as const) for (const brand of ["", "   ", "\n\t"]) {
      for (const v of refused) expect(agentScopeRefusalText(v, lang, { brand, otherBrands: [] })).not.toMatch(/(for|لـ)\s*\./);
    }
    expect(agentScopeRefusalText("pro_advice", "en", { brand: "  Qahwa  ", otherBrands: [] })).toBe(SCOPE_EN);
  });

  it("refusal copy: other_brand uses the list's spelling, never the classifier's", () => {
    const en = agentScopeRefusalText("other_brand", "en", { brand: "Qahwa", otherBrands: ["Qahwa East"], classified: " qahwa east " });
    expect(en).toContain("Qahwa East");
    expect(agentScopeRefusalText("other_brand", "ar", { brand: "Qahwa", otherBrands: ["Qahwa East"], classified: "QAHWA EAST" })).toContain("Qahwa East");
    const evil = agentScopeRefusalText("other_brand", "en", { brand: "Qahwa", otherBrands: ["Qahwa East"], classified: "Evil <b>" });
    expect(evil).toContain("another of your brands");
    expect(evil).not.toContain("Evil");
    expect(agentScopeRefusalText("other_brand", "ar", { brand: "Qahwa", otherBrands: ["Qahwa East"], classified: "Evil <b>" })).toContain("علامة أخرى من علاماتك");
  });

  it("refusal copy: no match, no classified word, an empty entry or a non-string all give the fallback", () => {
    const fallbackEn = "This is about another of your brands. Switch to it from the brand menu and ask again.";
    const fallbackAr = "هذا الطلب يخص علامة أخرى من علاماتك. انتقل إليها من قائمة العلامات ثم اسأل مرة أخرى.";
    for (const names of [
      { brand: "Q", otherBrands: ["Qahwa East"] },
      { brand: "Q", otherBrands: ["Qahwa East"], classified: "" },
      { brand: "Q", otherBrands: ["Qahwa East"], classified: "Qahwa" },
      { brand: "Q", otherBrands: ["Qahwa East"], classified: "Qahwa East and more" },
      { brand: "Q", otherBrands: ["", "  "], classified: "  " },
      { brand: "Q", otherBrands: [], classified: "Qahwa East" },
      { brand: "Q", otherBrands: ["Qahwa East"], classified: 5 as unknown as string },
    ]) {
      expect(agentScopeRefusalText("other_brand", "en", names)).toBe(fallbackEn);
      expect(agentScopeRefusalText("other_brand", "ar", names)).toBe(fallbackAr);
    }
  });

  it("refusal copy: the first brand in the list that matches wins, written as the list spells it", () => {
    expect(agentScopeRefusalText("other_brand", "en", { brand: "Q", otherBrands: ["Alpha", "  Beta Co "], classified: "beta co" })).toContain("This is about Beta Co. ");
  });

  it("refusal copy: an 'in' verdict that slips through still gets a refusal text, never an empty one", () => {
    expect(agentScopeRefusalText("in" as unknown as "off_topic", "en", names)).toBe(SCOPE_EN);
  });

  it("the refusal error carries the verdict and the reply", () => {
    const e = new AgentScopeRefused("personal", SCOPE_EN);
    expect(e).toBeInstanceOf(Error);
    expect(e.verdict).toBe("personal");
    expect(e.reply).toBe(SCOPE_EN);
  });
});

describe("rule 793: the log", () => {
  const day = "2026-10-10";
  const at = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${day}T12:00:00.000Z`));
  };

  it("log: entry is kept 31 days, text cut to 200", async () => {
    at();
    const key = AGENT_SCOPE_KEYS.log(day);
    const expire = vi.spyOn(db, "expireNx");
    const push = vi.spyOn(db, "lpush");
    const trim = vi.spyOn(db, "ltrim");
    await logAgentScope(entry({ text: "x".repeat(500), itemId: "t1", verdict: "error", error: "timeout" }));
    const rows = await db.lrange(key, 0, -1);
    expect(rows).toHaveLength(1);
    const e = JSON.parse(rows[0]) as AgentScopeLogEntry;
    expect(e.text.length).toBe(200);
    expect(e).toMatchObject({ at: `${day}T12:00:00.000Z`, email: "owner@test.example", brandId: "default", agent: "noor", layer: "input", where: "chat", verdict: "error", error: "timeout", mode: "shadow", itemId: "t1" });
    // The memory store keeps a TTL only on plain keys, so the call is what is pinned: 31 days, set once, after the push.
    expect(2678400).toBe(31 * 86400);
    expect(expire).toHaveBeenCalledWith(key, 2678400);
    expect(trim).toHaveBeenCalledWith(key, 5000);
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(expire.mock.invocationCallOrder[0]);
  });

  it("log: the key is the UTC day, so 23:59:59Z stays on that day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T23:59:59.000Z"));
    await logAgentScope(entry({ text: "late" }));
    expect(await db.lrange(AGENT_SCOPE_KEYS.log("2026-11-03"), 0, -1)).toHaveLength(1);
    expect(await db.lrange(AGENT_SCOPE_KEYS.log("2026-11-04"), 0, -1)).toHaveLength(0);
  });

  it("log: a long error is cut too, and a short text is kept as it is", async () => {
    at();
    const key = AGENT_SCOPE_KEYS.log(day);
    await db.del(key);
    await logAgentScope(entry({ text: "مرحبا", verdict: "error", error: "e".repeat(900) }));
    const e = JSON.parse((await db.lrange(key, 0, -1))[0]) as AgentScopeLogEntry;
    expect(e.text).toBe("مرحبا");
    expect(e.error?.length).toBe(200);
  });

  it("log: a failing store never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "lpush").mockRejectedValue(new Error("down"));
    await expect(logAgentScope(entry())).resolves.toBeUndefined();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "expireNx").mockRejectedValue(new Error("down"));
    await expect(logAgentScope(entry())).resolves.toBeUndefined();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "ltrim").mockImplementation(() => { throw new Error("sync down"); });
    await expect(logAgentScope(entry())).resolves.toBeUndefined();
  });

  it("log: a failure is reported by name only, never with the owner's text", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "lpush").mockRejectedValue(new Error("secret-token-in-message"));
    await logAgentScope(entry({ text: "owner words" }));
    const printed = JSON.stringify(err.mock.calls);
    expect(printed).not.toContain("secret-token-in-message");
    expect(printed).not.toContain("owner words");
  });
});

describe("rule 793: the item hash", () => {
  const t = { title: "Title", body: "Body" };

  it("itemText is the title, a blank line and the edited body when there is one", () => {
    expect(itemText(t)).toBe("Title\n\nBody");
    expect(itemText({ ...t, editedBody: "Edited" })).toBe("Title\n\nEdited");
    expect(itemText({ ...t, editedBody: undefined })).toBe("Title\n\nBody");
  });

  it("itemHash changes when editedBody changes", () => {
    const base = itemHash(t);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).toBe(createHash("sha256").update("Title\n\nBody").digest("hex"));
    expect(itemHash({ ...t })).toBe(base);
    const edited = itemHash({ ...t, editedBody: "Body, changed" });
    expect(edited).not.toBe(base);
    expect(edited).toBe(createHash("sha256").update("Title\n\nBody, changed").digest("hex"));
    expect(itemHash({ ...t, editedBody: "Body" })).toBe(base);
    expect(itemHash({ ...t, title: "Other" })).not.toBe(base);
  });
});

describe("rule 792: the owner's other brands", () => {
  const meta = (id: string, name: string, status: BrandMeta["status"] = "active"): BrandMeta => ({ id, name, createdAt: "2026-10-01T00:00:00.000Z", status });
  const file = (name: string) => ({ name, website: "", industry: "", dialect: "msa", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-10-01T00:00:00.000Z" });

  it("otherBrandNames lists the other brands with the default brand's real name", async () => {
    const u = await newUser("scope-brands");
    await Promise.all([db.set(`brand:${acct(u)}`, file("Main Co")), saveBrands(acct(u), [meta("default", ""), meta("b2", "Second")])]);
    expect(await otherBrandNames({ ...u, brandId: "b2" })).toEqual(["Main Co"]);
    expect(await otherBrandNames({ ...u, brandId: "default" })).toEqual(["Second"]);
    // No active brand on the user means the default one.
    expect(await otherBrandNames({ ...u, brandId: undefined })).toEqual(["Second"]);
  });

  it("otherBrandNames reads the brand list and the default brand file, and nothing else", async () => {
    const u = await newUser("scope-brands-round");
    await Promise.all([db.set(`brand:${acct(u)}`, file("Main Co")), saveBrands(acct(u), [meta("default", ""), meta("b2", "Second"), meta("b3", "Third")])]);
    const get = vi.spyOn(db, "get");
    await otherBrandNames({ ...u, brandId: "b2" });
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([`brand:${acct(u)}`, `brands:${acct(u)}`]);
  });

  it("otherBrandNames drops empty names and has none to list for an account with one brand", async () => {
    const u = await newUser("scope-brands-empty");
    // The default brand has no file yet (an owner who never filled it in): its name is empty, so it is dropped.
    await saveBrands(acct(u), [meta("default", ""), meta("b2", "Second"), meta("b3", "   "), meta("b4", "")]);
    expect(await otherBrandNames({ ...u, brandId: "b2" })).toEqual([]);
    expect(await otherBrandNames({ ...u, brandId: "default" })).toEqual(["Second"]);
    const solo = await newUser("scope-brands-solo");
    expect(await otherBrandNames({ ...solo, brandId: "default" })).toEqual([]);
  });

  it("otherBrandNames names only this account's brands", async () => {
    const [a, b] = await Promise.all([newUser("scope-brands-a"), newUser("scope-brands-b")]);
    await Promise.all([saveBrands(acct(a), [meta("default", ""), meta("b2", "A Second")]), saveBrands(acct(b), [meta("default", ""), meta("b2", "B Second")])]);
    expect(await otherBrandNames({ ...a, brandId: "default" })).toEqual(["A Second"]);
    expect(await otherBrandNames({ ...b, brandId: "default" })).toEqual(["B Second"]);
  });
});
