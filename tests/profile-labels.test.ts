import { describe, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appDict } from "@/lib/app-i18n";
import AccountSettings from "@/components/app/settings/AccountSettings";
import BrandExtras from "@/components/app/settings/BrandExtras";
import SecuritySettings from "@/components/app/settings/SecuritySettings";

/**
 * Every control on the account screens has a programmatic label (#14). The old profile page's `L()` helper rendered a
 * bare `<label>` with no `htmlFor`, so a screen reader announced five fields with no name at all and the five social
 * fields only as "@". Rule 373 in docs/system/tests.md. Since UI/UX phase 3 (rule 1140) those fields live in Settings
 * (Account, Brand, Security), each inside a `Field`, which links the label to its control.
 */
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const render = (lang: "en" | "ar") => {
  const t = appDict[lang];
  return renderToStaticMarkup(createElement(Fragment, null,
    createElement(AccountSettings, { lang, forbidden: t.team.errors.forbidden, initial: { name: "Test", email: "o@test.example", lang, phone: "+966500000123", owner: true } }),
    createElement(BrandExtras, { lang, readOnly: false, forbidden: t.team.errors.forbidden, initial: { social: { instagram: "@roastery" }, valueProp: "", sitemap: "" } }),
    createElement(SecuritySettings, { lang, rules: t.join.rules, may: true, owner: true, forbidden: t.team.errors.forbidden, passkeys: { T: t.passkeys, enabled: true } }),
  ));
};
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** label text → the control it names, through `for`/`id`; and every control that is neither linked nor wrapped. */
function labelMap(html: string) {
  const labels = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"[^>]*>([^<]*)(?:<span[^>]*>[^<]*<\/span>)?<\/label>/g)].map((m) => ({ for: m[1], text: decode(m[2]) }));
  const controls = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2], id: /\bid="([^"]+)"/.exec(m[2])?.[1], index: m.index! }));
  // A control inside a <label> (a radio) is labelled by it without for/id.
  const wrapped = (i: number) => html.lastIndexOf("<label", i) > html.lastIndexOf("</label>", i);
  const orphans = controls.filter((c) => !wrapped(c.index) && !labels.some((l) => l.for === c.id));
  return { labels, controls, orphans };
}

describe("every account-settings control is named by its label (rule 373)", () => {
  for (const lang of ["en", "ar"] as const) {
    it(`${lang}: no control without a label, and each label names exactly one control`, () => {
      const html = render(lang);
      const { labels, controls, orphans } = labelMap(html);
      expect(controls.length, "the cards rendered").toBeGreaterThan(10);
      expect(orphans.map((c) => `${c.tag} ${c.attrs.slice(0, 60)}`)).toEqual([]);
      for (const l of labels) expect(controls.filter((c) => c.id === l.for), l.text).toHaveLength(1);
      expect(new Set(controls.map((c) => c.id).filter(Boolean)).size, "ids are unique").toBe(controls.filter((c) => c.id).length);
    });
  }

  it("the fields the review listed are each reachable by their label text", () => {
    const html = render("en");
    const { labels, controls } = labelMap(html);
    const named = (text: string) => controls.filter((c) => labels.some((l) => l.text === text && l.for === c.id));
    // The business name, description, customers, voice and website are the brand form's (rule 1099), which pins its own labels.
    const expected = ["Full name", "Mobile number", "App and email language", "Instagram", "Snapchat", "Tiktok", "X (Twitter)", "Linkedin", "Value proposition", "Sitemap", "Current password", "New password", "Password to confirm"];
    for (const text of expected) expect(named(text), text).toHaveLength(1);
    expect(named("Mobile number")[0].attrs).toContain('name="phone"');
    expect(named("Full name")[0].attrs).toContain('name="name"');
  });
});
