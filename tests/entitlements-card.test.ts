import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PlanIncludesCard from "@/components/app/PlanIncludesCard";
import { appDict } from "@/lib/app-i18n";
import { AGENT_IDS, agentById } from "@/lib/agents";
import { entitlements, type EntitlementView } from "@/lib/entitlements";
import type { ChatStatus } from "@/lib/chat-allowance";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS } from "@/lib/media-catalog";
import { formatCount } from "@/lib/pricing";

/**
 * Rule 785: the owner's "What your plan includes" card on the billing page. It is shown from `entitlementView`, so every
 * figure in it comes from the view (or from the media catalogue's labels and the agent roster's names), plus the one scope
 * sentence. These tests render it for fixed views, in both languages, with `renderToStaticMarkup` (vitest includes only
 * `tests/**\/*.test.ts`, so the elements are built with `createElement`, ruling R1).
 */
const NOW = Date.parse("2026-10-08T12:00:00Z");
const SCOPE = {
  en: "Your Thakeen team works on marketing, sales, growth, finance and analytics for your brands.",
  ar: "يعمل فريق ذكين على التسويق والمبيعات والنمو والمالية والتحليلات لعلاماتك التجارية.",
} as const;

const chat = (p: Partial<ChatStatus> & Pick<ChatStatus, "used" | "allowance">): ChatStatus => ({
  left: Math.max(0, p.allowance - p.used), counted: p.used, period: "month",
  overflow: { on: false, available: true, used: 0, credits: 0, hold: 3 }, ...p,
});

/** A paid view with hand-set numbers: Pro, 3 of 5 seats, 40 of 650 chat messages, every video model, every agent. */
const paid = (): EntitlementView => {
  const ent = { ...entitlements({ plan: "pro", trialEnds: "2099-01-01T00:00:00Z" }, NOW), seats: 5, endsAt: null };
  return { ent, base: ent, used: { credits: 512, seats: 3, chat: chat({ used: 40, allowance: 650 }) }, resetsAt: "2026-11-01", grants: { video: null } };
};

