import { describe, expect, it } from "vitest";
import { GOLDEN_BRANDS, GOLDEN_CASES, GOLDEN_VERSION, hardChecks } from "@/lib/golden";
import { AGENTS, agentForTask } from "@/lib/agents";
import { taskSpec } from "@/lib/noor";

const failed = (id: string, items: { channel: string; title: string; body: string }[]) => {
  const c = GOLDEN_CASES.find((x) => x.id === id)!;
  return hardChecks(c, GOLDEN_BRANDS[c.brand], items).filter((x) => !x.pass).map((x) => x.name);
};
const wa = (body: string) => ({ channel: "whatsapp", title: "t", body });

describe("golden set", () => {
  it("covers every agent with unique case ids", () => {
    // Every agent that owns deliverable types; Reem keeps the owner's to-dos and generates nothing to score.
    for (const a of AGENTS.filter((x) => x.tasks.length > 0)) expect(GOLDEN_CASES.some((c) => agentForTask(c.type).id === a.id)).toBe(true);
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
  });
  it("passes clean WhatsApp copy", () => {
    const good = [wa("هلا {{1}}، طلبك من محمصة ريف ينتظرك في السلة. قهوتنا محمّص طازج وشحن مجاني للطلبات فوق 200 ريال. كمّل طلبك من الرابط. للإيقاف أرسل: إيقاف"), wa("شكراً {{1}} على طلبك من محمصة ريف، من المحمصة لبابك. يسعدنا تقييمك للتجربة عبر الرابط التالي. للإيقاف أرسل كلمة: إيقاف")];
    expect(failed("noor-whatsapp-roastery", good)).toEqual([]);
  });
  it("catches an invented price, a banned word, a missing placeholder and a short batch", () => {
    const bad = [wa("عرض خاص: كيس القهوة بـ 49 ريال فقط، أرخص سعر في السوق! اطلب الآن قبل نفاد الكمية من محمصة ريف واستمتع بالقهوة المختصة.")];
    expect(failed("noor-whatsapp-roastery", bad)).toEqual(expect.arrayContaining(["item count", "banned words absent", "no invented prices", "placeholder {{1}}"]));
  });
  it("does not count a banned word that a compliance note merely quotes", () => {
    const body = 'ابتسامتك تبدأ باستشارة مع الطبيب في عيادات لمسة دبي. احجز تقييمك عبر واتساب. Book your consultation at Lamsa Clinics Dubai today. ملاحظة: لا يحتوي كلمات مثل "مضمون".';
    expect(failed("noor-ads-clinic", [{ channel: "meta", title: "a", body }, { channel: "meta", title: "b", body }])).not.toContain("banned words absent");
  });
});

/** The JSON inside one `<tag>…</tag>` of a fixture, parsed. */
const blockData = (stats: string | undefined, tag: string): unknown => {
  const m = (stats ?? "").match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
  return m ? JSON.parse(m[1]) : undefined;
};

describe("report prompts and the golden set (spec A5)", () => {
  it("Dana's three reports and Majed's review name every data block and the not-read list", () => {
    for (const t of ["weekly_report", "board_deck", "dashboard_spec", "strategy_review"] as const) {
      for (const b of ["WORKSPACE DATA", "STORE DATA", "SITE DATA", "SOCIAL DATA", "AD DATA", "NOT READ"]) expect(taskSpec(t), `${t}: ${b}`).toContain(b);
      expect(taskSpec(t)).toMatch(/only where prev exists/);
      // A change without a previous period is a placeholder that says a second read is needed, never a guess.
      expect(taskSpec(t)).toMatch(/\[رقم\][^.]*needs a second read/);
      // Ad totals come from AD DATA alone: performance-learnings.md holds the latest platform's findings, not totals.
      expect(taskSpec(t)).toMatch(/ad totals only from AD DATA/i);
      expect(taskSpec(t)).toMatch(/exactly as listed[^.]*never add or drop one/);
    }
  });
  it("the golden set has a board deck case and site, social and ad fixtures (version 6)", () => {
    expect(GOLDEN_VERSION).toBe(6);
    const deck = GOLDEN_CASES.find((c) => c.id === "dana-board-deck");
    const report = GOLDEN_CASES.find((c) => c.id === "dana-report-roastery");
    expect(deck?.type).toBe("board_deck");
    expect(agentForTask("board_deck").id).toBe("dana");
    // The deck mirrors the weekly report: the same fictional roastery, the same data and the same placeholder check.
    expect(deck?.brand).toBe("roastery");
    expect(deck?.stats).toBe(report?.stats);
    expect(deck?.must).toEqual(report?.must);
    for (const b of ["WORKSPACE DATA", "<site_data>", "<social_data>", "<ad_data>", "<not_read>"]) expect(deck?.stats).toContain(b);
    // With no store synced, sales and revenue are still said to be absent; traffic and ad spend are not.
    expect(deck?.stats).toContain("Sales and revenue figures are NOT in this data");
    // Social and ad data each hold a part read with its previous period and one read without, so the fixture asks the
    // model to compare where prev exists and to write [رقم] where it does not.
    const social = blockData(deck?.stats, "social_data") as Record<string, unknown>;
    const parts = Object.values(social).filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null);
    expect(parts.some((p) => "prev" in p)).toBe(true);
    expect(parts.some((p) => !("prev" in p))).toBe(true);
    const ads = blockData(deck?.stats, "ad_data") as Record<string, unknown>[];
    expect(ads.some((r) => "prev" in r)).toBe(true);
    expect(ads.some((r) => !("prev" in r))).toBe(true);
    const site = blockData(deck?.stats, "site_data") as { analytics: Record<string, unknown>; search: Record<string, unknown> };
    expect("prev" in site.analytics).toBe(true);
    expect("prev" in site.search).toBe(false);
    expect(blockData(deck?.stats, "not_read")).toEqual(expect.arrayContaining([{ platform: "Google Business Profile", reason: "waiting_approval" }]));
  });
});
