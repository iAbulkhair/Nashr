import { NextResponse } from "next/server";
import { getStaff, issuedBeforeStaff } from "@/lib/staff";
import { dropStaffPre, readStaffPre } from "@/lib/staff-session";
import { confirmStaffEnrol, startAgain, startStaffEnrol } from "@/lib/staff-signin";

/**
 * Enrol an authenticator (rule 1632): the first sign-in, after a recovery code, or after a reset. Needs the pre-auth
 * cookie at stage `enrol`. There is no skip: a staff session opens only from `confirm`.
 *
 * POST { action: "start" }: a new secret and its `otpauth://` URI for the QR code (nothing stored on the record yet).
 * POST { action: "confirm", code }: a code from the new secret (tries limited, step burned) stores it with 8 new
 *   recovery codes, answered this once, and opens the session.
 */
export async function POST(req: Request) {
  const pre = await readStaffPre();
  if (!pre || pre.stage !== "enrol") return startAgain();
  const staff = await getStaff(pre.email);
  if (!staff || staff.disabled || !staff.passHash || issuedBeforeStaff(staff, pre.at)) {
    await dropStaffPre(pre.hash);
    return startAgain();
  }
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; code?: unknown };
  if (b.action === "start") {
    try {
      return NextResponse.json({ ok: true, ...(await startStaffEnrol(staff.email, pre.hash)) }, { headers: { "cache-control": "no-store" } });
    } catch {
      return NextResponse.json({ ok: false, error: "no_secret_key" }, { status: 503 });
    }
  }
  if (b.action === "confirm") return confirmStaffEnrol(req, staff, pre, b.code);
  return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
}
