import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace data lives under the ACTIVE brand's scope (`sc(u)`), not the account email. A page that reads with `u.email`
 * shows the default brand while the API next to it writes to the active one. The founder console is the exception: it
 * looks at accounts from outside.
 */
const READERS = ["getBrand", "saveBrand", "listFiles", "readFile", "writeFile", "getGov", "saveGov", "getSchedule", "saveSchedule", "listConnections", "getConnection", "saveConnection", "listTasks", "listLite", "listLiteDays", "getTask", "saveTask", "history", "kpis", "scopeMetrics", "listConversations", "latestBrief", "pendingCount", "memoryBlock", "listPreferences", "listPreferencesFor", "feedbackFor", "listDecisions", "routineLastRuns", "agendaFor", "todoPage", "listOpenItems", "listDone", "listDeleted", "getItem", "changeItem", "purgeExpired"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

describe("workspace readers take the active scope", () => {
  it("no page or customer API route passes the bare account email to a workspace reader", () => {
    const re = new RegExp(`\\b(${READERS.join("|")})\\((u|user)\\.email\\b`);
    const bad = walk("src/app").filter((p) => !p.includes("/api/admin/") && !p.includes("/api/cron/")).flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (re.test(line) ? `${p}:${i + 1}` : "")).filter(Boolean));
    expect(bad).toEqual([]);
  });
});
