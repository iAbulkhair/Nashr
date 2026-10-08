import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What a plan includes is asked of `entitlements(u)` (src/lib/entitlements.ts, rules 780-782), not worked out again at each
 * caller. These scans pin that the callers moved: the trial's video list is read in two places only, and the two doors to
 * a chat turn check the agents dimension before they count anything.
 */
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const read = (p: string) => readFileSync(p, "utf8");

describe("callers read what a plan includes from entitlements", () => {
  it("rule 781: TRIAL_VIDEO_MODELS is read only by the catalog and entitlements", () => {
    const users = filesUnder("src").filter((f) => /\bTRIAL_VIDEO_MODELS\b/.test(read(f)));
    expect(users.sort()).toEqual(["src/lib/entitlements.ts", "src/lib/media-catalog.ts"]);
  });

  it("rule 782: the chat route and MCP ask_noor check the agents dimension", () => {
    expect(read("src/app/api/chat/route.ts")).toMatch(/entitlements\(u\)\.agents\.includes\(agent\)/);
    expect(read("src/app/api/mcp/route.ts")).toMatch(/entitlements\(user\)\.agents\.includes\("noor"\)/);
  });

  it("rule 782: each of those checks comes before the trial gate, so a refused agent counts nothing", () => {
    const chat = read("src/app/api/chat/route.ts");
    expect(chat.indexOf("agent_not_included")).toBeGreaterThan(-1);
    expect(chat.indexOf("agent_not_included")).toBeLessThan(chat.indexOf("trialOver(u)"));
    const mcp = read("src/app/api/mcp/route.ts");
    const ask = mcp.slice(mcp.indexOf('case "ask_noor"'));
    expect(ask.indexOf("entitlements(user).agents")).toBeGreaterThan(-1);
    expect(ask.indexOf("entitlements(user).agents")).toBeLessThan(ask.indexOf("trialOver(user)"));
  });

  it("rule 781: the inbox takes the plan's video list as a prop, and the client files never import entitlements at runtime", () => {
    expect(read("src/app/[lang]/app/page.tsx")).toMatch(/included=\{entitlements\(u\)\.media\.video\}/);
    for (const f of ["src/components/app/Inbox.tsx", "src/components/app/MediaControls.tsx"]) {
      expect(read(f), f).not.toMatch(/from\s+["']@\/lib\/entitlements["']/);
    }
  });
});
