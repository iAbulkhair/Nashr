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

/**
 * Rule 786: comparing the account's plan with "trial" is how each feature used to decide who may use it, once per feature.
 * What an account may do is asked of `entitlements(u)`; the comparisons that remain outside it are counted here, each with
 * what it does, so a new one has to be argued for in review. A new file or a higher count fails: decide the access in
 * src/lib/entitlements.ts, or add a display-only use below with a reason. A LOWER count fails too, so the map shrinks when a
 * use is removed. Matches are counted, not lines (two on one line are two).
 * The entries marked ACCESS decide what an account may do (or how much) outside entitlements.ts. Part A moved none of them,
 * because it changes no behaviour; they are the list for a follow-up, and the count is what keeps that list from growing.
 */
const PLAN_VS_TRIAL = /\bplan\s*[!=]==?\s*["']trial["']/g;
const ALLOWED: Record<string, { n: number; why: string }> = {
  "src/app/[lang]/app/billing/page.tsx": { n: 4, why: "display: a trial sees its end day, and its owner the activation card, the partner-code form and the open offer (partners.ts checks the code and the offer again)" },
  "src/app/api/team/invite/route.ts": { n: 1, why: "ACCESS (how much): a trial may send fewer invitations a day than a paid plan (PER_TRIAL_ACCOUNT_DAY against PER_ACCOUNT_DAY)" },
  "src/components/app/AdminConsole.tsx": { n: 4, why: "display and stats: the founder's paying and trialing counts, the trial's end day in the list, the chat-overflow tooltip" },
  "src/components/app/ChatPanel.tsx": { n: 2, why: "display: the activation bar and the first-step hint, shown to a trial only" },
  "src/components/app/ProfilePanel.tsx": { n: 3, why: "display and copy: the runway lines and the plan rules text differ for a trial, and its owner gets the subscribe button" },
  "src/components/app/TrialBanner.tsx": { n: 1, why: "display: the countdown strip renders for a trial only" },
  "src/lib/admin-stats.ts": { n: 4, why: "stats: the founder's counts of paying, active-trial and expired-trial accounts, and signups that paid" },
  "src/lib/auth.ts": { n: 1, why: "ACCESS: `trialOver`, the spend gate every route asks (an ended trial may not spend); entitlements() reports the same state as `inactive`" },
  "src/lib/chat-allowance.ts": { n: 4, why: "ACCESS and mechanics: which counter holds a trial's messages, the status period, and `overflowAvailable` (continue on credits is a paid plan's option, not a trial's)" },
  "src/lib/chat.ts": { n: 1, why: "copy: the PLAN line of the chat's system prompt adds the trial end day" },
  "src/lib/credits.ts": { n: 1, why: "billing: `renewalDue`, a monthly renewal runs for a paid plan and never for a trial" },
  "src/lib/entitlements.ts": { n: 4, why: "home: the one place that decides what a plan includes (inactive trial, end day, trial video list, reset day)" },
  "src/lib/lifecycle.ts": { n: 1, why: "copy: the trial-deadline and win-back emails are for an account still on trial" },
  "src/lib/media/jobs.ts": { n: 1, why: "ACCESS: a trial keeps one video (the `trial_video_used` lock, spec A29); a founder video grant opens the models, not a second clip" },
  "src/lib/notifications.ts": { n: 1, why: "display: the bell's alert that a trial ends within 24 hours" },
  "src/lib/partners.ts": { n: 2, why: "billing: only an unpaid trial can claim a partner code, and the last-day offer is owed to an unpaid trial (offer eligibility, not product access)" },
  "src/lib/pricing.ts": { n: 1, why: "ACCESS: `topupsSold`, who may buy a credit pack (every paid plan, not a trial)" },
  "src/lib/rate.ts": { n: 1, why: "limit definition: the trial's hourly and daily chat caps against a paid plan's; entitlements() asks `chatCaps`, it does not copy it" },
  "src/lib/schedule.ts": { n: 2, why: "copy: the morning brief's credits line adds the trial end day, in Arabic and English" },
};

describe("rule 786: plan comparisons outside entitlements", () => {
  const found: Record<string, number> = {};
  for (const f of filesUnder("src")) { const n = (read(f).match(PLAN_VS_TRIAL) ?? []).length; if (n) found[f.split("\\").join("/")] = n; }

  it("no new comparison of the plan with \"trial\" appears outside the listed uses", () => {
    const grew = Object.entries(found).filter(([f, n]) => n > (ALLOWED[f]?.n ?? 0)).map(([f, n]) => `${f}: ${n} found, ${ALLOWED[f]?.n ?? 0} allowed`);
    expect(grew, "decide access in src/lib/entitlements.ts, or add a display-only use here with a reason").toEqual([]);
  });

  it("a use that was removed is taken out of the map", () => {
    const shrank = Object.entries(ALLOWED).filter(([f, a]) => (found[f] ?? 0) < a.n).map(([f, a]) => `${f}: ${found[f] ?? 0} found, ${a.n} allowed`);
    expect(shrank, "lower the count in ALLOWED (or delete the entry) to match the code").toEqual([]);
  });

  it("every entry says what the use does", () => {
    for (const [f, a] of Object.entries(ALLOWED)) { expect(a.n, f).toBeGreaterThan(0); expect(a.why.length, `${f}: a reason`).toBeGreaterThan(20); }
  });
});