const trial = (p: Partial<EntitlementView> = {}): EntitlementView => {
  const ent = entitlements({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" }, NOW);
  return { ent, base: ent, used: { credits: 50, seats: 1, chat: chat({ used: 4, allowance: 30, period: "trial" }) }, resetsAt: null, grants: { video: null }, ...p };
};

const render = (view: EntitlementView, lang: "ar" | "en") => renderToStaticMarkup(createElement(PlanIncludesCard, { view, lang }));
/** The words and numbers a person reads: tags and the comment markers React puts between text pieces removed. */
const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const label = (id: string, lang: "ar" | "en") => MEDIA_MODELS.find((m) => m.id === id)!.label[lang];
const VIDEO = MEDIA_MODELS.filter((m) => m.kind === "video");

describe("the owner's plan-includes card (rule 785)", () => {
  it("a paid plan shows its credits, seats used of the limit, chat used of the allowance, every video model and the agents", () => {
    expect(AGENT_IDS).toHaveLength(8);
    for (const lang of ["en", "ar"] as const) {
      const out = render(paid(), lang);
      const words = text(out);
      expect(words, lang).toContain("700");
      expect(words, lang).toContain("3 / 5");
      expect(words, lang).toContain("40 / 650");
      for (const m of VIDEO) expect(words, `${lang} ${m.id}`).toContain(m.label[lang]);
      expect(words, `${lang} agent count`).toMatch(/(^|\s)8(\s|$)/);
      for (const id of AGENT_IDS) expect(words, `${lang} ${id}`).toContain(agentById(id).name[lang]);
      expect(out, lang).toContain('dir="ltr"');
    }
  });

  it("the scope sentence is there once, exactly, in each language", () => {
    for (const lang of ["en", "ar"] as const) {
      const words = text(render(paid(), lang));
      expect(words.split(SCOPE[lang]), lang).toHaveLength(2);
      expect(appDict[lang].billing.includes.scope, lang).toBe(SCOPE[lang]);
    }
  });

  it("a trial lists only the three trial video models and shows the trial's last day and its own chat count", () => {
    for (const lang of ["en", "ar"] as const) {
      const words = text(render(trial(), lang));
      for (const id of TRIAL_VIDEO_MODELS) expect(words, `${lang} ${id}`).toContain(label(id, lang));
      for (const m of VIDEO.filter((x) => !(TRIAL_VIDEO_MODELS as readonly string[]).includes(x.id))) expect(words, `${lang} ${m.id}`).not.toContain(m.label[lang]);
      expect(words, lang).toContain("2026-10-20");
      expect(words, lang).toContain("4 / 30");
      expect(words, lang).toContain(appDict[lang].billing.includes.chatTrial);
      expect(words, lang).not.toContain(appDict[lang].billing.includes.chat);
    }
  });

  it("an ended trial says the trial ended on its last day, not that it ends then (M2)", () => {
    const ent = entitlements({ plan: "trial", trialEnds: "2026-10-01T00:00:00Z" }, NOW);
    expect(ent.inactive).toBe("trial_over");
    const ended: EntitlementView = { ent, base: ent, used: { credits: 0, seats: 1, chat: chat({ used: 30, allowance: 30, period: "trial" }) }, resetsAt: null, grants: { video: null } };
    expect(appDict.ar.billing.includes.trialEnded).toBe("انتهت التجربة");
    for (const lang of ["en", "ar"] as const) {
      const words = text(render(ended, lang));
      expect(words, lang).toContain(`${appDict[lang].billing.includes.trialEnded} 2026-10-01`);
      expect(words, lang).not.toContain(appDict[lang].billing.includes.trialEnds);
    }
    // A live trial still reads "ends", and the ended label is not shown there.
    for (const lang of ["en", "ar"] as const) {
      const words = text(render(trial(), lang));
      expect(words, lang).toContain(`${appDict[lang].billing.includes.trialEnds} 2026-10-20`);
      expect(words, lang).not.toContain(appDict[lang].billing.includes.trialEnded);
    }
  });

  it("a paid plan names the day it is paid through when it has one, and no end line when it has none", () => {
    const through = paid();
    through.ent = { ...through.ent, endsAt: "2026-11-08" };
    for (const lang of ["en", "ar"] as const) {
      expect(text(render(through, lang)), lang).toContain(`${appDict[lang].billing.includes.paidThrough} 2026-11-08`);
      const none = text(render(paid(), lang));
      expect(none, lang).not.toContain(appDict[lang].billing.includes.paidThrough);
      expect(none, lang).not.toContain(appDict[lang].billing.includes.trialEnds);
    }
  });

  it("a live video grant opens every model on a trial, and the card never shows who set it or the founder's note (ruling R10)", () => {
    const ent = entitlements({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", grants: { video: { value: "all", until: "2026-10-30", by: "founder@secret.example", at: "2026-10-08T00:00:00Z", note: "PRIVATE-NOTE-MARKER" } } }, NOW);
    const view = trial({ ent, base: trial().ent, grants: { video: { value: "all", until: "2026-10-30", by: "founder@secret.example", at: "2026-10-08T00:00:00Z", note: "PRIVATE-NOTE-MARKER", expired: false } } });
    for (const lang of ["en", "ar"] as const) {
      const out = render(view, lang);
      for (const m of VIDEO) expect(out, `${lang} ${m.id}`).toContain(m.label[lang]);
      for (const secret of ["founder@secret.example", "PRIVATE-NOTE-MARKER", "2026-10-30"]) expect(out, `${lang} ${secret}`).not.toContain(secret);
    }
  });

  it("the card has no number of its own: take away what the view supplies and no digit is left", () => {
    // Distinctive figures, so a number typed into the copy cannot hide behind one that happens to match.
    const ent = { ...entitlements({ plan: "business", trialEnds: "2099-01-01T00:00:00Z" }, NOW), seats: 9, endsAt: "2027-03-14" };
    ent.credits = { monthly: 4321 };
    ent.chat = { ...ent.chat, monthly: 1777 };
    const view: EntitlementView = { ent, base: ent, used: { credits: 99, seats: 6, chat: chat({ used: 1234, allowance: 1777 }) }, resetsAt: "2026-11-01", grants: { video: null } };
    for (const lang of ["en", "ar"] as const) {
      let rest = text(render(view, lang));
      // Longest pieces first, so taking out the agent count "8" cannot break a video label that has an 8 in it.
      const fromView = [
        "2027-03-14",
        ...ent.media.video.map((id) => label(id, lang)),
        ...ent.agents.map((id) => agentById(id).name[lang]),
        formatCount(4321), "6 / 9", `${formatCount(1234)} / ${formatCount(1777)}`, String(ent.agents.length),
      ];
      for (const piece of fromView) {
        expect(rest, `${lang} ${piece}`).toContain(piece);
        rest = rest.split(piece).join(" ");
      }
      expect(rest, lang).not.toMatch(/\d/);
    }
    // The strings themselves carry no digit either, in either language.
    for (const lang of ["en", "ar"] as const) {
      for (const [key, value] of Object.entries(appDict[lang].billing.includes)) expect(value, `${lang} ${key}`).not.toMatch(/\d/);
    }
  });

  it("the card is a server component that cannot name the founder's grants (I1, ruling R10)", () => {
    // The markup test above would stay green if a "use client" card put `view.grants` into the page payload: the payload is
    // not text on the page. So pin the structure: no client directive, no mention of `grants` in the code, and a prop type
    // that is only `ent` and `used`. Comments are stripped, they may say what the card never reads.
    const src = readFileSync("src/components/app/PlanIncludesCard.tsx", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src, "a client card would serialize its props into the page").not.toMatch(/^\s*["']use client["']/m);
    expect(code, "the card never names grants").not.toMatch(/\bgrants\b/);
    expect(code).toMatch(/view: Pick<EntitlementView, "ent" \| "used">/);
  });

  it("the billing page reads the view once, shows the card above the chat card, and no longer reads the seats and chat itself", () => {
    const page = readFileSync("src/app/[lang]/app/settings/billing/page.tsx", "utf8");
    expect(page.match(/entitlementView\(u\)/g)).toHaveLength(1);
    expect(page).not.toMatch(/\bseatsUsed\b|\bchatStatus\b/);
    // Founder-only data (`grants`, with the founder's email and note) never leaves the page: the card gets `ent` and `used` only (I1).
    expect(/<PlanIncludesCard view=\{\{ ent: view\.ent, used: view\.used \}\}/.test(page), "the card gets ent and used only").toBe(true);
    const card = page.indexOf("<PlanIncludesCard");
    const chatCard = page.indexOf("<ChatAllowanceCard");
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(chatCard);
  });
});
