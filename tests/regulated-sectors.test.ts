import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCLAIMER, REGULATED_SECTORS, cutKeepingDisclaimer, regulatedSector, withDisclaimer, type Sector } from "@/lib/regulated";
import { postToX } from "@/lib/connectors/x";
import type { Connection } from "@/lib/connectors/store";
import { readFileSync } from "node:fs";
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

describe("rule 1524: the X cut keeps a regulated brand's disclaimer and trims the body", () => {
  afterEach(() => vi.unstubAllGlobals());
  const long = (n: number, ch = "ق") => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? " " : ch)).join("");

  it("a long regulated post ends with its whole disclaimer, within 280 characters, in either language", () => {
    for (const sector of REGULATED_SECTORS) {
      for (const [body, lang] of [[long(400), "ar"], [long(400, "a"), "en"]] as const) {
        const post = withDisclaimer(body, sector);
        expect(post.length).toBeGreaterThan(280);
        const cut = cutKeepingDisclaimer(post, 280);
        expect(cut.length, `${sector} ${lang}`).toBeLessThanOrEqual(280);
        expect(cut.endsWith(`\n\n${DISCLAIMER[sector][lang]}`), `${sector} ${lang}`).toBe(true);
        expect(post.startsWith(cut.slice(0, cut.length - DISCLAIMER[sector][lang].length - 2)), "the body is trimmed, not rewritten").toBe(true);
      }
    }
  });

  it("other text is cut as before; a short post and a line moved by an edit are handled", () => {
    const plain = long(400);
    expect(cutKeepingDisclaimer(plain, 280)).toBe(plain.slice(0, 280));
    const short = withDisclaimer("نص قصير", "health");
    expect(cutKeepingDisclaimer(short, 280)).toBe(short);
    // The owner's edit put the line first: it still survives, at the end.
    const moved = `${DISCLAIMER.finance.ar}\n\n${long(400)}`;
    const cut = cutKeepingDisclaimer(moved, 280);
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut.endsWith(DISCLAIMER.finance.ar)).toBe(true);
    expect(cut.split(DISCLAIMER.finance.ar)).toHaveLength(2);
    // Never half an emoji at the cut.
    const emoji = cutKeepingDisclaimer(withDisclaimer("😀".repeat(200), "legal"), 280);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]\n/);
  });

  it("postToX sends the cut text, with the disclaimer, to X; the Composio path uses the same cut", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push((JSON.parse(String(init.body)) as { text: string }).text);
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 200 });
    });
    const c = { data: { access_token: "t" } } as unknown as Connection;
    await postToX(c, withDisclaimer(long(500), "real_estate"));
    expect(sent[0].length).toBeLessThanOrEqual(280);
    expect(sent[0].endsWith(DISCLAIMER.real_estate.ar)).toBe(true);
    const via = readFileSync("src/lib/connectors/via-composio.ts", "utf8");
    expect(via).toContain('"TWITTER_CREATION_OF_A_POST", { text: cutKeepingDisclaimer(text, CHANNEL_LIMITS.x) }');
    expect(via).not.toMatch(/text\.slice\(0, 280\)/);
  });
});
