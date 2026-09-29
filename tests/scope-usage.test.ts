import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace data lives under the ACTIVE brand's scope (`sc(u)`), not the account email. A page that reads with `u.email`
 * shows the default brand while the API next to it writes to the active one. The founder console is the exception: it
 * looks at accounts from outside.
 */
const READERS = ["getBrand", "saveBrand", "listFiles", "readFile", "writeFile", "getGov", "saveGov", "getSchedule", "saveSchedule", "listConnections", "getConnection", "saveConnection", "listTasks", "listLite", "listLiteDays", "getTask", "saveTask", "history", "kpis", "scopeMetrics", "listConversations", "latestBrief", "pendingCount", "memoryBlock", "listPreferences", "listPreferencesFor", "feedbackFor", "listDecisions", "routineLastRuns", "agendaFor", "todoPage", "listOpenItems", "listDone", "listDeleted", "getItem", "changeItem", "purgeExpired", "listGovHistory", "saveGovAs", "rollbackGov", "listActivity", "recordActivity"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

const customerFiles = () => walk("src/app").filter((p) => !p.includes("/api/admin/") && !p.includes("/api/cron/"));
/** An identity rather than a workspace: the acting login, a member record, an owner record, a login helper. */
const WHO = String.raw`(?:[\w.]*actor[!?]?\.email|(?:owner|member|m|login)\.email|login\(\w+\))`;
const offending = (re: RegExp) => customerFiles().flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (re.test(line) ? `${p}:${i + 1}` : "")).filter(Boolean));

describe("workspace readers take the active scope", () => {
  it("no page or customer API route passes the bare account email to a workspace reader", () => {
    expect(offending(new RegExp(`\\b(${READERS.join("|")})\\((u|user)\\.email\\b`))).toEqual([]);
  });

  /**
   * Teams (docs/superpowers/specs/2026-09-29-teams-design.md §3): the workspace is the OWNER's, reached through `sc(u)`.
   * The acting login's own address — `u.actor.email`, a member record's email, an owner record fetched on the side —
   * is an identity, never a workspace key: a member writing under their own address would land in an empty workspace
   * that survives their removal and the account's deletion.
   */
  it("no page or customer API route passes the acting login's or a member's email to a workspace reader", () => {
    expect(offending(new RegExp(`\\b(${READERS.join("|")})\\(${WHO}`))).toEqual([]);
  });
  it("the check itself catches the shapes it is meant to", () => {
    const re = new RegExp(`\\b(${READERS.join("|")})\\(${WHO}`);
    for (const line of ["getBrand(u.actor!.email)", "listTasks(u.actor?.email)", "readFile(actor.email, n)", "getGov(member.email)", "saveBrand(owner.email, b)", "listFiles(m.email)"]) expect(re.test(line), line).toBe(true);
    for (const line of ["getBrand(sc(u))", "listTasks(scope)", "getGov(sc(owner))"]) expect(re.test(line), line).toBe(false);
  });

  it("the generation pipeline gets the active scope as its second argument, never the account email", () => {
    // `generateBatch(user, scope, opts)` charges the account (`user.email`) and writes the batch under `scope`.
    const re = /\bgenerateBatch\(\s*\w+\s*,\s*(u|user)\.email\b/;
    const uses = walk("src").flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (/\bgenerateBatch\(/.test(line) && !line.includes("function generateBatch") ? { at: `${p}:${i + 1}`, line } : null)).filter((x) => x !== null));
    expect(uses.length, "the scan finds the callers").toBeGreaterThanOrEqual(6);
    expect(uses.filter((x) => re.test(x.line)).map((x) => x.at)).toEqual([]);
  });
});
