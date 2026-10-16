import { db } from "./db";
import { adminAudit } from "./admin-audit";
import { customerCode, providerFault, type CustomerModelError, type ProviderFault } from "./provider-errors";
import { log } from "./log";

/** Where a fault was met; a fixed name from code, never from a request. */
export type FaultPlace = "chat" | "generate" | "onboard";

/** One audit row per fault and place in this window (rule 1478): a busy hour writes one row, not one per customer. */
export const FAULT_NOTE_TTL_S = 3600;

/**
 * The founder audit row for a provider fault (rule 1478): section "system", actor "system", action `provider_{fault}`,
 * target the place. At most one an hour per fault and place (`db.setNx` on a key built from those two fixed names only).
 * Best effort: a store that fails never changes the customer's answer. No account, provider text or key in the row.
 */
export async function noteProviderFault(fault: ProviderFault, place: FaultPlace): Promise<void> {
  try {
    if (!(await db.setNx(`providerfault:${fault}:${place}`, "1", FAULT_NOTE_TTL_S))) return;
    await adminAudit({ actor: "system", section: "system", action: `provider_${fault}`, target: place, what: `provider_${fault} ${place}` });
  } catch (e) {
    log.error("provider fault note failed", e);
  }
}

/** The customer's code for `e` when it is a provider fault, after noting it for the founder; null for any other error. */
export async function customerModelError(e: unknown, place: FaultPlace): Promise<CustomerModelError | null> {
  const f = providerFault(e);
  if (!f) return null;
  await noteProviderFault(f, place);
  return customerCode(f);
}
