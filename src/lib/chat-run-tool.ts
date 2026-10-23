/**
 * The chat: `runTool`, the one place a model tool call is carried out.
 */
import { agentById, agentForTask } from "./agents";
import { sc, type User } from "./auth";
import { acct } from "./account-id";
import { wsKey } from "./keys";
import { getBrand, isWaiting, listLite, type Task, getTask } from "./brand";
import { DRAFT_TYPES, IMAGE_TYPES, TASK_COST, TASK_TYPES, isDraftType, isTaskType } from "./tasks";
import { countCost, generateBatch, withheldNote } from "./generate-batch";
import { CORE_FILES, FileLimitError, MAX_FILES, readFile, safeName, writeFile } from "./files";
import { fileResult, fileSrc, parseRefRecords, parseSrc, provenanceOf } from "./ref-provenance";
import { refsKey } from "./instructions-store";
import { db } from "./db";
import { importCatalog } from "./catalog";
import { renderImage } from "./media/start";
import { deadlineFor } from "./media/keys";
import { listConnections } from "./connectors/store";
import { connectedTargets, targetsFor } from "./connectors/publish";
import { isDuplicate, publishOnce } from "./publish-once";
import { NO_CREDITS_HINT } from "./topups";
import { bannedTerms, explain, gateTask, normalize, type Violation } from "./brand-rules";
import { DIALECTS, FIELD_MAX, proposeBrandChange, type ProposalField } from "./brand-proposals";
import { byOf } from "./actor";
import { recordActivity } from "./activity";
import { SEC_WRITES_PER_HOUR, fail, isSecTool, runSecretaryTool, toolError, zoneFor } from "./secretary";
import { HANDOFF_TOOL_DEF, runHandoffNote } from "./secretary-handoff";
import { runProposeMeetingTasks } from "./secretary-meeting";
import { endOfZoneDay, formatWhen } from "./secretary-agenda";
import { proposeAway } from "./secretary-away";
import { PROPOSE_REFUSAL, proposeInstruction } from "./instruction-proposals";
import { needsFileCard, proposeFile } from "./file-proposals";
import { CATALOG_IMPORTS_PER_HOUR, WINDOW, allow } from "./rate";
import { MIN_ROLE, can } from "./roles";
import { autoItems, createHandoff, parseProposal, proposalText } from "./handoffs";
import { getGov } from "./governance";
import { authorityOf, capOfTool, offRefusal } from "./tool-authority";
import { entitlements } from "./entitlements";
import { MODEL_UNAVAILABLE_NOTE } from "./models/overrides";
import { isRegulated } from "./regulated";
import { fairUseText } from "./fair-use";
import { publishScopeCheck, readAgentScopeModes } from "./agent-scope";
import { personSawCurrent, taskVersion, type MediaStamped } from "./task-version";
import { CHAT_MAX_DURATION_S, CHAT_RENDER_MIN_MS, cleanName } from "./chat-reply";
import { AWAY_CARDS_PER_REPLY, BRAND_CARDS_PER_REPLY, FILE_CARDS_PER_REPLY, INSTRUCTION_CARDS_PER_REPLY, REEM_ONLY_REFUSAL, TOOL_ACTION, type ToolCtx, batchRefused, capReached, roleGate, scopeOf, spendGate } from "./chat-gates";
import { CHAT_IMAGE_CREDITS, EDITABLE_BRAND_FIELDS, type EditableBrandField, toolsFor } from "./chat-tools";

