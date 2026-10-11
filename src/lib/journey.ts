/**
 * The launch journey: seven milestones from "Noor read your site" to "your brand works inside your AI assistant",
 * shown as a path with levels. Every milestone is read from the workspace itself (the brand file, the task index,
 * connections, MCP access), never from a counter the interface keeps, so a milestone cannot be "earned" without the
 * thing having happened. Points and levels are cosmetic: they are not credits and buy nothing.
 */
import type { TaskLite } from "./brand";

export type MilestoneId = "brand" | "guard" | "approve" | "schedule" | "connect" | "publish" | "ai";
export type Milestone = { id: MilestoneId; done: boolean; points: number; href: string };
export type LevelId = "seed" | "sapling" | "palm" | "oasis";
export type Journey = { milestones: Milestone[]; done: number; total: number; points: number; maxPoints: number; level: LevelId; nextLevelAt: number | null; streak: number; next: MilestoneId | null };

/** Order is the order an owner meets them in; each links to the page where it is done. */
const PATH: { id: MilestoneId; points: number; href: string }[] = [
  { id: "brand", points: 10, href: "/files" },
  { id: "guard", points: 20, href: "/settings/brand#guard" },
  { id: "approve", points: 20, href: "" },
  { id: "schedule", points: 15, href: "/calendar" },
  { id: "connect", points: 25, href: "/settings/connections" },
  { id: "publish", points: 30, href: "" },
  { id: "ai", points: 30, href: "/mcp" },
];
/** Level thresholds by milestones done: a date palm grows from a seed, and a grove of them is an oasis. */
const LEVELS: { id: LevelId; from: number }[] = [
  { id: "seed", from: 0 },
  { id: "sapling", from: 2 },
  { id: "palm", from: 4 },
  { id: "oasis", from: 7 },
];

export type JourneyInput = {
  hasBrand: boolean;
  bannedWords: number;
  tasks: Pick<TaskLite, "status" | "decidedAt" | "scheduledFor" | "published">[];
  connections: number;
  aiLinked: boolean;
  /** "Today" as YYYY-MM-DD in UTC (server components pass it; the function reads no clock). */
  today: string;
};

/** Consecutive days, ending today or yesterday, on which the owner decided at least one item (UTC, like every date here). */
export function decisionStreak(decidedAt: (string | undefined)[], today: string): number {
  const days = new Set(decidedAt.filter((d): d is string => !!d).map((d) => d.slice(0, 10)));
  const step = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  let d = days.has(today) ? today : step(today);
  let n = 0;
  while (days.has(d)) { n++; d = step(d); }
  return n;
}

/** Level for a number of milestones done, and the count at which the next level starts (null at the top). */
export function levelFor(n: number): { level: LevelId; nextAt: number | null; nextLevel: LevelId | null } {
  const at = [...LEVELS].reverse().find((l) => n >= l.from)!;
  const nx = LEVELS.find((l) => l.from > n);
  return { level: at.id, nextAt: nx?.from ?? null, nextLevel: nx?.id ?? null };
}

export function computeJourney(x: JourneyInput): Journey {
  const done: Record<MilestoneId, boolean> = {
    brand: x.hasBrand,
    guard: x.bannedWords > 0,
    // An item approved by the owner has a decision time; auto-approved items do not, and do not count as the owner's.
    approve: x.tasks.some((t) => t.status === "approved" && !!t.decidedAt),
    schedule: x.tasks.some((t) => !!t.scheduledFor),
    connect: x.connections > 0,
    publish: x.tasks.some((t) => (t.published ?? 0) > 0),
    ai: x.aiLinked,
  };
  const milestones = PATH.map((p) => ({ ...p, done: done[p.id] }));
  const n = milestones.filter((m) => m.done).length;
  const { level, nextAt } = levelFor(n);
  return {
    milestones,
    done: n,
    total: milestones.length,
    points: milestones.filter((m) => m.done).reduce((s, m) => s + m.points, 0),
    maxPoints: milestones.reduce((s, m) => s + m.points, 0),
    level,
    nextLevelAt: nextAt,
    streak: decisionStreak(x.tasks.map((t) => t.decidedAt), x.today),
    next: milestones.find((m) => !m.done)?.id ?? null,
  };
}
