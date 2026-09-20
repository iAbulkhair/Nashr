import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { dateFormat } from "../src/lib/dates";

/**
 * Pins the fix for the hydration failure on /ar/app/calendar. `ar-SA` resolves to the Umm al-Qura calendar in
 * WebKit's system ICU and to the Gregorian one in Node's bundled ICU, so the server sent "20 سبتمبر" and Safari
 * rendered "9 ربيع الآخر" over the same Gregorian day numbers. React discarded the server HTML (error #418).
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = sources("src");

describe("date formatting", () => {
  it("resolves Arabic to the Gregorian calendar, the one Node renders on the server", () => {
    expect(dateFormat("ar", { month: "long" }).resolvedOptions().calendar).toBe("gregory");
  });

  it("formats in UTC whatever the caller passes, so a stored YYYY-MM-DD cannot slide a day", () => {
    expect(dateFormat("en", { day: "numeric", timeZone: "America/Chicago" }).resolvedOptions().timeZone).toBe("UTC");
    expect(dateFormat("en", { day: "numeric", month: "short" }).format(new Date("2026-09-20T00:00:00Z"))).toBe("Sep 20");
  });

  it("gives Arabic and English the same calendar day for one instant", () => {
    const d = new Date("2026-09-20T00:00:00Z");
    const ar = dateFormat("ar", { day: "numeric" }).format(d);
    const en = dateFormat("en", { day: "numeric" }).format(d);
    expect(ar).toBe("20");
    expect(ar).toBe(en);
  });

  it("no source file asks for ar-SA", () => {
    // `dates.ts` names the locale to explain why it is banned. The PPTX route passes "ar-SA" as the deck's BCP-47
    // language tag for PowerPoint, which is not a calendar choice and never reaches a formatter.
    const spelling = [join("src", "lib", "dates.ts"), join("src", "app", "api", "tasks", "[id]", "pptx", "route.ts")];
    const bad = FILES.filter((f) => !spelling.includes(f) && /["'`]ar-SA/.test(readFileSync(f, "utf8")));
    expect(bad, "ar-SA is Umm al-Qura in WebKit and Gregorian in Node — use dateFormat()").toEqual([]);
  });

  it("every date formatter goes through dateFormat, so the two rules cannot be forgotten", () => {
    // `seasons.ts` is the one deliberate exception: it asks for the Hijri calendar on purpose, to know when Ramadan
    // falls. It runs only on the server, so no hydration boundary is crossed.
    const allowed = [join("src", "lib", "dates.ts"), join("src", "lib", "seasons.ts")];
    const bad = FILES.filter(
      (f) => !allowed.includes(f) && /new Intl\.DateTimeFormat|toLocale(Date|Time)?String/.test(readFileSync(f, "utf8")),
    );
    expect(bad, "import dateFormat from @/lib/dates instead").toEqual([]);
  });
});
