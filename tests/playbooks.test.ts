import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "@/lib/agents";

/**
 * Rule 96: the agent playbooks in content/skills are prompt text every agent follows literally, and they were rebuilt
 * on 2026-09-29 from third-party role files whose own format demands numbers ("segmented campaigns generate up to
 * 760% more revenue"). This keeps their shape, their size and their honesty from drifting: each agent's file exists
 * with its required sections, stays under the byte cap that keeps prompts affordable, states the evidence rule, and
 * carries no effect-size statistic or source attribution a model could repeat to a customer as fact.
 */
const MAX_BYTES = 15500;
const dir = join(process.cwd(), "content", "skills");
const read = (name: string) => readFileSync(join(dir, `${name}.md`), "utf8");
const playbooks = AGENTS.map((agent) => ({ agent, name: agent.skills ?? "", text: agent.skills ? read(agent.skills) : "" }));

/** Effect claims and statistics stated as fact. Operational rules ("VAT 15%", "at least 7 days") do not match. */
const CLAIMS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*%\s*(?:more|higher|lower|less|increase|uplift|lift|boost|growth|better|faster|improvement)\b/i,
  /\b(?:increases?|increased|lifts?|boosts?|grows?|improves?|improved|doubles?|triples?)\b[^.\n]{0,40}\bby\s+(?:up\s+to\s+)?\d+(?:\.\d+)?\s*%/i,
  /\b\d+(?:\.\d+)?\s*x\s+(?:more|higher|better|faster)\b/i,
  /\b(?:studies|research)\s+(?:show|shows|prove|proves|found|finds)\b/i,
  /\b(?:average|typical|benchmark)\b[^.\n]{0,30}\b(?:open|click|reply|response|conversion)\s+rates?\b[^.\n]{0,15}\b(?:is|was|of|around|about)\s+\d/i,
];

const sections = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const section = (text: string, title: string) => {
  const start = text.indexOf(`## ${title}\n`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 3);
  return text.slice(start, next < 0 ? undefined : next);
};

describe("agent playbooks keep their shape, size and honesty (rule 96)", () => {
  it("every agent has a playbook file with its own title", () => {
    expect(playbooks).toHaveLength(8);
    for (const { agent, name, text } of playbooks) {
      expect(name, agent.id).not.toBe("");
      expect(text.split("\n")[0], name).toMatch(new RegExp(`^# .+ playbook \\(${agent.name.en}\\)$`));
    }
  });

  it("opens with Principles, ends with Never do, and has Gulf adaptations and Output templates", () => {
    for (const { name, text } of playbooks) {
      const s = sections(text);
      expect(s[0], name).toBe("Principles");
      expect(s[s.length - 1], name).toBe("Never do");
      expect(s, name).toEqual(expect.arrayContaining(["Gulf adaptations", "Output templates"]));
    }
  });

  it(`stays within ${MAX_BYTES} bytes, and so does the shared review rubric`, () => {
    for (const { name, text } of playbooks) expect(Buffer.byteLength(text), name).toBeLessThanOrEqual(MAX_BYTES);
    expect(Buffer.byteLength(read("review"))).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("states the evidence rule in Principles: unknown numbers are placeholders", () => {
    for (const { name, text } of playbooks) expect(section(text, "Principles"), name).toContain("[رقم]");
  });

  it("carries no effect-size statistic, research claim or benchmark rate stated as fact", () => {
    const hits = playbooks.flatMap(({ name, text }) =>
      text.split("\n").flatMap((line, i) => (CLAIMS.some((re) => re.test(line)) ? [`${name}.md:${i + 1}: ${line.trim().slice(0, 140)}`] : [])));
    expect(hits).toEqual([]);
  });

  it("the patterns catch the claims they exist for", () => {
    for (const bad of ["segmented campaigns generate up to 760% more revenue", "MEDDPICC teams see 18% higher win rates", "signal-based outreach converts 4x more", "studies show that video wins", "average open rate was 43.46%", "this lifts conversion by 30%"]) {
      expect(CLAIMS.some((re) => re.test(bad)), bad).toBe(true);
    }
    for (const ok of ["Any stated price says whether VAT is included (KSA 15%, UAE 5%).", "Run at least 7 days", "Status: Watch 10-25% behind pace", "Leads [رقم], up [رقم]% on last week"]) {
      expect(CLAIMS.some((re) => re.test(ok)), ok).toBe(false);
    }
  });

  it("names no third-party source", () => {
    for (const { name, text } of [...playbooks, { name: "review", text: read("review") }]) expect(text, name).not.toMatch(/agency-agents|agencyagents|msitarzewski/i);
  });

  it("the shared rubric forbids promised results and borrowed proof", () => {
    const review = read("review");
    expect(review).toMatch(/No promised results/);
    expect(review).toMatch(/No borrowed proof/);
  });
});
