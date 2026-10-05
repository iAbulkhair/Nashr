/**
 * Reem's role (founder, 2026-10-05). Rules 609-611: she works for one Thakeen customer, within the Thakeen contract and
 * only on the marketing work that serves the brand; she follows the team but never assigns it work or plans its time;
 * and she declines what is outside that scope. The scope is held by her persona and playbook (a prompt); what code holds
 * is the data boundary (every key from `sc(u)`, rules 101-103). The product copy says the same thing in both languages.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { User } from "@/lib/auth";
import { system } from "@/lib/chat";
import { AGENTS } from "@/lib/agents";
import { appDict } from "@/lib/app-i18n";
import { AGENT_PAGES } from "@/lib/site";
import { HELP } from "@/lib/help";

const reem = AGENTS.find((a) => a.id === "reem")!;
const playbook = readFileSync("content/skills/secretary.md", "utf8");

describe("rule 609: Reem's persona and playbook keep her to the brand's marketing within the Thakeen contract", () => {
  it("the persona says whom she works for, the scope, the team boundary and the refusal", () => {
    expect(reem.persona).toContain("the secretary of a Thakeen customer");
    expect(reem.persona).toContain("within their contract with Thakeen and only on the marketing work that serves their brand");
    expect(reem.persona).toContain("never assign the team work on your own, plan their time or arrange their schedule: work for the team is the owner's decision");
    expect(reem.persona).toMatch(/decline anything outside that scope/);
  });

  it("the playbook's first principle is Role and scope (rule 96 keeps Principles first), and it names the refusal line in both languages", () => {
    expect(playbook).toMatch(/^# Secretary playbook \(Reem\)\n\n## Principles\n- Role and scope: You work for one Thakeen customer/);
    expect(playbook).toContain("only on the marketing work that serves their brand");
    expect(playbook).toContain("You never assign work to a team member or an agent on your own, plan their time or arrange their schedule: work for the team is the owner's decision.");
    expect(playbook).toContain("Save nothing for it.");
    expect(playbook).toContain("«هذا خارج عملي في ذكين. أتابع لك تسويق علامتك: مهامه ومواعيد نشره ومتابعاته.»");
    expect(playbook).toContain("That's outside my work at Thakeen.");
    expect(playbook).toMatch(/## Never do\n- Never take on work outside the brand's marketing within the Thakeen contract/);
  });

  it("the chat prompt Reem runs with carries the role, ahead of the rest of her playbook", () => {
    const u = { email: "x@test.example", credits: 5, plan: "starter", trialEnds: "2026-10-01" } as User;
    const text = system(null, u, [], "", [], [], "reem")[0].text;
    expect(text).toContain("the secretary of a Thakeen customer");
    expect(text).toMatch(/Secretary playbook \(Reem\)\s*## Principles\s*- Role and scope:/);
  });
});

describe("rule 610: Reem's examples are marketing work, and non-marketing duties are declined, not reminded", () => {
  it("the playbook's examples are marketing, and government filings are out of scope", () => {
    expect(playbook).not.toMatch(/Al Nukhba|renew the commercial registration|about the delivery/);
    expect(playbook).toContain("Zakat, VAT, commercial registration, Muqeem and GOSI are the business's other operations: decline them");
    expect(playbook).not.toMatch(/Government and bank deadlines \([^)]*\) are reminders/);
  });

  it("the app's suggestions and the add-item placeholder are marketing examples", () => {
    for (const lang of ["ar", "en"] as const) {
      const d = appDict[lang];
      const copy = [...d.agents.reem.suggestions, JSON.stringify(d)].join(" ");
      expect(copy, lang).not.toMatch(/Al Nukhba|مؤسسة النخبة|call the supplier|بالمورّد الخميس/);
    }
    expect(appDict.ar.agents.reem.blurb).toContain("متابعة تسويق علامتك");
    expect(appDict.en.agents.reem.blurb).toContain("Your brand's marketing to-dos");
  });
});

describe("rule 611: the site, help and FAQ describe Reem by the same role", () => {
  it("her agent page says she works only on the brand's marketing and never manages the team", () => {
    const ar = JSON.stringify(AGENT_PAGES.ar.reem);
    const en = JSON.stringify(AGENT_PAGES.en.reem);
    expect(ar).toContain("سكرتيرتك لتسويق علامتك");
    expect(ar).toContain("تعمل لتسويق علامتك فقط: تعتذر عمّا خارجه");
    expect(ar).toContain("ولا توزّع عليه مهاماً ولا ترتّب وقته");
    expect(en).toContain("Your secretary for your brand's marketing");
    expect(en).toContain("Works only on your brand's marketing: declines what is outside it");
    expect(en).toContain("never assigns them work or plans their time");
    expect(`${ar} ${en}`).not.toMatch(/ومتابعاتك مع العملاء والموردين|follow-ups with customers and suppliers/);
  });

  it("help and the homepage FAQ name her as the secretary for the brand's marketing", () => {
    const help = HELP.flatMap((t) => t.items);
    const who = help.find((i) => i.q.en === "What is “My to-dos”, and who is Reem?")!;
    expect(who.a.ar).toContain("ريم السكرتيرة تتابع تسويق علامتك ضمن اشتراكك في ذكين");
    expect(who.a.ar).toContain("ولا تأخذ ما هو خارج تسويق علامتك");
    expect(who.a.en).toContain("Reem, the secretary, follows your brand's marketing within your Thakeen subscription");
    expect(who.a.en).toContain("She does not take on anything outside your brand's marketing");
    const team = help.find((i) => i.q.en === "Who is on the team?")!;
    expect(team.a.ar).toContain("وريم السكرتيرة لمتابعة تسويق علامتك");
    expect(team.a.en).toContain("Reem the secretary for your brand's marketing to-dos and follow-ups");
    const faq = readFileSync("src/lib/i18n.ts", "utf8");
    expect(faq).toContain("وريم السكرتيرة لمتابعة تسويق علامتك");
    expect(faq).toContain("and Reem the secretary for your brand's marketing to-dos and follow-ups");
    expect(faq).not.toMatch(/وريم السكرتيرة لمهامك ومتابعاتك|Reem the secretary for your to-dos and follow-ups/);
  });
});
