import { describe, expect, it } from "vitest";
import { DISCLAIMER, REGULATED_SECTORS, regulatedSector, withDisclaimer, type Sector } from "@/lib/regulated";
import { initialStatus } from "@/lib/brand-rules";
import { taskFromItem } from "@/lib/generate-batch";

/**
 * Rules 1520-1524: a brand in a regulated sector (health, pharmacy, real estate, law, finance and investment) never has
 * an item approved without a person, whatever governance says, and its customer-facing items carry one plain line saying
 * they are general information. Every other industry keeps auto-approve as before.
 */
const INDUSTRIES: Record<Sector, string[]> = {
  health: ["عيادة أسنان", "مجمع طبي", "Dental clinic", "العيادات الجلدية", "Medical center", "مستشفى خاص"],
  pharmacy: ["صيدلية", "Pharmacy", "صيدليات النهدي"],
  real_estate: ["تطوير عقاري", "Real estate", "شركة عقارية", "Property management"],
  legal: ["مكتب محاماة", "Law firm", "استشارات قانونية", "Lawyer"],
  finance: ["استثمار", "Fintech", "شركة تمويل", "Bank", "تأمين", "Investment advisory"],
};
const OTHERS = ["مقهى مختص", "منتجات طبيعية", "صالون تجميل", "Software developer", "Coffee roastery", "healthy food", "عطور", "Bakery", "", undefined];
const item = (body = "قهوة طازجة كل صباح") => ({ type: "social" as const, channel: "instagram", title: "t", body });

describe("rule 1520: the regulated sectors, from the brand's industry", () => {
  for (const s of REGULATED_SECTORS) it.each(INDUSTRIES[s])(`${s}: %s`, (ind) => expect(regulatedSector(ind)).toBe(s));
  it.each(OTHERS)("not regulated: %s", (ind) => expect(regulatedSector(ind)).toBeNull());
  it("non-string input is not regulated", () => {
    expect(regulatedSector(42)).toBeNull();
    expect(regulatedSector({ industry: "clinic" })).toBeNull();
  });
});

describe("rule 1521: auto-approve is blocked for every regulated sector and allowed for others", () => {
  for (const s of REGULATED_SECTORS) {
    it.each(INDUSTRIES[s])(`${s} (%s): held for a person`, (industry) => {
      expect(initialStatus(true, { banned: "", industry }, item())).toBe("pending");
    });
  }
  it.each(OTHERS)("other industry (%s): auto-approve still approves a clean item", (industry) => {
    expect(initialStatus(true, { banned: "", industry }, item())).toBe("approved");
  });
  it("a brand without an industry field (older brands, external drafts) is unchanged", () => {
    expect(initialStatus(true, { banned: "" }, item())).toBe("approved");
    expect(initialStatus(true, null, item())).toBe("approved");
  });
  it("the batch's own task builder holds a regulated brand's item even with auto-approve on", () => {
    const at = new Date().toISOString();
    const gen = { channel: "instagram", title: "t", body: "ابتسامة أجمل" };
    for (const s of REGULATED_SECTORS) {
      const t = taskFromItem(gen, { type: "social", brand: { banned: "", languages: ["ar"], industry: INDUSTRIES[s][0] }, autoApprove: true, source: "chat", createdAt: at });
      expect(t.status).toBe("pending");
    }
    const other = taskFromItem(gen, { type: "social", brand: { banned: "", languages: ["ar"], industry: "مقهى" }, autoApprove: true, source: "chat", createdAt: at });
    expect(other.status).toBe("approved");
  });
});

describe("rule 1522: a regulated brand's customer-facing items carry a disclaimer line", () => {
  const at = new Date().toISOString();
  it("each sector's line, in the body's language, once", () => {
    for (const s of REGULATED_SECTORS) {
      const ar = withDisclaimer("نص عربي", s);
      expect(ar.endsWith(DISCLAIMER[s].ar)).toBe(true);
      expect(withDisclaimer(ar, s)).toBe(ar);
      const en = withDisclaimer("English body", s);
      expect(en.endsWith(DISCLAIMER[s].en)).toBe(true);
      expect(withDisclaimer(en, s)).toBe(en);
    }
  });
  it("the lines are short and promise nothing", () => {
    for (const s of REGULATED_SECTORS) {
      for (const l of [DISCLAIMER[s].ar, DISCLAIMER[s].en]) {
        expect(l.length).toBeLessThanOrEqual(80);
        expect(l).not.toMatch(/guarantee|ضمان|نضمن|مضمون|best|أفضل/i);
      }
    }
  });
  it("taskFromItem adds it to customer-facing types and leaves internal documents and other brands alone", () => {
    const brand = { banned: "", languages: ["ar" as const], industry: "عيادة أسنان" };
    const post = taskFromItem({ channel: "instagram", title: "t", body: "ابتسامة أجمل" }, { type: "social", brand, source: "chat", createdAt: at });
    expect(post.body.endsWith(DISCLAIMER.health.ar)).toBe(true);
    const plan = taskFromItem({ channel: "doc", title: "t", body: "خطة الأسبوع" }, { type: "weekly_plan", brand, source: "chat", createdAt: at });
    expect(plan.body).toBe("خطة الأسبوع");
    const cafe = taskFromItem({ channel: "instagram", title: "t", body: "قهوة" }, { type: "social", brand: { ...brand, industry: "مقهى" }, source: "chat", createdAt: at });
    expect(cafe.body).toBe("قهوة");
  });
});
