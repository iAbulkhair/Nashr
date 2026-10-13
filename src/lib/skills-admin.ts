import type { By } from "./actor";
import type { AuditVia } from "./admin-audit";
import { adminAudit } from "./admin-audit";
import { summarizeRevision, type HistoryRow } from "./instructions-diff";
import { publicLayer, publicRevision } from "./instructions-http";
import { PLATFORM_CHARS } from "./instructions-safety";
import { listBrands } from "./brands";
import { agentForTask, type AgentId } from "./agents";
import { DRAFT_TYPES, type TaskType } from "./tasks";
import { PLATFORM, editBase, getLayer, isPaused, listFeed, listHistory, type FeedRow, type Layer } from "./instructions-store";

/**
 * What the founder's skills console reads and logs (agent skills portal, spec 8.2 and 10; rules 958-959). Server code:
 * `GET /api/admin/skills` and the page at /{lang}/admin/skills both build their state here, so the two cannot differ.
 */

/** The rate-limit bucket of the admin test: one for the whole console, a server constant (never the caller's address or email). */
export const ADMIN_SKILL_TEST_BUCKET = "admin:skills:test";
/**
 * The account label the admin test is metered under (`usage:{label}:{month}`), like the golden set's `GOLDEN_EMAIL`: not
 * an address anyone can sign in with, so the founder console's usage shows the test's tokens apart from every customer.
 */
export const ADMIN_TEST_LABEL = "skills-test@nashr.internal";

/** How many versions the console lists (the customer page's 20). */
export const CONSOLE_HISTORY = 20;

/** A feed row as the console shows it: the row, and its brand (the brand's name when the account still has it, else the id from `email#brandId`; empty for the default brand). */
export type FeedView = FeedRow & { brand: string };
const brandIdOf = (scope: string) => (scope.includes("#") ? scope.slice(scope.indexOf("#") + 1) : "");
/** One batched read: each account's brand list once (`listBrands`), however many rows it has, all in parallel. */
export async function feedViews(rows: FeedRow[]): Promise<FeedView[]> {
  const emails = [...new Set(rows.filter((r) => r.scope.includes("#")).map((r) => r.email))];
  const lists = await Promise.all(emails.map((e) => listBrands(e).catch(() => [])));
  const names = new Map(emails.map((e, i) => [e, new Map(lists[i].map((b) => [b.id, b.name]))]));
  return rows.map((r) => {
    const id = brandIdOf(r.scope);
    return { ...r, brand: id ? names.get(r.email)?.get(id) || id : "" };
  });
}

export type ConsoleState = { layer: Layer; base: number; chars: number; history: HistoryRow[]; feed: FeedView[]; paused: boolean };

/** The platform layer, its newest versions as counts, the founder feed and the pause switch: four reads in parallel. */
export async function consoleState(): Promise<ConsoleState> {
  const [layer, history, feed, paused] = await Promise.all([getLayer(PLATFORM), listHistory(PLATFORM), listFeed(), isPaused()]);
  return {
    layer: publicLayer(layer),
    base: editBase(layer),
    chars: PLATFORM_CHARS,
    history: history.slice(0, CONSOLE_HISTORY).map((r) => summarizeRevision(publicRevision(r))),
    feed: await feedViews(feed),
    paused,
  };
}

/** Who wrote the platform layer: the founder, with their email when they signed in as themselves (a key session has none). */
export const founderBy = (who: string): By => ({ kind: "founder", ...(who !== "key" && who.includes("@") ? { email: who } : {}) });

/** The small before/after the log keeps: versions and counts, never an instruction's text. */
export const snap = (l: Layer) => ({ v: l.active.v, on: l.active.items.filter((i) => i.on).length, draft: l.draft ? l.draft.items.length : null });

/**
 * One founder write in the audit log, through `adminAudit`, its only writer (rule 1172). `actor` is the key session or
 * the founder's email; the target "platform-skills" is also the legacy `email` the console's log table shows. The
 * section is "quality": the platform layer changes how every agent writes.
 */
export const logSkills = (actor: string, action: string, before: unknown, after: unknown, via?: AuditVia | null) =>
  adminAudit({ actor, via, section: "quality", what: `skills.${action}`, action: `skills.${action}`, target: "platform-skills", before, after });

/** What the console's test offers: the types a draft can be written for, each with its owning agent (Reem owns none). The same pairs the route accepts. */
export type AdminTestOption = { agent: AgentId; type: TaskType };
export const adminTestOptions = (): AdminTestOption[] => DRAFT_TYPES.flatMap((type) => { const agent = agentForTask(type).id; return agent === "reem" ? [] : [{ agent, type }]; });
