import { NextResponse } from "next/server";
import { actorInfo, adminActor, viaOf } from "@/lib/auth";
import { adminAudit } from "@/lib/admin-audit";
import { consoleWriteRefusal } from "@/lib/console-origin";
import { confirmEnrolment, secondFactorRefusal, secondFactorStatus, startEnrolment, stepUpLive, verifyAndStepUp } from "@/lib/admin-2fa";

/**
 * The founder console's second factor (rules 1370-1389, src/lib/admin-2fa.ts). Founder or console key only
 * (`adminActor`), 401 otherwise.
 *
 * GET: whether a second factor is enrolled and whether this browser holds a live step-up.
 * POST { action: "start" }: a new authenticator secret to add to the app (not enrolled until confirmed). Replacing an
 *   enrolled one passes the gate first, so a leaked key alone cannot swap the founder's phone for its own.
 * POST { action: "confirm", code }: enrol the started secret; answers the recovery code, shown this once.
 * POST { action: "verify", code }: the console's code prompt; a 6-digit code opens a step-up, the recovery code removes
 *   the enrolment (the console asks for a new setup).
 * Codes are rate limited (429 `slow_down`); a wrong one answers 400 `bad_code`. The secret and the codes are never logged.
 *
 * Staff (rule 1636): `admin:2fa` stays the console key's own factor. A staff actor's GET reads its own step-up and
 * answers `enrolled: true` (every staff session has an authenticator); `verify` checks the person's own code; `start`
 * and `confirm` are refused with 403 `staff_own_factor`: staff replace their authenticator through a reset code.
 */
export async function GET(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const info = actorInfo(req);
  if (info?.via === "staff") return NextResponse.json({ ok: true, enrolled: true, at: null, stepUp: await stepUpLive(who, info.staffCookie ?? null), staff: true });
  const [s, stepUp] = await Promise.all([secondFactorStatus(), stepUpLive(who)]);
  return NextResponse.json({ ok: true, enrolled: s.enrolled, at: s.at, stepUp });
}

export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Every action here, `verify` and `confirm` included, runs the console write check in the route itself (rule 1647).
  const foreign = consoleWriteRefusal(req, viaOf(req) === "header");
  if (foreign) return foreign;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; code?: unknown };
  if ((b.action === "start" || b.action === "confirm") && actorInfo(req)?.via === "staff") {
    return NextResponse.json({ ok: false, error: "staff_own_factor" }, { status: 403 });
  }
  if (b.action === "start") {
    const gate = await secondFactorRefusal(req, who);
    if (gate) return gate;
    try {
      return NextResponse.json({ ok: true, ...(await startEnrolment(who)) });
    } catch {
      // Production without CONNECT_SECRET: nothing can be stored encrypted, so nothing is enrolled (the console stays key-only).
      return NextResponse.json({ ok: false, error: "no_secret_key" }, { status: 503 });
    }
  }
  if (b.action === "confirm") {
    const r = await confirmEnrolment(req, who, b.code);
    if (!r.ok) return r.res;
    await adminAudit({ actor: who, via: viaOf(req), section: "system", action: "2fa.enrol", target: "console", what: "2fa:enrol" });
    return NextResponse.json({ ok: true, recovery: r.recovery });
  }
  if (b.action === "verify") {
    const r = await verifyAndStepUp(req, who, b.code);
    if (!r.ok) return r.res;
    if (r.via === "recovery") await adminAudit({ actor: who, via: viaOf(req), section: "system", action: "2fa.recovery", target: "console", what: "2fa:recovery (enrolment removed)" });
    return NextResponse.json({ ok: true, via: r.via, stepUp: !!r.stepUp });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
