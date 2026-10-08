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
    // The code expressions, not the words: `agent_not_included` also appears in the route's doc comment.
    const chat = read("src/app/api/chat/route.ts");
    const agentRead = chat.indexOf("const agent = ");
    const chatCheck = chat.indexOf("entitlements(u).agents.includes(agent)");
    const chatTrial = chat.indexOf("if (trialOver(u))");
    expect([agentRead, chatCheck, chatTrial].every((i) => i > -1), "chat: all three expressions are found").toBe(true);
    expect(chatCheck, "chat: after the agent is read").toBeGreaterThan(agentRead);
    expect(chatCheck, "chat: before the trial gate").toBeLessThan(chatTrial);
    expect(chat.slice(chatCheck, chatCheck + 200), "chat: refuses with 403 agent_not_included").toMatch(/error: "agent_not_included" \}, \{ status: 403 \}/);

    const mcp = read("src/app/api/mcp/route.ts");
    const ask = mcp.slice(mcp.indexOf('case "ask_noor"'));
    const mcpCheck = ask.indexOf('entitlements(user).agents.includes("noor")');
    const mcpTrial = ask.indexOf("if (trialOver(user))");
    expect([mcpCheck, mcpTrial].every((i) => i > -1), "mcp: both expressions are found").toBe(true);
    expect(mcpCheck, "mcp: before the trial gate").toBeLessThan(mcpTrial);
    expect(ask.slice(mcpCheck, mcpCheck + 250), "mcp: a tool error").toMatch(/not included in this account's plan\. Nothing was sent\.[\s\S]*isError: true/);
  });

  it("rule 781: the inbox takes the plan's video list as a prop, and the client files never import entitlements at runtime", () => {
    expect(read("src/app/[lang]/app/page.tsx")).toMatch(/included=\{entitlements\(u\)\.media\.video\}/);
    for (const f of ["src/components/app/Inbox.tsx", "src/components/app/MediaControls.tsx"]) {
      expect(read(f), f).not.toMatch(/from\s+["']@\/lib\/entitlements["']/);
    }
  });

  it("rule 784: the console and its entitlements table take the view as a type only, so the store stays out of the browser bundle", () => {
    for (const f of ["src/components/app/AdminConsole.tsx", "src/components/app/EntitlementsTable.tsx"]) {
      const imports = [...read(f).matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']@\/lib\/entitlements["']/gm)];
      expect(imports.length, `${f} imports the view type`).toBeGreaterThan(0);
      expect(imports.every((m) => !!m[1]), `${f} must use import type`).toBe(true);
    }
    // The detail GET builds the view once, as one more entry of its own Promise.all, not as a second round trip after it.
    const route = read("src/app/api/admin/users/[email]/route.ts");
    expect(route.match(/entitlementView\(u\)/g)).toHaveLength(1);
    expect(route).not.toMatch(/await\s+entitlementView/);
  });
});
