import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dict } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";

/**
 * Rule 317. Thmanyah Serif Display («ثمانية للعناوين») is the heading face, and only the heading face: body text stays
 * IBM Plex Sans Arabic. The Thmanyah Font License (font.thmanyah.com/licenses) allows websites only as part of a
 * packaged product and forbids modifying the files or making them downloadable on their own, so the files stay
 * unmodified under src/app/fonts and reach the browser only through next/font/local, never from public/.
 */
const read = (p: string) => readFileSync(p, "utf8");
const DIR = "src/app/fonts/thmanyah-serif-display";
// sha256 of Thmanyah's own woff2 files as downloaded from font.thmanyah.com: a changed byte means a modified font.
const FILES: Record<string, string> = {
  "thmanyahserifdisplay-Medium.woff2": "e21a2ea53f90d8e57560d34e0f7dd613d0ebd3a6a19a9a2af3e258638f5f6259",
  "thmanyahserifdisplay-Bold.woff2": "d36da84ee5423145415425bdd9c10dc27f57a66afec031bd7b78e662572846ce",
  "thmanyahserifdisplay-Black.woff2": "a057be61138a74a590b9d4d0dce6f6b2926e1c443577ad30eb1d86f11efa0a0b",
};
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("the heading face is Thmanyah, loaded within its license (rule 317)", () => {
  const layout = read("src/app/[lang]/layout.tsx");
  const globals = read("src/app/globals.css");

  it("the layout loads it with next/font/local from the three files, and no Google display font remains", () => {
    expect(layout).toMatch(/import localFont from "next\/font\/local"/);
    for (const f of Object.keys(FILES)) expect(layout).toContain(`../fonts/thmanyah-serif-display/${f}`);
    expect(layout).toMatch(/variable: "--font-thmanyah"/);
    expect(layout).toContain("${thmanyah.variable}");
    expect(layout).not.toMatch(/Readex/);
  });

  it("the files are Thmanyah's own, unmodified, with the license notice beside them", () => {
    for (const [f, sha] of Object.entries(FILES)) {
      expect(createHash("sha256").update(readFileSync(join(DIR, f))).digest("hex"), f).toBe(sha);
    }
    expect(readdirSync(DIR).sort()).toEqual([...Object.keys(FILES), "LICENSE.md"].sort());
    expect(read(join(DIR, "LICENSE.md"))).toMatch(/font\.thmanyah\.com\/licenses/);
  });

  it("no font file is served on its own from public/", () => {
    const served = existsSync("public") ? walk("public") : [];
    expect(served.filter((p) => /thmanyah|\.(woff2?|otf|ttf)$/i.test(p))).toEqual([]);
  });

  it("headings and large type use it; body text keeps IBM Plex Sans Arabic", () => {
    expect(globals).toMatch(/--font-display: var\(--font-thmanyah\);/);
    expect(globals).toMatch(/--font-body: var\(--font-plex-arabic\);/);
    expect(globals).toMatch(/body \{[^}]*font-family: var\(--font-body\)/);
    expect(layout).toContain("${plexArabic.variable}");
  });

  it("the homepage's big type follows it and its running text does not", () => {
    const home = read("src/components/home/home.module.css");
    expect(home).toMatch(/--home-display: var\(--font-display\), /);
    expect(home).not.toMatch(/--home-body:[^;]*font-display/);
    expect(home).toMatch(/\.value \{\s*font-family: var\(--home-body\);/);
  });

  it("the wordmark «ذكين» has the long kaf from the font's Stylistic Alternates on the kaf alone, never kashida", () => {
    // the founder's sample: long kaf, round noon. salt on the whole word would change the noon too, so only the kaf
    // gets it, and the letters are presentation forms so the split never breaks the joining (Safari did with plain text)
    expect(globals).toMatch(/\.wordmark-kaf \{\s*font-feature-settings: "salt" 1;/);
    const wm = read("src/components/Wordmark.tsx");
    expect(wm).toContain('ذ<span className="wordmark-kaf">{"\\uFEDB"}</span>{"\\uFEF4\\uFEE6"}');
    expect(wm).toMatch(/role="img" aria-label=\{name\}/);
    expect(wm).toMatch(/<span aria-hidden="true">/);
    expect(wm).not.toMatch(/\\u0640|ـ/);
    expect(read("src/components/Nav.tsx")).toMatch(/<Wordmark lang=\{lang\} name=\{t\.brand\} \/>/);
    expect(read("src/components/Footer.tsx")).toMatch(/<Wordmark lang=\{lang\} name=\{t\.brand\} \/>/);
    // the app headers too: the signed-out header (login, signup) and the phone header inside the app
    expect(read("src/app/[lang]/app/layout.tsx")).toMatch(/<Wordmark lang=\{lang\} name=\{t\.appName\} \/>/);
    expect(read("src/components/app/Sidebar.tsx")).toMatch(/<Wordmark lang=\{lang\} name=\{t\.appName\} \/>/);
    expect(appDict.ar.appName).toBe(dict.ar.brand);
    // the presentation forms spell the same word the dictionary names
    expect("ذ\uFEDB\uFEF4\uFEE6".normalize("NFKC")).toBe(dict.ar.brand);
    expect(dict.ar.brand).not.toContain("\u0640");
  });

  it("the share card is drawn with the same long-kaf wordmark, and the font never leaves src/app/fonts", () => {
    const s = read("scripts/make-share-image.mjs");
    expect(s).toContain('ذ<span class="kaf">\uFEDB</span>\uFEF4\uFEE6');
    expect(s).toMatch(/\.kaf \{ font-feature-settings: "salt" 1; \}/);
    expect(s).toContain("src/app/fonts/thmanyah-serif-display/");
    expect(s).not.toMatch(/public\/|writeFileSync|copyFile/);
    expect(s).toContain('path: "src/app/[lang]/opengraph-image.png"');
    expect(s).not.toMatch(/\\u0640|ـ/);
  });
});
