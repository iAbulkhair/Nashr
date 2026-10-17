/**
 * Reem, the secretary: the owner's own to-dos, follow-ups and "who owes what", stored per brand scope. Server only.
 *
 * Rules held in code, not in prompts:
 * - Every key is built from the caller's scope (`sc(u)` or the bearer's), never from an id, email or scope in a
 *   request. An item id from a request is format-checked (`SEC_ID`) before a key is built and must exist under the
 *   caller's scope, else it is "not found" whatever other scopes hold.
 * - Only the owner, in the app, completes, confirms, deletes or restores (`OWNER_ONLY`). Chat and MCP can create,
 *   update and propose "done" with evidence; they can never close an item. Completing requires a result.
 * - The one other way an item closes is deterministic: its linked inbox item was approved (`closeLinked`). Only the owner
 *   changes a link on an existing item; chat and MCP may link only at creation, and only to an item still pending, so
 *   the automatic close always follows an approval the owner made after the link.
 * - Writes to one item are serialised under `sec:lock:{scope}:{id}` and checked against `rev`, like `updateTask`.
 * - Reads are batched: the agenda is one sorted-set read, one MGET of the items and at most one MGET of linked tasks,
 *   whatever the number of items.
 * - Free: no credits, no model call. Text in items is the owner's data (or text an agent copied from a customer or a
 *   connector); it is cleaned and bounded here and shown to agents as data. An agent's "it is done" is a claim, shown
 *   as one next to what code checked (`linkFactText`), never as a fact.
 * - Dates are read, bucketed and written back in the brand's time zone (`zoneFor`: an allow-listed zone on the brand,
 *   Riyadh by default), and wherever the agenda or a date is computed, on the brand's work calendar and away map
 *   (`calFor`: `sec:cal` and `sec:away`, read in the same round as the zone).
 */

export { SEC_ID, newSecId, SERIES_ID, newSeriesId, SEC_KEYS, SEC_CREATE_PER_DAY, SEC_WRITES_PER_HOUR, SEC_READS_PER_HOUR, SEC_OPEN_MAX, SEC_PURGE_BATCH, SEC_ALERTS_PER_DAY } from "./secretary-keys";
export { zoneFor, usableCalendar, calendarOf, isLocalDay, awayMapOf, calFor } from "./secretary-zone";
export { fail, cleanLine, cleanBlock, OWNER_ALIASES, parseRepeat, isWaNumber, cleanPhone, REMIND_DAY_AT, parseFields } from "./secretary-input";
export type { Who, SecError, SecFail, SecFields, RepeatInput } from "./secretary-input";
export { OWNER_ONLY, mutateItem } from "./secretary-mutate";
export type { Change, ChangeAction } from "./secretary-mutate";
export { stateOf, reindexOpen, audit, getItem, createItem, withLock, listOpenItems } from "./secretary-store";
export type { State } from "./secretary-store";
export { SPAWN_CLAIM_S, removeBySystem, changeItem, fireReminder, TICK_FRESH_MS, timedReminders } from "./secretary-change";
export { factOf, agendaFor, todoPage, listDone, listDeleted, purgeExpired, secretaryDaily, secretaryKeys, forgetDueScope, overdueAlertFingerprint, backFingerprint } from "./secretary-read";
export { SNOOZE_PRESETS, nextWeekStart, snoozePreset, parseOwnerChange } from "./secretary-owner";
export type { SnoozePreset } from "./secretary-owner";
export { SEC_TOOL_NAMES, isSecTool, SEC_TOOL_DEFS, toolError, remindLine, whereShown, ruleText, runSecretaryTool } from "./secretary-tools";
export type { SecToolName } from "./secretary-tools";
