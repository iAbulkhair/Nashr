import { NextResponse } from "next/server";
import { adminActor, consoleRole, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { staffMay } from "@/lib/roles";
import { globalKey } from "@/lib/keys";
import { CONVERSIONS, countsText, isConversion, runConversion } from "@/lib/conversions/console";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Runs per console actor per hour, dry and applied together (rule 4102): each one reads every account. */
const CONVERSIONS_PER_HOUR = 20;

const STATUS = { dry_run_only: 400, dry_run_first: 409, busy: 409 } as const;

/**
 * POST /api/admin/conversions/{name} `{ apply?: boolean, reason? }` (rules 4100-4106, docs/system/flows.md section 125):
 * the founder runs a one-time data conversion from the console on the app's own store connection, so no terminal and no
 * store credentials are needed. `name` is `account-ids` (account-id R1, `convertAccountIds`) or `multi-org-index` (S1,
 * dry run only: it was applied on 2026-10-23). In this order: a console actor (`adminActor`, 401) → the console owner
 * (`staffMay(consoleRole(req), "data.convert")`, 403 `forbidden`) → a known name (404 `not_found`; the name only picks
 * an entry of the fixed list, no key is built from it) → the rate limit, 20 runs an hour per actor (429 `slow_down`) →
 * the console write check (`consoleWriteRefusal`) → `apply` absent or a boolean (400 `bad_request`; absent is a dry
 * run) → for an apply only, the second factor (`secondFactorRefusal`) and a reason of 3 to 200 characters → the run,
 * under one owned lock for every conversion (409 `busy`). An apply also needs a clean dry run of the same conversion in
 * the last 15 minutes (409 `dry_run_first`) and uses it up. Then one `admin:log` row, section `data`, action
 * `{account_ids|multi_org_index}_{dry_run|apply}`, the counts in `what` and `after`. The answer is counts only: no
 * address, id or key (`countsOnly`). A run that throws is 500 `failed`, with a log line that names no record.
 */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!staffMay(consoleRole(req), "data.convert")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { name } = await ctx.params;
  if (!isConversion(name)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await allow(globalKey.conversionBucket(who), CONVERSIONS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const cross = consoleWriteRefusal(req, viaOf(req) === "header");
  if (cross) return cross;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (b.apply !== undefined && typeof b.apply !== "boolean") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const apply = b.apply === true;
  if (apply) {
    const no2fa = await secondFactorRefusal(req, who);
    if (no2fa) return no2fa;
    const noReason = reasonRefused(b.reason);
    if (noReason) return noReason;
  }
  let res: Awaited<ReturnType<typeof runConversion>>;
  try {
    res = await runConversion(name, apply, who);
  } catch (e) {
    log.error("console conversion stopped", { name, apply, error: e });
    return NextResponse.json({ ok: false, error: "failed" }, { status: 500 });
  }
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: STATUS[res.error] });
  const action = `${CONVERSIONS[name].action}_${apply ? "apply" : "dry_run"}`;
  // The run already happened, so a failed audit row does not hide its counts: the log line records it instead.
  const audited = await adminAudit({
    actor: who, via: viaOf(req), section: "data", action, target: name, what: countsText(action, res.report),
    after: res.report, ...(apply ? { reason: b.reason } : {}),
  }).then(() => true, (e: unknown) => {
    log.error("console conversion: audit row failed", { name, apply, error: e });
    return false;
  });
  return NextResponse.json({ ok: true, name, report: res.report, clean: res.clean, ms: res.ms, audited }, { headers: { "cache-control": "no-store" } });
}
