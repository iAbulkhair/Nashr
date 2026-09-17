import { db } from "./db";
import type { TaskType } from "./brand";

export type Governance = {
  autoApprove: Partial<Record<TaskType, boolean>>; // skip inbox for these types
  weeklyCap: number; // max items Noor may create per week on her own (scheduled tasks; future)
  learning: boolean; // write preferences from edits/rejections
  reviewer: boolean; // second-pass quality reviewer
  noEmDash: boolean; // strip em/en dashes from output
  notifyMinutes: number; // minutes before a scheduled post to notify (future: WhatsApp/email)
};

export const DEFAULT_GOV: Governance = { autoApprove: {}, weeklyCap: 20, learning: true, reviewer: true, noEmDash: false, notifyMinutes: 60 };

export async function getGov(email: string): Promise<Governance> {
  return { ...DEFAULT_GOV, ...((await db.get<Partial<Governance>>(`gov:${email}`)) ?? {}) };
}
export async function saveGov(email: string, g: Partial<Governance>) {
  const cur = await getGov(email);
  const next: Governance = {
    autoApprove: { ...cur.autoApprove, ...(g.autoApprove ?? {}) },
    weeklyCap: typeof g.weeklyCap === "number" ? Math.max(0, Math.min(200, g.weeklyCap)) : cur.weeklyCap,
    learning: typeof g.learning === "boolean" ? g.learning : cur.learning,
    reviewer: typeof g.reviewer === "boolean" ? g.reviewer : cur.reviewer,
    noEmDash: typeof g.noEmDash === "boolean" ? g.noEmDash : cur.noEmDash,
    notifyMinutes: typeof g.notifyMinutes === "number" ? Math.max(0, Math.min(1440, g.notifyMinutes)) : cur.notifyMinutes,
  };
  await db.set(`gov:${email}`, next);
  return next;
}
