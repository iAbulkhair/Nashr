import { NextResponse } from "next/server";
import { adminActor, consoleRole, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";
import { passkeysOn, setPasskeysOn } from "@/lib/passkey-switch";
import { staffMay } from "@/lib/roles";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * The customer passkey off switch (rule 2426, spec docs/specs/2026-10-20-passkeys.md flow E), on the `skills:paused`
 * pattern. Fail-open by design: passkeys are on unless `passkeys:off` holds "1" (src/lib/passkey-switch.ts). Turning it
 * off stops passkey sign-in and adding (404 `unavailable` on both sign-in routes and both register steps); listing,
 * renaming and removing keep working, and no stored passkey is read, changed or deleted here. Passwords keep working, so
 * switching off locks nobody out.
 *
 * GET -> `{ ok, on, may }` for the Integrations page toggle: any console actor (`adminActor`, else 401); a read, so no
 * second factor and no audit row. `may` says whether this caller may flip it (`staffMay(consoleRole(req),
 * "passkeys.switch")`, the same check POST runs), so a support or read-only staff member sees a disabled toggle instead
 * of learning it after typing a reason. It only shapes the page: POST checks again.
 */
export async function GET(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const on = await passkeysOn();
  const may = staffMay(consoleRole(req), "passkeys.switch");
  return NextResponse.json({ ok: true, on, may }, { headers: { "cache-control": "no-store" } });
}

/**
 * POST `{ on: boolean, reason }` -> `{ ok, on }`. In this order: a console actor (`adminActor`, 401) → the console owner
 * only (`staffMay(consoleRole(req), "passkeys.switch")`, 403 `forbidden`; a support staff session is refused here) →
 * the second factor (`secondFactorRefusal`, which also runs the console write check; its code check is rate limited
 * per IP) → a reason of 3 to 200 characters (400) → `on` a boolean (400 `bad_request`) → the switch written → one
 * `admin:log` row in section `system` with the state before and after. `before` is the state the write itself replaced
 * (the switch write answers it). An audit write that throws puts the switch back and answers 500 `audit_failed`; if the
 * undo fails too, a `log.error` line names it. No key is built from the body.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!staffMay(consoleRole(req), "passkeys.switch")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  if (typeof b.on !== "boolean") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const on = b.on;
  // The state before comes from the write itself (GETDEL / SET NX), so a flip racing this one cannot make `before` wrong.
  const was = await setPasskeysOn(on);
  try {
    await adminAudit({
      actor: who, via: viaOf(req), section: "system", action: on ? "passkeys.on" : "passkeys.off", target: "passkeys",
      what: on ? "passkeys on" : "passkeys off", before: { on: was }, after: { on }, reason: b.reason,
    });
  } catch (e) {
    // No flip stays without its audit row: the switch is put back and the caller told, so the owner tries again. Should
    // the undo fail as well (the store down), the log line is the only record of a switch changed with no row.
    const undone = was === on || (await setPasskeysOn(was).then(() => true, () => false));
    log.error(undone ? "passkeys switch: audit row failed, switch put back" : "passkeys switch: audit row failed and the undo failed, switch changed with no audit row", { on, was, error: e });
    return NextResponse.json({ ok: false, error: "audit_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, on }, { headers: { "cache-control": "no-store" } });
}
