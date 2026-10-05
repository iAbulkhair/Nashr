import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, agentById, type AgentId, type SlicedPlaybook } from "@/lib/agents";
import { SLICED, skillsBlock, sliceBlock } from "@/lib/skills";

/**
 * Rules 629 (content/skills/ads.md) and 630 (content/skills/growth.md): playbooks agents receive by `## ` section. Each
 * agent with a slice gets the file's shared sections plus its own, appended to its playbook. This pins the mappings the
 * founder approved on 2026-10-05, each file's shape and size, the placeholder and drafts-only rules, and the same
 * honesty bar as rule 96.
 */
const MAX_BYTES = 14000;
const read = (file: string) => readFileSync(join(process.cwd(), "content", "skills", `${file}.md`), "utf8");
const FILES = Object.keys(SLICED) as SlicedPlaybook[];

const MAPPING: Record<AgentId, Partial<Record<SlicedPlaybook, string[]>> | undefined> = {
  noor: { ads: ["Ads creative (Noor)"], growth: ["Offers, influencers and PR (Noor)"] },
  sami: { growth: ["Sales enablement and RevOps (Sami)"] },
  razan: { ads: ["Ads budget and math (Razan)"] },
  faris: { ads: ["Ads planning and audits (Faris)"], growth: ["Events, partners and research (Faris)"] },
  dana: { ads: ["Ads reporting and monitoring (Dana)"], growth: ["Attribution and reconciliation (Dana)"] },
  layan: { ads: ["Ads landing pages and tests (Layan)"], growth: ["Retention and cancel flow (Layan)"] },
  majed: undefined,
  reem: undefined,
};

/** The same claim patterns as rule 96 (tests/playbooks.test.ts), plus ad and retention rates. */
const CLAIMS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:more|higher|lower|less|increase|uplift|lift|boost|growth|better|faster|improvement)\b/i,
  /\b(?:increases?|increased|lifts?|boosts?|grows?|improves?|improved|doubles?|triples?|reduces?|cuts?)\b[^.\n]{0,40}\bby\s+(?:up\s+to\s+)?\d+(?:\.\d+)?\s*%/i,
  /\b\d+(?:\.\d+)?\s*x\s+(?:more|higher|better|faster)\b/i,
  /\b(?:studies|research)\s+(?:show|shows|prove|proves|found|finds)\b/i,
  /\b(?:average|typical|benchmark)\b[^.\n]{0,30}\b(?:open|click|reply|response|conversion|ctr|cpc|cpm|churn|retention|save)\s*(?:rates?)?\b[^.\n]{0,15}\b(?:is|was|of|around|about)\s+\d/i,
];
const SOURCES = /claude-ads|agricidaniel|ai marketing hub|marketingskills|coreyhaines|hormozi|value equation|agency-agents|msitarzewski/i;

const sectionsOf = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const sectionOf = (text: string, title: string) => {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 3);
  return text.slice(start, next < 0 ? undefined : next);
};

describe("sliced playbooks (rules 629 and 630)", () => {
  it("each agent gets exactly the approved sections", () => {
    for (const a of AGENTS) expect(a.slices ? Object.fromEntries(Object.entries(a.slices).map(([k, v]) => [k, [...(v ?? [])]])) : undefined, a.id).toEqual(MAPPING[a.id]);
  });

  for (const file of FILES) {
    describe(`${file}.md`, () => {
      const text = read(file);
      const sections = sectionsOf(text);
      const shared = SLICED[file].shared;

      it("has every shared and assigned section, opening with principles and ending with never do", () => {
        expect(sections[0]).toBe(shared[0]);
        expect(sections[sections.length - 1]).toBe(shared[shared.length - 1]);
        for (const h of [...shared, ...AGENTS.flatMap((a) => a.slices?.[file] ?? [])]) expect(sections, h).toContain(h);
      });

      it(`stays within ${MAX_BYTES} bytes`, () => {
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_BYTES);
      });

      it("states the placeholder rule and that the owner approves drafts, in principles", () => {
        const p = sectionOf(text, shared[0]);
        expect(p).toContain("[رقم]");
        expect(p).toMatch(/draft/i);
        expect(p).toMatch(/owner/i);
      });

      it("carries no effect-size statistic, research claim or benchmark rate stated as fact, and names no source", () => {
        const hits = text.split("\n").flatMap((line, i) => (CLAIMS.some((re) => re.test(line)) ? [`${file}.md:${i + 1}: ${line.trim().slice(0, 140)}`] : []));
        expect(hits).toEqual([]);
        expect(text).not.toMatch(SOURCES);
      });

      it("an agent's slice holds its own section and the shared ones, never another agent's", () => {
        for (const a of AGENTS) {
          const own = a.slices?.[file];
          const block = sliceBlock(a, file);
          if (!own) {
            expect(block, a.id).toBe("");
            expect(skillsBlock(a), a.id).not.toContain(SLICED[file].label);
            continue;
          }
          for (const h of [...shared, ...own]) expect(block, `${a.id}: ${h}`).toContain(`## ${h}`);
          for (const other of AGENTS) for (const h of other.id === a.id ? [] : other.slices?.[file] ?? []) expect(block, `${a.id} must not get ${h}`).not.toContain(`## ${h}`);
          expect(skillsBlock(a), a.id).toContain(SLICED[file].label);
        }
      });
    });
  }

  it("the agent's own playbook comes first, then its slices in order", () => {
    const faris = skillsBlock(agentById("faris"));
    expect(faris.startsWith(read("gtm").trim())).toBe(true);
    expect(faris.indexOf(SLICED.ads.label)).toBeLessThan(faris.indexOf(SLICED.growth.label));
    expect(skillsBlock(agentById("majed")), "no slices: the playbook alone").toBe(read("executive").trim());
  });
});
