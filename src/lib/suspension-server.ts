import { saveUser } from "./auth";
import { withUserLock } from "./credits";
import { adminAudit } from "./admin-audit";
import { log } from "./log";
import { suspensionEnd, suspensionExpired } from "./suspension";

/**
 * Tidy one account whose suspension has ended (rule 2073): clear the stored `suspended` and write the expiry to the
 * audit log as actor "system", action `suspension.expired`. Nothing depends on it running: `isSuspended` already lets
 * the account in once the end date passes. It runs where an expired record is met anyway (a sign-in of the account or
 * its members, and staff opening the account), so the log gains the row then. Under the account's lock and re-read
 * there, so two sign-ins at once write one row, and a suspension renewed in between is never cleared.
 *
 * Best effort: a lock timeout or a log failure is logged and answers false; the sign-in carries on.
 */
export async function endExpiredSuspension(email: string, now: number = Date.now()): Promise<boolean> {
  try {
    const until = await withUserLock(email, async (x) => {
      if (!suspensionExpired(x, now)) return null;
      const end = suspensionEnd(x);
      x.suspended = false;
      await saveUser(x);
      return end;
    });
    if (until === null) return false;
    await adminAudit({ actor: "system", section: "users", target: email, what: "suspension expired", action: "suspension.expired", before: { suspended: true, until }, after: { suspended: false } });
    return true;
  } catch (e) {
    log.error("suspension tidy failed", e);
    return false;
  }
}
