import { db } from "../db";
import { globalKey } from "../keys";
import { convertAccountIds, type IdsReport } from "./account-ids";
import { run as convertMultiOrgIndex, type IndexReport } from "./multi-org-index";

/**
 * The one-time data conversions the founder console can run (rules 4100-4106, docs/system/flows.md section 125), so the
 * founder needs no terminal and no store credentials: the route runs them on the app's own store connection. Each entry
 * names its audit action, whether the console may apply it, and when a dry run counts as clean (nothing it would leave
 * alone). S1 (`multi-org-index`) was applied on production on 2026-10-23, so the console runs it dry only.
 */
export const CONVERSIONS = {
  "account-ids": {
    action: "account_ids",
    applies: true,
    run: (apply: boolean): Promise<IdsReport> => convertAccountIds(apply),
    clean: (r: IdsReport) => r.conflicts === 0 && r.orphans === 0,
  },
  "multi-org-index": {
    action: "multi_org_index",
    applies: false,
    run: (apply: boolean): Promise<IndexReport> => convertMultiOrgIndex({ apply }),
    clean: (r: IndexReport) => !(r.personConflicts || r.loginConflicts || r.ownerConflicts || r.orphanRecords || r.orphanEntries || r.busy),
  },
} as const;

export type ConversionName = keyof typeof CONVERSIONS;
export const CONVERSION_NAMES = Object.keys(CONVERSIONS) as ConversionName[];
export const isConversion = (v: unknown): v is ConversionName => typeof v === "string" && Object.prototype.hasOwnProperty.call(CONVERSIONS, v);

/** The lock's life (rule 4103): longer than any run, so a second click waits for the first, and it ends on its own. */
export const LOCK_S = 300;
/** How long a clean dry run lets the apply through (rule 4104). */
export const CLEAN_S = 900;

/** A report as the console sees it: its counts and `apply`, nothing else (rule 4105), whatever the function returned. */
export type Counts = { apply: boolean } & Record<string, number | boolean>;
export function countsOnly(r: object): Counts {
  const out: Counts = { apply: (r as { apply?: unknown }).apply === true };
  for (const [k, v] of Object.entries(r)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

/** One line of counts for the audit row's `what`, e.g. `account_ids_dry_run accounts 12 missing 0 ...`. */
export const countsText = (action: string, c: Counts) =>
  [action, ...Object.entries(c).filter(([k]) => k !== "apply").map(([k, v]) => `${k} ${v}`)].join(" ");

export type ConversionResult =
  | { ok: true; name: ConversionName; report: Counts; clean: boolean; ms: number }
  | { ok: false; error: "dry_run_only" | "dry_run_first" | "busy" };

/**
 * Runs one conversion under the conversion lock (rule 4103): `busy` while another run of any conversion holds it. An
 * apply needs the conversion to allow it (`dry_run_only` otherwise) and a clean dry run from the last 15 minutes
 * (`dry_run_first`, rule 4104), which it uses up. A clean dry run leaves that mark, `{at, by}`; a dry run that is not
 * clean removes it. Nothing here builds a key from the request: `name` is checked against the fixed list first.
 */
export async function runConversion(name: ConversionName, apply: boolean, by: string, now = () => Date.now()): Promise<ConversionResult> {
  const c = CONVERSIONS[name];
  if (apply && !c.applies) return { ok: false, error: "dry_run_only" };
  const token = await db.lockOwned(globalKey.conversionLock(), LOCK_S);
  if (!token) return { ok: false, error: "busy" };
  try {
    if (apply && !(await db.getdel(globalKey.conversionClean(name)))) return { ok: false, error: "dry_run_first" };
    const start = now();
    const report = await (c.run as (a: boolean) => Promise<IdsReport | IndexReport>)(apply);
    const clean = (c.clean as (r: IdsReport | IndexReport) => boolean)(report);
    if (!apply) {
      if (clean) await db.set(globalKey.conversionClean(name), { at: new Date(now()).toISOString(), by }, CLEAN_S);
      else await db.del(globalKey.conversionClean(name));
    }
    return { ok: true, name, report: countsOnly(report), clean, ms: Math.max(0, now() - start) };
  } finally {
    await db.unlockOwned(globalKey.conversionLock(), token).catch(() => {});
  }
}
