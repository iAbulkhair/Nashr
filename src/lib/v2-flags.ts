/**
 * The switches of Thakeen v2 phase 0 (rules 4500-4549, docs/system/tests/4500-v2-phase0.md, the "Thakeen v2" plan).
 *
 * Release step (rule 679): EXPAND. Both are off in this release: no route, model call or tool answer changes, and nothing
 * new is written. Turned on in a later release by changing the value here, never from a request. They live in their own
 * module so a test can turn them on with `vi.mock("@/lib/v2-flags")`.
 *
 * Code reads them through `v2On` and `gatewayMode` in `src/lib/v2-switch.ts`, never directly: there, on the staging site
 * only, `V2_STAGING_FLAGS` can turn on a flag that is still off here (rules 4820-4824). On every other host the values
 * below are the whole answer.
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

/**
 * Scoped memory and recall (phase 1, C5, rules 4550-4579; src/lib/memory.ts, src/lib/recall.ts). `false`: the chat offers
 * no `remember` tool and its prompt gets no recalled facts, exactly as before. `true`: the tool proposes facts as cards the
 * owner saves, and every chat turn recalls the brand's saved facts that fit the message. Release step: EXPAND.
 */
export const MEMORY_V2: boolean = false;

/**
 * Thread compaction (phase 1, C11, rules 4580-4599; src/lib/compaction.ts). `false`: the history guard drops the oldest
 * messages of a long thread, exactly as before. `true`: the messages it drops are folded into a stored summary of the
 * thread, which the next turns read as data. Release step: EXPAND.
 */
export const COMPACTION: boolean = false;

/**
 * Goals and plans (phase 2, C3, rules 4620-4649; src/lib/plans.ts, src/lib/plan-tool.ts, src/lib/plan-run.ts). `false`: Majed offers no
 * `make_plan` tool and the plan routes answer 404, exactly as before. `true`: Majed turns a goal into a plan card of up to
 * eight steps with their agents and costs, which runs only after the owner's Approve. Release step: EXPAND.
 */
export const PLANS: boolean = false;

/**
 * The durable job queue (phase 2, C7, rules 4650-4669; src/lib/queue.ts, GET /api/cron/queue). `false`: nothing is
 * queued, the tick does nothing and the route answers `{ ok: true, off: true }`. `true`: an approved plan's steps wait
 * here and run one per workspace per tick, with their attempts counted before the work. Release step: EXPAND.
 */
export const QUEUE: boolean = false;

/**
 * The self-check before an item reaches the inbox (phase 2, C6, rules 4670-4689; src/lib/self-check.ts). `false`: a batch
 * is judged after it is saved, exactly as before. `true`: a scheduled batch (a routine, a plan step) is judged before it
 * is saved, and a weak item is rewritten once with the judge's notes, inside the credits already charged. Release step: EXPAND.
 */
export const SELF_CHECK: boolean = false;

/**
 * Team chat and one task owner (phase 3, C4 + C12, rules 4730-4759; src/lib/team-chat.ts). `false`: a turn is answered by
 * the agent the page names, exactly as before. `true`: the person can write @Name to bring an agent into the thread; the
 * thread's owner drafts, an agent named beside it only adds notes, and ownership moves only when a person presses the card.
 * Release step: EXPAND.
 */
export const TEAM_CHAT: boolean = false;

/**
 * The research tool (phase 4, C10, rules 4790-4819; src/lib/research.ts, src/lib/research-tool.ts). `false`: no agent is
 * offered `web_search` or `read_page`, the card route answers 404 and the judge's prompt is as before. `true`: Faris, Noor
 * and Layan may ask to search the web; each search runs only after a person presses Approve on its card, and the pages
 * they read come back fenced as untrusted data. Off for customers until the founder sets its price. Release step: EXPAND.
 */
export const RESEARCH: boolean = false;
