import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace data lives under the ACTIVE brand's scope (`sc(u)`), not the account email. A page that reads with `u.email`
 * shows the default brand while the API next to it writes to the active one. The founder console is the exception: it
 * looks at accounts from outside.
 */
const READERS = ["getBrand", "saveBrand", "listFiles", "readFile", "writeFile", "getGov", "saveGov", "getSchedule", "saveSchedule", "listConnections", "getConnection", "saveConnection", "listTasks", "listLite", "listLiteDays", "getTask", "saveTask", "history", "kpis", "scopeMetrics", "listConversations", "latestBrief", "pendingCount", "memoryBlock", "listPreferences", "listPreferencesFor", "feedbackFor", "listDecisions", "routineLastRuns", "agendaFor", "todoPage", "listOpenItems", "listDone", "listDeleted", "getItem", "changeItem", "purgeExpired", "listGovHistory", "saveGovAs", "rollbackGov", "listActivity", "recordActivity", "getHandoff", "getHandoffs", "createHandoff", "handoffView", "handoffViews", "declineHandoff", "markShown", "handoffKeys", "recentHandoffs", "autoQueue", "liveConversations"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });

/**
 * Pages and routes, and since rule 1272 (360 study C-016) the helpers in `src/lib` they call: a helper that reads with
 * the bare email defeats the route's `sc(u)` just as well. The founder console's own helpers (`src/lib/admin-*`) look
 * at accounts from outside, like the admin routes, and comment lines are prose.
 */
const customerFiles = () => [...walk("src/app"), ...walk("src/lib")].filter((p) => !p.includes("/api/admin/") && !p.includes("/api/cron/") && !/src\/lib\/admin-[\w-]+\.ts$/.test(p));
const code = (line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line);
/** An identity rather than a workspace: the acting login, a member record, an owner record, a login helper. */
const WHO = String.raw`(?:[\w.]*actor[!?]?\.email|(?:owner|member|m|login)\.email|login\(\w+\))`;
const offending = (re: RegExp) => customerFiles().flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (code(line) && re.test(line) ? `${p}:${i + 1}` : "")).filter(Boolean));

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
  it("the scan covers the src/lib helpers, not only pages and routes (rule 1272)", () => {
    const files = customerFiles();
    expect(files.some((p) => p.startsWith("src/lib/"))).toBe(true);
    expect(files).toContain("src/lib/tasks.ts");
    expect(files.some((p) => /src\/lib\/admin-/.test(p))).toBe(false);
  });
  it("the check itself catches the shapes it is meant to", () => {
    const re = new RegExp(`\\b(${READERS.join("|")})\\(${WHO}`);
    for (const line of ["getBrand(u.actor!.email)", "listTasks(u.actor?.email)", "readFile(actor.email, n)", "getGov(member.email)", "saveBrand(owner.email, b)", "listFiles(m.email)"]) expect(re.test(line), line).toBe(true);
    for (const line of ["getBrand(sc(u))", "listTasks(scope)", "getGov(sc(owner))"]) expect(re.test(line), line).toBe(false);
  });

  /**
   * The handoff runners take the User first (it is charged) and the scope second, so the first-argument check above can
   * never see them. Every call must pass the active scope there: `sc(u)` or a `scope` taken from it.
   */
  it("the handoff runners get the active scope as their second argument, never the account email", () => {
    const re = /\b(runHandoffItem|runItemLocked)\(\s*\w+\s*,\s*(u|user)\.email\b/;
    const scoped = /\b(runHandoffItem|runItemLocked)\(\s*\w+\s*,\s*(scope|sc\(\w+\))\s*,/;
    const uses = walk("src").flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (/\b(runHandoffItem|runItemLocked)\(/.test(line) && !/function (runHandoffItem|runItemLocked)/.test(line) ? { at: `${p}:${i + 1}`, line } : null)).filter((x) => x !== null));
    expect(uses.length, "the scan finds the run route and the owner's and the auto-run's runs").toBeGreaterThanOrEqual(3);
    expect(uses.filter((x) => re.test(x.line)).map((x) => x.at)).toEqual([]);
    expect(uses.filter((x) => !scoped.test(x.line)).map((x) => x.at)).toEqual([]);
    for (const line of ["runHandoffItem(u, u.email, id, item, { by })", "runItemLocked(user, user.email, h, n, o)"]) expect(re.test(line) && !scoped.test(line), line).toBe(true);
    for (const line of ["runHandoffItem(u, scope, id, item, { by })", "runItemLocked(user, scope, h, n, o)", "runHandoffItem(u, sc(u), id, n, o)"]) expect(scoped.test(line), line).toBe(true);
    // The run route takes the scope from the session, and the auto-run from the cron's user, never from a request.
    expect(readFileSync("src/app/api/handoffs/[id]/run/route.ts", "utf8")).toMatch(/const scope = sc\(u\);\s*\n\s*const r = await runHandoffItem\(u, scope,/);
    expect(readFileSync("src/lib/handoff-auto.ts", "utf8")).toMatch(/const scope = user\.scope \?\? user\.email;\s*\n\s*return \(await withRunLock\(scope, id, \(\) => runLocked\(user, scope,/);
  });

  it("the generation pipeline gets the active scope as its second argument, never the account email", () => {
    // `generateBatch(user, scope, opts)` charges the account (`user.email`) and writes the batch under `scope`.
    const re = /\bgenerateBatch\(\s*\w+\s*,\s*(u|user)\.email\b/;
    const uses = walk("src").flatMap((p) => readFileSync(p, "utf8").split("\n").map((line, i) => (/\bgenerateBatch\(/.test(line) && !line.includes("function generateBatch") ? { at: `${p}:${i + 1}`, line } : null)).filter((x) => x !== null));
    expect(uses.length, "the scan finds the callers").toBeGreaterThanOrEqual(6);
    expect(uses.filter((x) => re.test(x.line)).map((x) => x.at)).toEqual([]);
  });
});
