/**
 * Reem, the secretary: the owner's snooze presets and the parsing of an owner's change from the app.
 */
import { DEFAULT_ZONE, ZONES, weekStartDay, type Zone } from "./zones";
import { addDays, parseWhen, zoneDay, zoneTime, type CalData } from "./secretary-agenda";
import type { Change } from "./secretary-mutate";
import { type SecFail, fail, parseFields, text } from "./secretary-input";

// ---------------------------------------------------------------------------------------------------------------
// Snooze presets, computed on the server's clock in the brand's local time.

export const SNOOZE_PRESETS = ["2h", "tonight", "tomorrow", "nextweek"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
/**
 * The first working day of next week, as a local day: the next week-start day after today (Sunday, Monday in the UAE,
 * or the brand's own from its calendar: `cal.weekStart`), a full week ahead when today is that day.
 */
export function nextWeekStart(now: number, z: Zone = DEFAULT_ZONE, cal?: CalData): string {
  const today = zoneDay(now, z);
  const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = cal ? cal.weekStart : weekStartDay(ZONES[z].weekend);
  return addDays(today, (start - wd + 7) % 7 || 7);
}
/**
 * 2h: two hours from now · tonight: 20:00 today (null once it has passed) · tomorrow: 09:00 tomorrow · nextweek: 09:00
 * on the first working day of next week (the brand's, when `cal` is given).
 */
export function snoozePreset(p: SnoozePreset, now: number, z: Zone = DEFAULT_ZONE, cal?: CalData): string | null {
  const today = zoneDay(now, z);
  const ms = p === "2h" ? now + 2 * 3600_000 : p === "tonight" ? zoneTime(today, 20, 0, z) : p === "nextweek" ? zoneTime(nextWeekStart(now, z, cal), 9, 0, z) : zoneTime(addDays(today, 1), 9, 0, z);
  return ms > now ? new Date(ms).toISOString() : null;
}

/**
 * The owner's PATCH body as one change: `{action, ...}` with action update (default), complete {result}, snooze
 * {preset | until}, reschedule {dueAt}, confirm_done {result?}, reject_done, delete, restore, skip, stop_repeat, add_note {text, private?},
 * chased (the owner followed up: the chase clock restarts). Dates in zone `z`; "next week" starts on the brand's own
 * week start when its calendar `cal` is given. Every argument is validated here; nothing else in the body is read.
 */
export function parseOwnerChange(b: Record<string, unknown>, now: number, z: Zone = DEFAULT_ZONE, cal?: CalData): Change | SecFail {
  const action = b.action ?? "update";
  switch (action) {
    case "update": {
      const p = parseFields(b, now, z);
      return p.ok ? { action: "update", fields: p.fields } : p;
    }
    case "chased":
      return { action: "update", fields: {}, chased: true };
    case "complete": {
      const t = text(b.result, "result", true);
      if (!t.ok) return t;
      return t.value ? { action: "complete", result: t.value } : fail("result_required", 400, "result");
    }
    case "snooze": {
      if (b.preset !== undefined) {
        if (!(SNOOZE_PRESETS as readonly unknown[]).includes(b.preset)) return fail("bad_date", 400, "preset");
        const until = snoozePreset(b.preset as SnoozePreset, now, z, cal);
        return until ? { action: "snooze", until } : fail("snooze_past", 400, "preset");
      }
      const w = parseWhen(b.until, now, z);
      if (!w.ok) return fail(w.error, 400, "until");
      if (!w.at) return fail("bad_date", 400, "until");
      return { action: "snooze", until: w.at };
    }
    case "reschedule": {
      const w = parseWhen(b.dueAt, now, z);
      return w.ok ? { action: "reschedule", dueAt: w.at, allDay: w.allDay } : fail(w.error, 400, "dueAt");
    }
    case "confirm_done": {
      const t = text(b.result, "result", true);
      if (!t.ok) return t;
      return t.value ? { action: "confirm_done", result: t.value } : { action: "confirm_done" };
    }
    case "reject_done": case "delete": case "restore": case "reopen": case "skip": case "stop_repeat":
      return { action: action as "reject_done" | "delete" | "restore" | "reopen" | "skip" | "stop_repeat" };
    case "add_note": {
      const t = text(b.text, "note", true);
      if (!t.ok) return t;
      if (!t.value) return fail("nothing_to_change", 400, "text");
      return { action: "add_note", text: t.value, private: b.private === true };
    }
    default:
      return fail("bad_action");
  }
}
