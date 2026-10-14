import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { BANTER, SECTIONS } from "@/lib/home";

const read = (p: string) => readFileSync(p, "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.(ts|tsx)$/.test(d.name) ? [`${dir}/${d.name}`] : []));

describe("site critique 2026-10-14: the small copy fixes (rule 1843)", () => {
  it("counts customers in the masculine: «ثلاثة عملاء», never «ثلاث عملاء»", () => {
    expect(JSON.stringify(BANTER)).toContain("ثلاثة عملاء");
    for (const f of walk("src")) expect(read(f), f).not.toContain("ثلاث عملاء");
  });
  it("ends the FAQ heading with a full stop in both languages, like the other section headings", () => {
    expect(SECTIONS.faq.h.ar).toBe("أسئلة قبل ما تبدأ.");
    expect(SECTIONS.faq.h.en).toBe("Questions before you start.");
  });
  it("spells Instagram «إنستقرام» everywhere in src/", () => {
    for (const f of walk("src")) expect(read(f), f).not.toMatch(/إنستغرام|انستقرام|انستغرام|إنستاقرام/);
  });
});
