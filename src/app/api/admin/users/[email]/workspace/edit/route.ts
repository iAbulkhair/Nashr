import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { adminActor, consoleRole, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";
import { accountForChosen } from "@/lib/admin-workspace";
import { applyEdit, parseEdit, tellOwnerOfEdit } from "@/lib/admin-workspace-edit";
import { aidOf } from "@/lib/membership";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { staffMay } from "@/lib/roles";
import { log } from "@/lib/log";
import { teamFail } from "@/app/api/team/respond";

export const dynamic = "force-dynamic";

/** Console team changes by one console actor per hour, to one account per day, and invitations to one address per day (rule 3556). */
const PER_ACTOR_HOUR = 30;
const PER_ACCOUNT_DAY = 30;
const PER_ADDRESS_DAY = 5;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * POST /api/admin/users/{email}/workspace/edit (rules 3550-3569, docs/system/flows.md section 126): Thakeen support
 * changes one customer workspace on the customer's behalf. Body `{ action, owner, reason, ...fields }`:
 * `rename {name}`, `invite {email, role, lang?}`, `remove {email}`, `cancel_invite {email}`.
 *
 * In this order: a console actor (`adminActor`, 401) → the console owner only (`staffMay(consoleRole(req),
 * "workspace.edit")`, 403 `forbidden`: support staff may view the workspace, never change it) → the second factor
 * (`secondFactorRefusal`, which also runs the console write check: same origin, JSON only) → the body (400
 * `bad_request`) → a reason of 3 to 200 characters (400) → the per-actor rate limit (429) → the account, found from the
 * path's address as the view finds it (`accountForChosen`, 404), and the body's `owner` must be that account's owner
 * address (409 `workspace_changed`: the address now stands for another account than the one on screen) → the per-account
 * and, for an invite, the per-address limit (429) → the change (src/lib/admin-workspace-edit.ts, through the customer's
 * own team functions) → one `admin:log` row in section `users` with the reason → the owner's notice → the answer.
 *
 * An audit row that cannot be written puts a rename or an invite back and answers 500 `audit_failed`; a removal or a
 * cancellation cannot be put back, so a `log.error` line names it (its team log row stands). No key is built from the
 * request: the account comes from the stored login, invite ids from the account's own index, and the rate buckets are
 * the actor's and the address's SHA-256 and the resolved account id.
 */
export async function POST(req: Request, ctx: { params: Promise<{ email: string }> }) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!staffMay(consoleRole(req), "workspace.edit")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseEdit(raw);
  if (!input) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const noReason = reasonRefused(raw?.reason);
  if (noReason) return noReason;
  if (!(await allow(accountKey.consoleActorBucket(sha(who)), PER_ACTOR_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);

  let chosen: string;
  try {
    chosen = decodeURIComponent((await ctx.params).email ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const found = await accountForChosen(chosen);
  if (!found) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const { owner } = found;
  if (input.owner !== owner.email) return NextResponse.json({ ok: false, error: "workspace_changed" }, { status: 409 });
  const [perAccount, perAddress] = await Promise.all([
    allow(accountKey.consoleTeamBucket(aidOf(owner)), PER_ACCOUNT_DAY, WINDOW.day),
    input.action === "invite" && input.email ? allow(accountKey.inviteToBucket(sha(input.email)), PER_ADDRESS_DAY, WINDOW.day) : Promise.resolve(true),
  ]);
  if (!perAccount || !perAddress) return retryLater({ ok: false, error: "slow_down" }, WINDOW.day);

  const done = await applyEdit(owner, input);
  if (!done.ok) {
    if ("team" in done) return teamFail(done.team);
    return NextResponse.json({ ok: false, error: done.error }, { status: done.status });
  }
  try {
    await adminAudit({
      actor: who, via: viaOf(req), section: "users", action: `workspace.${done.action}`, target: owner.email,
      what: `workspace ${done.action.replace("_", " ")}: ${done.subject}`, before: done.before, after: done.after, reason: raw?.reason,
      ...(found.openedFrom ? { extra: { openedFrom: found.openedFrom } } : {}),
    });
  } catch (e) {
    const undone = done.undo ? await done.undo().then(() => true, () => false) : false;
    log.error(undone ? "workspace edit: audit row failed, change put back" : "workspace edit: audit row failed, change kept with no audit row", { action: done.action, error: e });
    return NextResponse.json({ ok: false, error: "audit_failed" }, { status: 500 });
  }
  await tellOwnerOfEdit(owner, done);
  return NextResponse.json({ ok: true, action: done.action, subject: done.subject }, { headers: { "Cache-Control": "no-store" } });
}
