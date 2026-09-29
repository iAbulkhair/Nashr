import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace data lives under the ACTIVE brand's scope (`sc(u)`), not the account email. A page that reads with `u.email`
 * shows the default brand while the API next to it writes to the active one. The founder console is the exception: it
 * looks at accounts from outside.
 */
const READERS = ["getBrand", "saveBrand", "listFiles", "readFile", "writeFile", "getGov", "saveGov", "getSchedule", "saveSchedule", "listConnections", "getConnection", "saveConnection", "listTasks", "listLite", "listLiteDays", "getTask", "saveTask", "history", "kpis", "scopeMetrics", "listConversations", "latestBrief", "pendingCount", "memoryBlock", "listPreferences", "listPreferencesFor", "feedbackFor", "listDecisions", "routineLastRuns", "listGovHistory", "saveGovAs", "rollbackGov", "listActivity", "recordActivity"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

describe("workspace readers take the active scope", () => {
  it("no page or customer API route passes the bare account email to a workspace reader", () => {
    const re = new RegExp(`\\b(${READERS.join("|")})\\((u|user)\\.email\\b`);
    const bad = walk("src/app").filter((p) => !p.includes("/api/admin/") && !p.includes("/api/cron/")).flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (re.test(line) ? `${p}:${i + 1}` : "")).filter(Boolean));
    expect(bad).toEqual([]);
  });

  it("the generation pipeline gets the active scope as its second argument, never the account email", () => {
    // `generateBatch(user, scope, opts)` charges the account (`user.email`) and writes the batch under `scope`.
    const re = /\bgenerateBatch\(\s*\w+\s*,\s*(u|user)\.email\b/;
    const uses = walk("src").flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (/\bgenerateBatch\(/.test(line) && !line.includes("function generateBatch") ? { at: `${p}:${i + 1}`, line } : null)).filter((x) => x !== null));
    expect(uses.length, "the scan finds the callers").toBeGreaterThanOrEqual(6);
    expect(uses.filter((x) => re.test(x.line)).map((x) => x.at)).toEqual([]);
  });
});
