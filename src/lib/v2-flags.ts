/**
 * The switches of Thakeen v2 phase 0 (rules 4500-4549, docs/system/tests/4500-v2-phase0.md, the "Thakeen v2" plan).
 *
 * Release step (rule 679): EXPAND. Both are off in this release: no route, model call or tool answer changes, and nothing
 * new is written. Turned on in a later release by changing the value here, never from a request or an environment
 * variable. They live in their own module so a test can turn them on with `vi.mock("@/lib/v2-flags")`.
 */

/**
 * The action gateway (src/lib/gateway.ts). `"off"`: nothing runs. `"log"`: every chat and MCP tool call is judged by the
 * gateway's policy table and an audit row is written, but the call goes on exactly as before, and a row says when the old
 * path ran something the gateway would have refused. `"enforce"` comes in phase 4 and is not a value yet.
 */
export type GatewayMode = "off" | "log";
export const GATEWAY_MODE: GatewayMode = "off";

/** The run log (src/lib/runs.ts): `false` keeps no run record; `true` keeps one per chat turn, MCP call and batch for 30 days. */
export const RUN_LOG: boolean = false;
