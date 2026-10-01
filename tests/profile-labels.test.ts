import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appDict } from "@/lib/app-i18n";
import ProfilePanel from "@/components/app/ProfilePanel";

/**
 * Every control on the Profile page has a programmatic label (#14). The `L()` helper rendered a bare `<label>` with no
 * `htmlFor`, so a screen reader announced five fields with no name at all and the five social fields only as "@".
 * Rule 373 in docs/system/tests.md.
 */
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const initial = {
  ok: true, role: "owner" as const, me: { name: "Test", email: "o@test.example", lang: "en" as const, role: "owner" as const },
  may: { passwordChange: true, accountDelete: true },
  user: { name: "Test", email: "o@test.example", phone: "+966500000123", plan: "starter", credits: 100, trialEnds: "2026-10-04T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", lang: "en" as const },
  usage: {}, images: 0, mediaCredits: 0, emails: "all", allowance: 1000, nextReset: "2026-11-01",
  brand: { name: "Roastery", website: "roastery.example", sitemap: "", products: "Beans", audience: "Locals", tone: "warm", valueProp: "", social: { instagram: "@roastery" } },
};
const render = (lang: "en" | "ar") => renderToStaticMarkup(createElement(ProfilePanel, { t: appDict[lang], lang, initial }));
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** label text → the control it names, through `for`/`id`; and every control that is neither linked nor wrapped. */
function labelMap(html: string) {
  const labels = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/label>/g)].map((m) => ({ for: m[1], text: decode(m[2]) }));
  const controls = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2], id: /\bid="([^"]+)"/.exec(m[2])?.[1], index: m.index! }));
  // A control inside a <label> (the email preference radios) is labelled by it without for/id.
  const wrapped = (i: number) => html.lastIndexOf("<label", i) > html.lastIndexOf("</label>", i);
  const orphans = controls.filter((c) => !wrapped(c.index) && !labels.some((l) => l.for === c.id));
  return { labels, controls, orphans };
}

describe("every Profile control is named by its label (rule 373)", () => {
  for (const lang of ["en", "ar"] as const) {
    it(`${lang}: no control without a label, and each label names exactly one control`, () => {
      const html = render(lang);
      const { labels, controls, orphans } = labelMap(html);
      expect(controls.length, "the form rendered").toBeGreaterThan(15);
      expect(orphans.map((c) => `${c.tag} ${c.attrs.slice(0, 60)}`)).toEqual([]);
      for (const l of labels) expect(controls.filter((c) => c.id === l.for), l.text).toHaveLength(1);
      expect(new Set(controls.map((c) => c.id).filter(Boolean)).size, "ids are unique").toBe(controls.filter((c) => c.id).length);
    });
  }

  it("the fields the review listed are each reachable by their label text", () => {
    const html = render("en");
    const { labels, controls } = labelMap(html);
    const named = (text: string) => controls.filter((c) => labels.some((l) => l.text === text && l.for === c.id));
    const expected = ["Full name", "Business name", "Phone number", "Email", "App and email language", "instagram", "snapchat", "tiktok", "X (Twitter)", "linkedin", "Company description", "Target customers", "Brand voice", "Value proposition", "Website URL", "Sitemap URL", "Current password", "New password (at least 8 characters)"];
    for (const text of expected) expect(named(text), text).toHaveLength(1);
    expect(named("Phone number")[0].attrs).toContain('name="phone"');
    expect(named("Business name")[0].attrs).toContain('name="business"');
  });
});
