import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, agentById, type AgentId } from "@/lib/agents";
import { ADS_SHARED, adsBlock, skillsBlock } from "@/lib/skills";

/**
 * Rule 629: the paid ads playbook (content/skills/ads.md) is sliced by `## ` heading. Each agent with an `ads` list
 * gets the shared sections plus its own, appended to its playbook. This pins the mapping the founder approved on
 * 2026-10-05, the file's shape and size, the drafts-only and placeholder rules, and the same honesty bar as rule 96.
 */
const MAX_BYTES = 14000;
const text = readFileSync(join(process.cwd(), "content", "skills", "ads.md"), "utf8");
const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const section = (title: string) => {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 3);
  return text.slice(start, next < 0 ? undefined : next);
};

const MAPPING: Record<AgentId, string[] | undefined> = {
  noor: ["Ads creative (Noor)"],
  faris: ["Ads planning and audits (Faris)"],
  razan: ["Ads budget and math (Razan)"],
  dana: ["Ads reporting and monitoring (Dana)"],
  layan: ["Ads landing pages and tests (Layan)"],
  sami: undefined,
  majed: undefined,
  reem: undefined,
};

/** The same claim patterns as rule 96 (tests/playbooks.test.ts), plus ad rates (CTR, CPC, CPM). */
const CLAIMS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:more|higher|lower|less|increase|uplift|lift|boost|growth|better|faster|improvement)\b/i,
  /\b(?:increases?|increased|lifts?|boosts?|grows?|improves?|improved|doubles?|triples?)\b[^.\n]{0,40}\bby\s+(?:up\s+to\s+)?\d+(?:\.\d+)?\s*%/i,
  /\b\d+(?:\.\d+)?\s*x\s+(?:more|higher|better|faster)\b/i,
  /\b(?:studies|research)\s+(?:show|shows|prove|proves|found|finds)\b/i,
  /\b(?:average|typical|benchmark)\b[^.\n]{0,30}\b(?:open|click|reply|response|conversion|ctr|cpc|cpm)\s*(?:rates?)?\b[^.\n]{0,15}\b(?:is|was|of|around|about)\s+\d/i,
];

describe("paid ads playbook slices (rule 629)", () => {
  it("each agent gets exactly the approved ads sections", () => {
    for (const a of AGENTS) expect(a.ads ? [...a.ads] : undefined, a.id).toEqual(MAPPING[a.id]);
  });

  it("has every shared and assigned section, opening with principles and ending with never do", () => {
    expect(sections[0]).toBe("Ads principles");
    expect(sections[sections.length - 1]).toBe("Ads never do");
    const wanted = [...ADS_SHARED, ...AGENTS.flatMap((a) => a.ads ?? [])];
    for (const h of wanted) expect(sections, h).toContain(h);
  });

  it(`stays within ${MAX_BYTES} bytes`, () => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("states the placeholder rule and the drafts-only rule in principles", () => {
    const p = section("Ads principles");
    expect(p).toContain("[رقم]");
    expect(p).toMatch(/draft/i);
    expect(p).toMatch(/owner/i);
  });

  it("carries no effect-size statistic, research claim or benchmark rate stated as fact, and names no source", () => {
    const hits = text.split("\n").flatMap((line, i) => (CLAIMS.some((re) => re.test(line)) ? [`ads.md:${i + 1}: ${line.trim().slice(0, 140)}`] : []));
    expect(hits).toEqual([]);
    expect(text).not.toMatch(/claude-ads|agricidaniel|ai marketing hub|agency-agents|msitarzewski/i);
  });

  it("an agent's slice holds its own section and the shared ones, never another agent's", () => {
    for (const a of AGENTS) {
      const block = adsBlock(a);
      if (!a.ads) {
        expect(block, a.id).toBe("");
        expect(skillsBlock(a), a.id).not.toContain("PAID ADS PLAYBOOK");
        continue;
      }
      for (const h of [...ADS_SHARED, ...a.ads]) expect(block, `${a.id}: ${h}`).toContain(`## ${h}`);
      for (const other of AGENTS) for (const h of other.id === a.id ? [] : other.ads ?? []) expect(block, `${a.id} must not get ${h}`).not.toContain(`## ${h}`);
      expect(skillsBlock(a), a.id).toContain("PAID ADS PLAYBOOK");
    }
    expect(skillsBlock(agentById("faris")).startsWith(readFileSync(join(process.cwd(), "content", "skills", "gtm.md"), "utf8").trim()), "the agent's own playbook comes first").toBe(true);
  });
});
