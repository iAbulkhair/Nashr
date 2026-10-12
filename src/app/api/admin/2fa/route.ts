import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { adminAudit } from "@/lib/admin-audit";
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
 */
export async function GET(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const [s, stepUp] = await Promise.all([secondFactorStatus(), stepUpLive(who)]);
  return NextResponse.json({ ok: true, enrolled: s.enrolled, at: s.at, stepUp });
}

export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; code?: unknown };
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
    await adminAudit({ actor: who, section: "system", action: "2fa.enrol", target: "console", what: "2fa:enrol" });
    return NextResponse.json({ ok: true, recovery: r.recovery });
  }
  if (b.action === "verify") {
    const r = await verifyAndStepUp(req, who, b.code);
    if (!r.ok) return r.res;
    if (r.via === "recovery") await adminAudit({ actor: who, section: "system", action: "2fa.recovery", target: "console", what: "2fa:recovery (enrolment removed)" });
    return NextResponse.json({ ok: true, via: r.via, stepUp: !!r.stepUp });
  }
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
