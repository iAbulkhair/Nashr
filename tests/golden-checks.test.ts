import { describe, expect, it } from "vitest";
import { GOLDEN_BRANDS, GOLDEN_CASES, hardChecks } from "@/lib/golden";
import { AGENTS, agentForTask } from "@/lib/agents";

const failed = (id: string, items: { channel: string; title: string; body: string }[]) => {
  const c = GOLDEN_CASES.find((x) => x.id === id)!;
  return hardChecks(c, GOLDEN_BRANDS[c.brand], items).filter((x) => !x.pass).map((x) => x.name);
};
const wa = (body: string) => ({ channel: "whatsapp", title: "t", body });

describe("golden set", () => {
  it("covers every agent with unique case ids", () => {
    for (const a of AGENTS) expect(GOLDEN_CASES.some((c) => agentForTask(c.type).id === a.id)).toBe(true);
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