/** The host of a URL the model or the brand gave, lower case and without a leading "www.", or "" when it is not one. */
export function hostOf(url: string): string {
  try {
    const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.toLowerCase();
    return h.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Rule 2304: may import_catalog fetch `site`? Yes when its host is the brand website's host or a subdomain of it (a
 * store at shop.example.com for example.com), or when the person chatting wrote that host in this turn's own message
 * (`ownerMsg`, the human's text, never a tool result or a crawled page). No to anything else.
 */
export function catalogHostAllowed(site: string, website: string | undefined, ownerMsg: string | undefined): boolean {
  const host = hostOf(site);
  if (!host) return false;
  const own = website ? hostOf(website) : "";
  if (own && (host === own || host.endsWith(`.${own}`))) return true;
  // Whole hosts only: "store.example" is not named by a message that says "mystore.example".
  const named = (ownerMsg ?? "").match(/(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}/gu) ?? [];
  return named.some((n) => hostOf(n) === host);
}

/**
 * Exported for tests: the code-level gates on tools (approval before publishing) must hold without a model in the loop.
 * `deadline` is the chat request's (see chat()); a call outside a chat turn counts as the start of one. `ctx` comes from
 * chat(); without it `by` is read from the session and the talking agent is not known.
 */
export async function runTool(user: User, name: string, input: Record<string, unknown>, actions: string[], made: Task[] = [], deadline = deadlineFor(CHAT_MAX_DURATION_S), ctx: ToolCtx = {}): Promise<string> {
  // The offered-tool check (rule 799, R6), before every other check and write: a tool this agent was not offered in this turn
  // (`toolsFor`: propose_handoff is Majed's, contact_away is Reem's) does not exist for it, whatever the model names. A call with
  // no agent (a test, a caller outside a chat turn) keeps each tool's own answer below.
  // Reem's two read or store tools keep their own refusal text (rules 607 and 919), which says who to ask; it is still
  // answered here, before any read or write.
  if (ctx.agent && !toolsFor(ctx.agent).some((t) => t.name === name)) return Object.hasOwn(REEM_ONLY_REFUSAL, name) ? REEM_ONLY_REFUSAL[name] : "Unknown tool.";
  const email = user.scope ?? acct(user);
  // The role gate comes first: a refused tool reaches no pipeline, write or activity row.
  const needs = Object.prototype.hasOwnProperty.call(TOOL_ACTION, name) ? TOOL_ACTION[name] : null;
  // `todo.write` is held by every login of the account (members too), so for it the refusal is for a chat with no acting login.
  if (needs && !can(user, needs)) return MIN_ROLE[needs] === "member" ? `Not done: ${name} needs a signed-in login of this account with access to its to-do list, and this chat has none. Nothing was changed. Tell the owner plainly and do not try another way around it.` : `Not done: ${name} needs the owner or an admin of this account, and the person chatting is neither. Nothing was changed. Tell them plainly that the account owner or an admin can do this, and do not try another way around it.`;
  // The owner's tool authority (rule 2432, src/lib/tool-authority.ts), after the role gate and before any read, charge or
  // write. Read at the moment of the call, not from the turn's start: a capability switched off mid-turn holds for the
  // next call. Keyed by the talking agent only; a call with no agent (tests, onboarding) keeps each tool's own answer.
  const cap = ctx.agent ? capOfTool(name) : null;
  const authority = cap && ctx.agent ? authorityOf((await getGov(email)).toolPolicy, ctx.agent, cap) : "on";
  if (authority === "off" && ctx.agent) return offRefusal(agentById(ctx.agent).name.en, name);
  const askFirst = { ask: authority === "ask" };
  const who = async () => ctx.by ?? (await byOf(user));
  // Agents' handoff notes (src/lib/secretary-handoff.ts), not Majed's handoffs: the sender is this turn's agent; over MCP
  // the words come from another assistant, so none is left. Tagged `note:`, never `handoff:`: that tag is Majed's
  // proposal (`handoffOf` turns it into the reply's Run card, and propose_handoff allows one per reply).
  if (name === HANDOFF_TOOL_DEF.name) {
    if (ctx.via === "mcp") return "Not done: handoff notes are not available over MCP. Nothing was saved.";
    const r = await runHandoffNote(user, input, { agent: ctx.agent ?? "noor", lang: ctx.lang ?? user.lang });
    if (!r.isError) actions.push(`note:${r.id ?? ""}`);
    return r.text;
  }
  // The secretary's tools: free, no model call, scoped to this user's active brand, and unable to close an item.
  if (isSecTool(name)) {
    // Code gate, not a prompt rule: only Reem's own turn reads open times (no default for a turn whose agent is not known).
    if (name === "free_slots" && ctx.agent !== "reem") return "Not done: only Reem looks up open meeting times. Ask Reem; nothing was read.";
    const r = await runSecretaryTool(user, name, input, { who: { actor: ctx.agent ?? "reem", via: "chat", login: user.actor?.email }, lang: ctx.lang ?? user.lang, ...(ctx.agent ? { agent: ctx.agent } : {}) });
    if (!r.isError && name !== "agenda_get" && name !== "agenda_next" && name !== "free_slots") actions.push(`todo:${name}:${r.id ?? ""}`);
    return r.text;
  }
  switch (name) {
    case "generate_content": {
      // The model chooses this value, and crawled pages and catalogs reach the model: it is request input, not a fact.
      if (!isTaskType(input.type)) return `Unknown type. Valid types: ${TASK_TYPES.join(", ")}.`;
      const type = input.type;
      const wrong = await roleGate(user, ctx, type, String(input.notes ?? ""), actions);
      if (wrong) return wrong;
      const held = await spendGate(user, ctx, actions, { kind: "batch", type, brief: String(input.notes ?? ""), credits: TASK_COST[type], ...(ctx.agent ? { agent: ctx.agent } : {}) }, askFirst);
      if (held) return held;
      const r = await generateBatch(user, email, { type, notes: String(input.notes ?? ""), source: "chat", via: "chat", by: ctx.by, deadline, ...scopeOf(ctx) });
      if (!r.ok) return batchRefused(r, actions, (need, have) => `Insufficient credits: need ${need}, have ${have}. Tell the owner plainly. ${NO_CREDITS_HINT}`);
      const created = r.tasks;
      made.push(...created);
      actions.push(`generated:${type}:${created.length}`);
      const inline = created.length <= 3 ? `\n\nITEM BODIES (show these to the owner in your reply, formatted, since the batch is small):\n${created.map((i, n) => `${n + 1}. [${i.channel}] ${i.title}\n${i.body.slice(0, 1500)}`).join("\n\n")}` : "";
      const waiting = r.gov.autoApprove[type] ? created.filter((t) => t.status === "pending").length : 0;
      // A regulated brand is never auto-approved (rule 1521): every item waits for a person, whatever governance says.
      const regulated = r.gov.autoApprove[type] && created.length > 0 && waiting === created.length && isRegulated(await getBrand(email));
      const auto = !r.gov.autoApprove[type] ? "" : regulated ? " (auto-approve is off for regulated sectors such as health, pharmacy, real estate, law and finance: every item waits for the owner in the inbox)" : waiting ? ` (auto-approve is on, but ${waiting} item(s) broke a brand rule and wait for the owner in the inbox)` : " (auto-approved per governance)";
      return `Created ${created.length} ${type} item(s) in the inbox${auto}. Credits left: ${user.credits}.${withheldNote(r)} Titles: ${created.map((i) => i.title).join(" | ")}${inline}${r.modelRejected ? `\n\n${MODEL_UNAVAILABLE_NOTE}` : ""}`;
    }
    case "draft_items": {
      // The tool schema's enum is not the approval (the model is never the only approval): a type outside DRAFT_TYPES
      // would be charged pro rata for the one item a batch type gives back (rule 250, tests/brand-guardrails.test.ts).
      if (!isDraftType(input.type)) return `Not a draft type. draft_items takes: ${DRAFT_TYPES.join(", ")}; use generate_content for other types. Nothing was created and no credits were used.`;
      const type = input.type;
      const wrong = await roleGate(user, ctx, type, String(input.brief ?? ""), actions);
      if (wrong) return wrong;
      const count = Math.max(1, Math.min(3, Number(input.count) || 1));
      const held = await spendGate(user, ctx, actions, { kind: "draft", type, count, brief: String(input.brief ?? ""), credits: countCost(type, count), ...(ctx.agent ? { agent: ctx.agent } : {}) }, askFirst);
      if (held) return held;
      const r = await generateBatch(user, email, { type, notes: String(input.brief ?? ""), count, source: "chat", via: "chat", by: ctx.by, deadline, ...scopeOf(ctx) });
      if (!r.ok) return batchRefused(r, actions, (need, have) => `Insufficient credits: need ${need}, have ${have}. ${NO_CREDITS_HINT}`);
      const created = r.tasks;
      const cost = r.cost;
      made.push(...created);
      actions.push(`drafted:${type}:${created.length}`);
      return `Drafted ${created.length} ${type} item(s) (${cost} credit${cost > 1 ? "s" : ""}); also in the inbox. Credits left: ${user.credits}.${withheldNote(r)}\n\nITEM BODIES (show these to the owner, formatted and ready to copy):\n${created.map((i, n) => `${n + 1}. [${i.channel}] ${i.title}\n${i.body}`).join("\n\n")}${r.modelRejected ? `\n\n${MODEL_UNAVAILABLE_NOTE}` : ""}`;
    }
    case "update_brand": {
      // Code-level gate, not a prompt rule: no tool call writes the brand file. The model that calls this reads crawled
      // pages, imported catalogs, uploads and MCP clients' text, so every change is a proposal (src/lib/brand-proposals.ts)
      // that only the owner's or an admin's Save applies, under the brand lock, through /api/brand/proposals/{id}.
      const brand = await getBrand(email);
      if (!brand) return "No brand file yet.";
      const field = String(input.field);
      const value = String(input.value).slice(0, 1000);
      // Only these text fields, and only with a string. Arrays (channels, languages) and structures (social) are
      // owner-only, from the brand form; a string written into one of them broke every later generation.
      if (!EDITABLE_BRAND_FIELDS.includes(field as EditableBrandField)) return `Cannot change brand.${field} from chat. Editable fields: ${EDITABLE_BRAND_FIELDS.join(", ")}. Channels, languages and handles are changed by the owner on the Brand page.`;
      const key: ProposalField = field === "banned_remove" ? "banned" : (field as ProposalField);
      const from = String(brand[key] ?? "");
      let to = value.trim();
      let dropped: string[] = [];
      let added: string[] = [];
      if (field === "banned") {
        const have = bannedTerms(from);
        const haveKeys = new Set(have.map(normalize));
        added = bannedTerms(to).filter((t) => !haveKeys.has(normalize(t)));
        if (!bannedTerms(to).length) return "No change: send the words to add. Clearing the banned list is the owner's, on the Brand page.";
        if (!added.length) return "No change: those words are already on the banned list. To take a word out, use banned_remove.";
        to = [from.trim(), added.join(", ")].filter(Boolean).join(", ");
        // The Brand page keeps 400 characters of the list (PUT /api/brand): a longer list would lose words on its next save.
        if (to.length > FIELD_MAX.banned) return "Not saved: the banned list would pass 400 characters, the most the Brand page keeps. Tell the owner to shorten it on the Brand page.";
      } else if (field === "banned_remove") {
        const out = new Set(bannedTerms(to).map(normalize));
        const have = bannedTerms(from);
        dropped = have.filter((t) => out.has(normalize(t)));
        if (!dropped.length) return "No change: none of those words is on the banned list.";
        to = have.filter((t) => !out.has(normalize(t))).join(", ");
      } else if (key === "dialect") {
        if (!(DIALECTS as readonly string[]).includes(to)) return `Not saved: brand.dialect is one of ${DIALECTS.join(", ")}.`;
      } else to = to.slice(0, FIELD_MAX[key]);
      const same = key === "offers" || key === "banned" ? normalize(to) === normalize(from) : to === from.trim();
      if (same) return `No change: brand.${key} already says that.`;
      // One reply shows at most BRAND_CARDS_PER_REPLY cards (turnParts): a further proposal would have no Save button.
      if ((ctx.proposed?.length ?? 0) >= BRAND_CARDS_PER_REPLY) return `Not done: this reply already carries ${BRAND_CARDS_PER_REPLY} brand-change cards, the most one reply shows. Nothing more was proposed; ask the owner to save those first.`;
      // A proposal changes nothing, so it is no brand_changed row: that row is written when the owner applies it
      // (POST /api/brand/proposals/{id}). The proposal records where the turn came from (`via`), and the card warns when
      // it was another assistant over MCP.
      const p = await proposeBrandChange(email, { field: key, from, to, agent: ctx.agent ?? "noor", via: ctx.via === "mcp" ? "mcp" : "chat", ...(dropped.length ? { dropped } : {}), ...(added.length ? { added } : {}) });
      ctx.proposed?.push(p);
      actions.push(`brandprop:${key}`);
      const why = key === "offers" ? "the offers decide which discounts, gifts and deadlines the agents may promise"
        : dropped.length ? `removing ${dropped.map((d) => `"${d}"`).join(", ")} lets those words appear in approved and published items`
        : added.length ? `adding ${added.map((d) => `"${d}"`).join(", ")} to the banned words holds every item that uses them`
        : `brand.${key} is read by every agent in everything they write`;
      const where = ctx.via === "mcp" ? "in the Thakeen app chat" : "under this reply";
      return `Not saved yet: ${why}, so every change to the brand file from a chat waits for the owner's or an admin's Save. It waits as a card with the old and the new value and a Save button ${where} for 7 days. Tell the owner plainly that you proposed the change and that nothing changed until they press Save.`;
    }
    case "read_file": {
      // The on-demand load of a reference (rule 2526): free and read-only (not in TOOL_ACTION, no charge, no write), the
      // workspace is the turn's own, and the text comes back fenced as data with its source and last refresh (`fileResult`).
      const f = await readFile(email, String(input.name ?? ""));
      if (!f) return "File not found.";
      // Only an owner's file stored without `src` can be an older Google import, so only then is the record read.
      const record = !parseSrc(f.src) && f.by === "user" ? parseRefRecords(await db.hgetall<unknown>(refsKey(email)))[f.name] ?? null : null;
      return fileResult(f.name, f.content, provenanceOf(f.name, f, record));
    }
    case "write_file": {
      // Core memory (brand.md, products.md, strategy.md, …) is what every agent reads; overwriting or blanking one is
      // a brand change, gated in code like PUT /api/files, never left to the model's judgement.
      const target = safeName(String(input.name ?? ""));
      // Over MCP the words come from another assistant, which may have read any page: core memory is written in the app.
      if (CORE_FILES.includes(target) && ctx.via === "mcp") return `Not done: ${target} is core memory that every agent reads, and it is not written over MCP. Nothing was changed. Save the text under a different file name, or ask the owner to change it in the app.`;
      if (CORE_FILES.includes(target) && !can(user, "files.core.write")) return `Not done: ${target} is core memory that every agent reads, and writing it needs the owner or an admin of this account; the person chatting is neither. Nothing was changed. Tell them plainly, and offer to save the text under a different file name instead.`;
      // Rule 2306: replacing the text of a core file an agent wrote is a brand change too, and the model may be repeating a
      // crawled page. Code holds it on a card under the reply (src/lib/file-proposals.ts); only the owner's Apply writes it.
      // A new or empty core file is still written at once, and an owner-written one is never replaced (`writeFile`).
      if (CORE_FILES.includes(target)) {
        const content = String(input.content ?? "");
        const existing = await readFile(email, target);
        if (needsFileCard(existing, content)) {
          if ((ctx.fileProposed?.length ?? 0) >= FILE_CARDS_PER_REPLY) return `Not proposed: this reply already carries ${FILE_CARDS_PER_REPLY} core-file cards, the most one reply shows. Nothing was stored; ask the owner to apply or dismiss those first.`;
          const p = await proposeFile(sc(user), existing, content, ctx.agent, await who());
          ctx.fileProposed?.push(p);
          return `Not saved yet: ${target} is core memory that every agent reads, and replacing its text is the owner's call. The new text (${p.content.length} chars) is on a card under this reply for the owner or an admin to apply or dismiss. Tell them so in one line, and do not write it again.`;
        }
      }
      // The workspace has a file ceiling. Tell the agent plainly rather than throwing out of the turn: it can then
      // say so to the owner, or overwrite an existing file, instead of the message failing with nothing shown.
      let f;
      try {
        f = await writeFile(email, String(input.name), String(input.content), "noor", { src: fileSrc("agent") });
      } catch (e) {
        if (e instanceof FileLimitError) return `This workspace already holds ${MAX_FILES} files, the maximum. Ask the owner to delete one from the Files page, or write to a file that already exists.`;
        throw e;
      }
      // The file keeps its author label ("noor", the Files page's two-value "written by"); the log names the talking agent.
      await recordActivity(email, [{ at: f.updatedAt, kind: "file_written", agent: ctx.agent, by: await who(), via: "chat", note: f.name }]);
      actions.push(`file:${f.name}`);
      return `Saved ${f.name} (${f.content.length} chars).`;
    }
    case "publish_item": {
      // Publishing is irreversible. Over MCP the request comes from another assistant, which may have read any page.
      if (ctx.via === "mcp") return "Not published: publishing is done in the Thakeen app, never over MCP. Tell the owner to publish the item from the inbox.";
      const t = await getTask(email, String(input.task_id));
      if (!t) return "Item not found.";
      const connected = connectedTargets(await listConnections(email));
      const provider = String(input.provider);
      if (!targetsFor(t, connected).includes(provider)) return `Cannot publish this ${t.type}/${t.channel} item to ${provider} (not connected or wrong type).`;
      // Code-level gate, not a prompt rule: only items the owner already approved in the inbox can be published from chat.
      // Text from crawled sites, catalogs and files reaches this agent, so the model must never be the only approval.
      if (t.status !== "approved") return "Not published: this item is not approved yet. Tell the owner to approve it in the approvals inbox first, then ask again.";
      // Auto-approval is a setting, not a person: nobody has read an item it approved. Its publish is the owner's click
      // (an owner who already published it from the inbox has reviewed it). Rule 3012: an image or clip that landed after
      // that decision or publish was never seen, even on an item published before (`personSawCurrent`).
      const reviewed = (x: Task) => personSawCurrent(x);
      if (!reviewed(t)) return (t as Task & MediaStamped).mediaAt !== undefined && (t.decidedAt || t.published?.length)
        ? "Not published: a new image or video arrived on this item after the owner last approved or published it, and nobody has seen it yet. Tell the owner to open it in the inbox and publish from there."
        : "Not published: this item was approved automatically and nobody has reviewed it yet. Tell the owner to open it in the inbox and press Publish there.";
      // Approved before a banned word was added to the brand file, or edited since: the rule still holds it. At publish no
      // placeholder of any kind may go out.
      const brandNow = await getBrand(email);
      const held = gateTask(brandNow, t, { publish: true, provider });
      if (held.length) return `Not published. ${explain(held)} Tell the owner what to fix and where; do not work around the rule.`;
      // The agent-scope publish check (rule 1410), last before the send. An owner can edit an approved item and keep it
      // approved, and a render can land meanwhile, so the copy sent under the lock below must still be the version that was
      // checked: title, text and image (`taskVersion`, as the inbox's publish route, rule 3012), or nothing goes out.
      // Enforce holds a refusal and an error.
      const checkedVersion = taskVersion(t);
      const scopeHeld = await publishScopeCheck(user, t, "chat_publish", ctx.lang ?? (t.lang === "en" ? "en" : "ar"), ctx.modes ?? (await readAgentScopeModes()), deadline);
      if (scopeHeld.block) return `Not sent: ${scopeHeld.reply}`;
      // The same checks again on the copy that is sent, under the publish lock.
      const r = await publishOnce(email, t.id, provider, {
        check: (cur) => {
          if (cur.status !== "approved" || !reviewed(cur)) return { error: "not_approved" };
          if (taskVersion(cur) !== checkedVersion) return { error: "changed" };
          const v = gateTask(brandNow, cur, { publish: true, provider });
          return v.length ? { error: "brand_violation", violations: v } : null;
        },
      });
      if (!r.ok) {
        switch (r.error) {
          case "refused": return r.refusal.error === "brand_violation" ? `Not published. ${explain(r.refusal.violations as Violation[])} The item changed a moment ago; tell the owner what to fix.` : r.refusal.error === "changed" ? "Not published: the owner edited this item a moment ago. Ask again to publish the new text." : "Not published: the item changed a moment ago and is not approved by the owner any more. Tell the owner to check it in the inbox.";
          case "already_published": return `Not published again: this item already went to ${provider}${r.url ? ` (${r.url})` : ""}. Publishing it a second time is the owner's, from the inbox.`;
          case "publish_unknown": return `Not published: an earlier publish to ${provider} (${r.at}) ended without an answer, so it may already be live. Tell the owner to check ${provider}, then publish again from the inbox if it is not there.`;
          case "publish_busy": return `Not published: a publish of this item to ${provider} is already running. Wait a few minutes and check the inbox.`;
          case "earlier_live": return `Not published again: ${provider} says this text is already there, so the earlier attempt (${r.at}) went live. It is now recorded on the item; nothing new was posted.`;
          case "not_found": return "Item not found.";
          default: {
            const msg = r.cause instanceof Error ? r.cause.message : "publish_failed";
            if (isDuplicate(msg)) return `Not published: ${provider} refused this text because the same text was already posted there. Nothing went out; the owner can change the wording and publish from the inbox.`;
            throw r.cause instanceof Error ? r.cause : new Error("publish_failed");
          }
        }
      }
      // A real publish only: a refusal, a duplicate or an unknown result above returned before this row. `earlier_live`
      // needs an `again`, which only the inbox sends. The item's owning agent, computed in code, as on the publish route.
      await recordActivity(email, [{ at: r.task.published?.at(-1)?.at ?? new Date().toISOString(), kind: "published", agent: agentForTask(t.type).id, by: await who(), via: "chat", type: t.type, tasks: [t.id], outcome: r.result.provider, note: t.title }]);
      actions.push(`published:${provider}`);
      return `Published to ${provider} as ${r.result.status}: ${r.result.url}`;
    }
    case "propose_handoff": {
      // Code gates, not prompt rules. Only Majed leads: any other talking agent, or a turn whose agent is not known, is
      // refused even though the tool is never offered to it. A connected app never proposes (MCP chat is Noor's, and
      // the token's turns are refused here too). One proposal per reply, so the reply has one card.
      if (ctx.agent !== "majed") return "Not done: only Majed, the lead, proposes handoffs. Nothing was saved.";
      if (ctx.via === "mcp" || ctx.by?.kind === "token" || user.actor?.kind === "token") return "Not done: handoffs are proposed only in the app's chat. Nothing was saved.";
      if (actions.some((a) => a.startsWith("handoff:"))) return "Not done: this reply already proposed a handoff, and one reply carries one card. Put every item in that one proposal next time. Nothing more was saved.";
      const p = parseProposal(input);
      if (!p.ok) return p.error;
      const [h, gov] = await Promise.all([createHandoff(email, { proposal: p.proposal, requestedBy: await who(), origin: "web_chat", conv: ctx.conv, ownerMsg: ctx.ownerMsg ?? "" }), getGov(email)]);
      actions.push(`handoff:${h.id}`);
      // Which items Majed's auto-run may start (off by default), so the reply never says "nothing runs until Run" untruly.
      // Asked for the reply that will carry the card: the proposal is marked shown once that reply is saved (deliver).
      return proposalText(h, user.credits, autoItems(h, gov, Date.now(), { beforeCard: true }));
    }
    case "propose_instruction": {
      // Code gates, not prompt rules (rule 953): the tool stores a proposal and nothing else, and only a login of the account
      // pressing Apply on the card (POST /api/instructions/proposals/{id}, `instructions.write`) puts it in the instructions.
      // Never over MCP or for a token: what another assistant says is not the owner's standing rule.
      if (ctx.via === "mcp" || ctx.by?.kind === "token" || user.actor?.kind === "token") return "Not done: an instruction is proposed only in the app's chat. Nothing was stored.";
      if ((ctx.instructionProposed?.length ?? 0) >= INSTRUCTION_CARDS_PER_REPLY) return `Not proposed: this reply already carries ${INSTRUCTION_CARDS_PER_REPLY} instruction cards, the most one reply shows. Nothing more was stored; ask the owner to apply or dismiss those first.`;
      // The scope is the chat's own; nothing in the input names one.
      const r = await proposeInstruction(email, { text: typeof input.text === "string" ? input.text : "", agents: input.agents }, await who(), entitlements(user).instructions);
      if (!r.ok) return PROPOSE_REFUSAL[r.error];
      ctx.instructionProposed?.push(r.p);
      actions.push(`instrprop:${r.p.id}`);
      const target = r.p.agents === "all" ? "every agent" : r.p.agents.map((a) => agentById(a).name.en).join(", ");
      const widened = r.widened ? " The owner asked for specific agents, but per-agent instructions are not on this plan, so it applies to every agent; say so plainly." : "";
      return `Not applied yet: the rule is saved as a proposal for ${target}, and it waits as a card under your reply ("Add to your agent instructions") for 7 days.${widened} Tell the owner plainly that you proposed it and that it joins the agents' instructions only when the owner or an admin presses Apply.`;
    }
    case "contact_away": {
      // Code gates, not prompt rules (spec §3.2), as for propose_handoff: only Reem's own turn proposes an absence, with no
      // default for a turn whose agent is not known; never over MCP or for a token. It is never offered to anyone else.
      if (ctx.agent !== "reem") return "Not done: only Reem proposes that a contact is away. Nothing was saved.";
      if (ctx.via === "mcp" || ctx.by?.kind === "token" || user.actor?.kind === "token") return "Not done: an absence is proposed only in the app's chat with Reem. Nothing was saved.";
      if ((ctx.awayProposed?.length ?? 0) >= AWAY_CARDS_PER_REPLY) return `Not done: one reply carries at most ${AWAY_CARDS_PER_REPLY} away cards. Nothing more was saved.`;
      if (!(await allow(`sec:write:${user.email}`, SEC_WRITES_PER_HOUR, 3600))) return toolError(fail("too_many", 429));
      const now = Date.now();
      const zone = await zoneFor(email);
      const r = await proposeAway(email, { name: input.name, until: input.until, clear: input.clear }, now, zone);
      if (!r.ok) {
        if (r.error === "not_found") return `Not done: ${JSON.stringify(cleanName(input.name))} is not on the away list, so there is no absence to end. Nothing was saved.`;
        if (r.error === "nothing_to_change") return `Not done: ${JSON.stringify(cleanName(input.name))}'s absence has already ended. Nothing was saved.`;
        return toolError(r);
      }
      const p = r.p;
      ctx.awayProposed?.push(p);
      actions.push(`awayprop:${p.id}`);
      const name = JSON.stringify(p.label);
      const what = p.until
        ? `mark ${name} away until ${formatWhen(new Date(endOfZoneDay(p.until, zone)).toISOString(), true, ctx.lang ?? user.lang, now, zone)} (${p.until}, the last day away; chased again from the next working day)`
        : `end ${name}'s absence now (chased again as usual)`;
      const items = `${p.openItems} open item${p.openItems === 1 ? "" : "s"} owed by them`;
      const match = p.contact
        ? `${items}, listed as ${JSON.stringify(p.contact)}`
        : `${items}: no open item is owed by that name, so check the spelling with the owner`;
      return `Proposed, not saved: ${what}; ${match}. It waits as a card under your reply for 7 days: say plainly that nothing changes until the owner presses Save on the card.`;
    }
    case "propose_meeting_tasks": {
      // Code gates, not prompt rules (rule 607), as for contact_away: only Reem's own turn in the app proposes a meeting's tasks,
      // with no default for a turn whose agent is not known; never over MCP or for a token. It is never offered to anyone else.
      if (ctx.agent !== "reem") return "Not done: only Reem proposes a meeting's follow-up tasks. Nothing was stored.";
      if (ctx.via === "mcp" || ctx.by?.kind === "token" || user.actor?.kind === "token") return "Not done: a meeting's tasks are proposed only in the app's chat with Reem. Nothing was stored.";
      const r = await runProposeMeetingTasks(user, input);
      if (!r.isError) actions.push(`meetprop:${r.id ?? ""}`);
      return r.text;
    }
    case "list_inbox": {
      const tasks = await listLite(email, new Date(Date.now() - 90 * 864e5));
      const c = (s: string) => tasks.filter((t) => t.status === s).length;
      // "Not now" (rule 2340) is counted apart: those items are not waiting for the owner until brought back.
      const waiting = tasks.filter(isWaiting).length;
      return `Inbox: ${waiting} pending, ${c("pending") - waiting} set aside under Not now, ${c("approved")} approved, ${c("rejected")} rejected. Latest: ${tasks.slice(0, 8).map((t) => `[id=${t.id}] ${t.type}/${t.channel}: ${t.title} [${t.status === "pending" && t.notNow ? "not now" : t.status}]${t.image ? " (has image)" : ""}${t.video ? " (has video)" : ""}`).join("; ")}`;
    }
    case "import_catalog": {
      // It rewrites products.md, core memory every agent reads, from a URL the model chose: in the app only.
      if (ctx.via === "mcp") return "Not done: import_catalog rewrites products.md, core memory that every agent reads, and it is not run over MCP. Nothing was changed. Ask the owner to import the catalog in the app.";
      const brand = await getBrand(email);
      const site = String(input.url ?? "") || brand?.website;
      if (!site) return "No store URL known. Ask the owner for it.";
      // Rule 2304: the model picks the URL, and crawled pages, catalogs, uploads and teammates' notes reach the model, so a
      // planted link could fill products.md with someone else's catalog. Code decides: the brand's own site (or a subdomain
      // of it), or a host the person chatting typed in this turn's own message.
      if (!catalogHostAllowed(site, brand?.website, ctx.ownerMsg)) return `Not done: ${hostOf(site) || "that address"} is not this brand's website${brand?.website ? ` (${hostOf(brand.website)})` : ""}, and the person chatting did not name it in their message. Nothing was imported. Ask them to send the store link themselves in the chat, or to set the website on the Brand page.`;
      // The Files page's and the store import's six an hour per workspace, one bucket (rule 2249).
      if (!(await allow(wsKey.catalogImportBucket(sc(user)), CATALOG_IMPORTS_PER_HOUR, WINDOW.hour))) return "Not done: this workspace already imported products six times in the last hour. Nothing was changed. Tell the owner to try again later.";
      const r = await importCatalog(email, site);
      actions.push(`catalog:${r.count}`);
      return r.count ? `Imported ${r.count} products into products.md. Examples: ${r.products.slice(0, 5).map((p) => `${p.title}${p.price ? " (" + p.price + ")" : ""}`).join("; ")}` : "Could not find product pages (no sitemap or unusual URLs). Ask the owner for 3-5 product links or a product list.";
    }
    case "generate_image": {
      const [brand, t] = await Promise.all([getBrand(email), getTask(email, String(input.task_id))]);
      if (!brand || !t) return "Item not found.";
      if (!IMAGE_TYPES.includes(t.type)) return `Images are only for these item types: ${IMAGE_TYPES.join(", ")}.`;
      const held = await spendGate(user, ctx, actions, { kind: "image", type: t.type, taskId: t.id, title: t.title.slice(0, 120), brief: "", credits: CHAT_IMAGE_CREDITS, ...(ctx.agent ? { agent: ctx.agent } : {}) }, askFirst);
      if (held) return held;
      // The default model only (spec A2): the model never chooses how much of the owner's money a render costs. The
      // engine charges before the render, to the agent that owns the item and under the owner's monthly cap for that
      // agent, and refunds exactly once when it fails. It works to the chat request's own deadline (spec A23), so a
      // render started late in a long turn is never budgeted past the platform's kill.
      if (deadline - Date.now() < CHAT_RENDER_MIN_MS) return `Not started: this reply has run too long to draw "${t.title}" now. No credit was used. Tell the owner to ask again, or to press the image button on the item in the inbox.`;
      const r = await renderImage(user, t, brand, undefined, { deadline, by: await who(), from: "chat" });
      if ("placeholder" in r) {
        actions.push(`image:${t.id}`);
        // "Not available right now", not "not configured": the breaker may have switched the default model off for a while.
        return `The image service is not available right now, so "${t.title}" has a placeholder rather than artwork. No credit was used. Ask again later.`;
      }
      if (!r.ok) {
        // `credits` comes back only with a refund. Without one the reply never says the credit was returned: a charge
        // whose refund failed stays on its job, which the next poll or sweep ends and refunds.
        const back = r.credits != null;
        if (r.credits != null) user.credits = r.credits;
        switch (r.error) {
          case "trial_over": actions.push("limit:trial"); return "Trial ended. Owner must subscribe from the Subscription page.";
          case "fair_use": actions.push("limit:fair_use"); return fairUseText();
          case "no_credits": actions.push("limit:credits"); return `Insufficient credits for an image. ${NO_CREDITS_HINT}`;
          case "agent_cap": actions.push("limit:agent_cap"); return capReached({ agent: r.agent ?? agentForTask(t.type).id, spent: r.spent ?? 0, cap: r.cap ?? 0 });
          case "wrong_type": return `Images are only for these item types: ${IMAGE_TYPES.join(", ")}.`;
          case "in_progress": return "An image for this item is already being drawn.";
          case "busy": case "one_open": return "The image service is busy; try again in a minute. No credit was used.";
          case "too_many": return "The image limit for this account was reached (30 an hour, 150 a day). No credit was used.";
          // The item already has artwork, and a placeholder is never drawn over it (src/lib/media/start.ts).
          case "model_unavailable": return `No image model is available right now, so "${t.title}" keeps its current image. No credit was used. Ask again later.`;
          case "nsfw": return `The image service refused this request under its content rules${back ? "; the credit was returned" : ""}.`;
          default: return back
            ? "The image could not be generated; the credit was returned."
            : "The image could not be generated. If a credit was taken for it, it is returned on its own within a few minutes; the owner can try again from the inbox.";
        }
      }
      user.credits = r.credits;
      actions.push(`image:${t.id}`);
      if (r.job.state !== "done") return `The image for "${t.title}" is being drawn and will appear in the inbox shortly. Credits left: ${user.credits}.`;
      return `Image generated for "${t.title}" (${r.job.provider}). It's attached to the item in the inbox. Credits left: ${user.credits}.`;
    }
    default:
      return "Unknown tool.";
  }
}
