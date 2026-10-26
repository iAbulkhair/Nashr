import { isStaging } from "./deploy-env";
import * as flags from "./v2-flags";
import type { GatewayMode } from "./v2-flags";

/**
 * Is a v2 switch on for this request? (rules 4820-4824, docs/system/tests/4820-v2-staging-switch.md)
 *
 * The code value in `src/lib/v2-flags.ts` decides everywhere: a released flag is on, an unreleased one is off. On the
 * staging site only (`isStaging()`: exactly `APP_ENV=staging`) a flag that is still off in code may be turned on by
 * naming it in `V2_STAGING_FLAGS`, a comma list, so the founder can try one feature at a time from hPanel without a
 * release. On every other host the variable is never read, so live answers exactly as the code values say.
 *
 * Read at call time, never at import: the list changes with a restart, and `next build` imports these modules.
 * Release step: EXPAND (a new optional variable; unset, nothing changes on any host).
 */
export type V2Flag =
  | "RUN_LOG"
  | "MEMORY_V2"
  | "COMPACTION"
  | "PLANS"
  | "QUEUE"
  | "SELF_CHECK"
  | "TEAM_CHAT"
  | "RESEARCH";

/** The names `V2_STAGING_FLAGS` understands. `GATEWAY_LOG` turns the gateway to `"log"`; any other name is ignored. */
export const STAGING_NAMES: readonly string[] = [
  "RUN_LOG",
  "GATEWAY_LOG",
  "MEMORY_V2",
  "COMPACTION",
  "PLANS",
  "QUEUE",
  "SELF_CHECK",
  "TEAM_CHAT",
  "RESEARCH",
];

/** The names `V2_STAGING_FLAGS` turns on for this request; always empty on a host that is not staging. */
export function stagingFlags(): ReadonlySet<string> {
  if (!isStaging()) return new Set();
  const raw = process.env.V2_STAGING_FLAGS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => STAGING_NAMES.includes(s)),
  );
}

export function v2On(name: V2Flag): boolean {
  return flags[name] === true || stagingFlags().has(name);
}

export function gatewayMode(): GatewayMode {
  if (flags.GATEWAY_MODE !== "off") return flags.GATEWAY_MODE;
  return stagingFlags().has("GATEWAY_LOG") ? "log" : "off";
}
