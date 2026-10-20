import { randomBytes } from "node:crypto";
import { db } from "./db";
import { globalKey } from "./keys";
import { cronStatuses, type CronStatus } from "./cron-heartbeat";
import { EVENTS, day, type Event } from "./track";
import { MARGIN_LAST_KEY, type MarginRun } from "./margin";
import { sameSecret } from "./secret";
import { log } from "./log";

/**
 * The Thakeen ops agent's side of the app (rules 2380-2389, docs/system/flows.md section 99). The agent itself runs on
 * Claude Managed Agents (agents/thakeen-ops/): it reads, reports and proposes, and never acts. Three routes serve it:
 *
 * - GET /api/ops/summary: counts only (health, crons, today's and yesterday's event counters, the margin run, the
 *   number of accounts, the build). No email, no name, no workspace, no key name.
 * - POST /api/ops/telegram: the relay. Telegram puts the bot token in the URL path, where the agent's vault cannot put a
 *   secret, so the agent posts here with its own header token and this sends the message to the founder's chat. The chat
 *   is `TELEGRAM_CHAT_ID`, never one from the request. A message may carry one proposal; the buttons under it are
 *   built here, never by the agent.
 * - POST /api/ops/telegram/callback: Telegram's webhook for a button press. It runs only when Telegram's secret header
 *   matches, only for the founder's own chat, and only an action on `OPS_ACTIONS` (phase 1: open a GitHub issue). The
 *   proposal is taken with GETDEL, so one press runs it once.
 *
 * The model is never the only approval: the action list, the founder check and the single use are in this file, and
 * what runs is exactly what the founder read in the message (title and body are shown in full before the buttons).
 * The agent's text is untrusted (it may quote a crawled page): it goes to Telegram as plain text, no parse mode, no
 * link previews, and into the issue as its body only.
 */

/** The bearer token the agent sends to both of its routes, compared with `sameSecret`. Unset: every call is 401. */
export function opsAuthorized(req: Request): boolean {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return sameSecret(bearer, process.env.OPS_AGENT_TOKEN);
}

/** Telegram's webhook secret header (set with `setWebhook secret_token`), compared with `sameSecret`. Unset: 401. */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export function telegramAuthorized(req: Request): boolean {
  return sameSecret(req.headers.get(TELEGRAM_SECRET_HEADER), process.env.TELEGRAM_WEBHOOK_SECRET);
}

// ---------- the summary ----------

export type EventCounts = Record<Event, number>;
export type OpsSummary = {
  ok: boolean;
  at: string;
  release: { commit: string; built: string };
  store: { ok: boolean };
  crons: { stale: string[]; waiting: string[]; jobs: CronStatus[] };
  events: { today: { day: string; counts: EventCounts }; yesterday: { day: string; counts: EventCounts } };
  accounts: number | null;
  margin: MarginRun | null;
};

const count = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const zeroCounts = (): EventCounts => Object.fromEntries(EVENTS.map((e) => [e, 0])) as EventCounts;

/**
 * The summary in three Redis requests sent together: one MGET (both days' counters and the margin run), the heartbeat
 * MGET (`cronStatuses`) and one SCARD pipeline. A store that fails answers `store.ok: false` with zero counts.
 */
export async function opsSummary(now = new Date()): Promise<OpsSummary> {
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86_400_000));
  const keys = [...EVENTS.map((e) => globalKey.eventDay(today, e)), ...EVENTS.map((e) => globalKey.eventDay(yesterday, e)), MARGIN_LAST_KEY];
  const [values, jobs, sizes] = await Promise.allSettled([db.mget<unknown>(keys), cronStatuses(now.getTime()), db.scardMany([globalKey.usersAll()])]);
  const v = values.status === "fulfilled" ? values.value : null;
  const counts = (offset: number) => {
    const out = zeroCounts();
    if (v) EVENTS.forEach((e, i) => { out[e] = count(v[offset + i]); });
    return out;
  };
  const marginRaw = v ? v[keys.length - 1] : null;
  const margin = marginRaw && typeof marginRaw === "object" ? (marginRaw as MarginRun) : null;
  const cronList = jobs.status === "fulfilled" ? jobs.value : [];
  const stale = cronList.filter((j) => j.status === "stale").map((j) => j.job);
  const waiting = cronList.filter((j) => j.status === "waiting").map((j) => j.job);
  const storeOk = values.status === "fulfilled" && jobs.status === "fulfilled";
  return {
    ok: storeOk && stale.length === 0,
    at: now.toISOString(),
    release: { commit: process.env.BUILD_COMMIT ?? "unknown", built: process.env.BUILD_TIME ?? "unknown" },
    store: { ok: storeOk },
    crons: { stale, waiting, jobs: cronList },
    events: { today: { day: today, counts: counts(0) }, yesterday: { day: yesterday, counts: counts(EVENTS.length) } },
    accounts: sizes.status === "fulfilled" ? count(sizes.value[0]) : null,
    margin: margin ? { day: String(margin.day), at: String(margin.at), month: String(margin.month), checked: count(margin.checked), under: count(margin.under), alerted: count(margin.alerted) } : null,
  };
}

// ---------- the relay ----------

/** Telegram allows 4096 characters a message; the whole message, proposal included, stays under this. */
export const TELEGRAM_TEXT_MAX = 4000;
export const PROPOSAL_TITLE_MAX = 120;
export const PROPOSAL_BODY_MAX = 2500;
/** A proposal waits this long for the founder's press, then is gone. */
export const PROPOSAL_TTL_S = 3 * 86400;
/** The only actions a press can run. Phase 1: one. */
export const OPS_ACTIONS = ["github_issue"] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];
/** The repository issues go to: fixed here, never from the agent or the request. */
export const OPS_GITHUB_REPO = "iAbulkhair/Nashr";
/** Callback data: `ok:` or `no:` then the proposal id (24 hex characters). Anything else is ignored. */
export const CALLBACK_SHAPE = /^(ok|no):([a-f0-9]{24})$/;
/** An alert's key (`cron:media`, `ci:main`): the same key is sent at most once per `ALERT_REPEAT_S`. */
export const ALERT_KEY_SHAPE = /^[a-z0-9:_-]{1,60}$/;
export const ALERT_REPEAT_S = 12 * 3600;

export type OpsProposal = { action: OpsAction; title: string; body: string; createdAt: string };
export type RelayInput = { text: string; proposal: { title: string; body: string } | null; alertKey?: string | null };

/** Control characters other than newline and tab are dropped. */
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();

/** Pure: the relay body checked, or the reason it is refused. */
export function parseRelay(body: unknown): RelayInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "bad_body" };
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string" || !clean(b.text)) return { error: "no_text" };
  const text = clean(b.text);
  let alertKey: string | null = null;
  if (b.alert_key !== undefined && b.alert_key !== null) {
    if (typeof b.alert_key !== "string" || !ALERT_KEY_SHAPE.test(b.alert_key)) return { error: "bad_alert_key" };
    alertKey = b.alert_key;
  }
  let proposal: RelayInput["proposal"] = null;
  if (b.proposal !== undefined && b.proposal !== null) {
    const p = b.proposal as Record<string, unknown>;
    if (typeof p !== "object" || p.action !== "github_issue") return { error: "bad_action" };
    if (typeof p.title !== "string" || typeof p.body !== "string") return { error: "bad_proposal" };
    const title = clean(p.title).replace(/\s+/g, " ");
    const pbody = clean(p.body);
    if (!title || title.length > PROPOSAL_TITLE_MAX) return { error: "bad_title" };
    if (!pbody || pbody.length > PROPOSAL_BODY_MAX) return { error: "bad_proposal_body" };
    proposal = { title, body: pbody };
  }
  if (messageText({ text, proposal }).length > TELEGRAM_TEXT_MAX) return { error: "too_long" };
  return { text, proposal, alertKey };
}

/** Pure: the message the founder reads. With a proposal, its whole title and body come before the buttons. */
export function messageText(input: RelayInput): string {
  if (!input.proposal) return input.text;
  return `${input.text}\n\nاقتراح: فتح مشكلة في GitHub\nالعنوان: ${input.proposal.title}\n\n${input.proposal.body}\n\nلا يُنفَّذ شيء إلا بضغطك «موافق».`;
}

/** Pure: the two buttons for proposal `id`. */
export const proposalButtons = (id: string) => ({
  inline_keyboard: [[{ text: "موافق", callback_data: "ok:" + id }, { text: "رفض", callback_data: "no:" + id }]],
});

const TELEGRAM_TIMEOUT_MS = 8000;

/** One Bot API call. The token sits in the URL path, so the URL is never logged; a failure logs the method only. */
async function telegram(method: string, payload: Record<string, unknown>): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) log.warn("ops_telegram_refused", { method, status: res.status });
    return res.ok;
  } catch (e) {
    log.warn("ops_telegram_failed", { method, error: e });
    return false;
  }
}

/** The founder's chat, from the environment only. */
const founderChat = () => (process.env.TELEGRAM_CHAT_ID ?? "").trim();

/**
 * Sends `input` to the founder's chat. An alert with a key is sent only when the key's marker is free (`setNx`,
 * `ALERT_REPEAT_S`): a check every three hours tells the founder about one problem twice a day at most, and the marker
 * is freed again when the send fails. A proposal is stored first under a fresh random id (`PROPOSAL_TTL_S`) and the
 * message carries its two buttons; if the send fails the stored proposal is removed again.
 */
export async function relay(input: RelayInput, now = new Date()): Promise<{ sent: boolean; skipped?: true; proposal?: string }> {
  const chat = founderChat();
  if (!chat || !process.env.TELEGRAM_BOT_TOKEN) return { sent: false };
  const alert = input.alertKey ? globalKey.opsAlert(input.alertKey) : null;
  if (alert && !(await db.setNx(alert, now.toISOString(), ALERT_REPEAT_S))) return { sent: false, skipped: true };
  const out = await send(input, chat, now);
  if (!out.sent && alert) await db.del(alert).catch(() => {});
  return out;
}

async function send(input: RelayInput, chat: string, now: Date): Promise<{ sent: boolean; proposal?: string }> {
  const payload: Record<string, unknown> = { chat_id: chat, text: messageText(input), link_preview_options: { is_disabled: true } };
  if (!input.proposal) return { sent: await telegram("sendMessage", payload) };
  const id = randomBytes(12).toString("hex");
  const stored: OpsProposal = { action: "github_issue", ...input.proposal, createdAt: now.toISOString() };
  await db.set(globalKey.opsProposal(id), stored, PROPOSAL_TTL_S);
  const sent = await telegram("sendMessage", { ...payload, reply_markup: proposalButtons(id) });
  if (!sent) await db.del(globalKey.opsProposal(id)).catch(() => {});
  return sent ? { sent, proposal: id } : { sent };
}

// ---------- the press ----------

const GITHUB_TIMEOUT_MS = 10_000;

/** Opens the issue with `OPS_GITHUB_TOKEN` (fine-grained: Issues read and write on `OPS_GITHUB_REPO` only). */
export async function openIssue(p: OpsProposal, approvedAt: Date): Promise<string | null> {
  const token = process.env.OPS_GITHUB_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${OPS_GITHUB_REPO}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: JSON.stringify({ title: `[ops] ${p.title}`, body: `${p.body}\n\n---\nاقترحه وكيل التشغيل في ${p.createdAt}، ووافق عليه المؤسس على تيليجرام في ${approvedAt.toISOString()}.` }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      log.warn("ops_issue_refused", { status: res.status });
      return null;
    }
    const json = (await res.json().catch(() => null)) as { html_url?: unknown } | null;
    return typeof json?.html_url === "string" ? json.html_url : "";
  } catch (e) {
    log.warn("ops_issue_failed", { error: e });
    return null;
  }
}

type CallbackQuery = { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { message_id?: unknown; chat?: { id?: unknown }; text?: unknown } };
export type PressResult = "ignored" | "not_founder" | "expired" | "rejected" | "opened" | "failed";

/**
 * One Telegram update. Only a `callback_query` from the founder's chat (both the presser and the chat are
 * `TELEGRAM_CHAT_ID`) with callback data of `CALLBACK_SHAPE` does anything. The proposal is taken with GETDEL whatever
 * the button, so a second press, a replay or a press after `PROPOSAL_TTL_S` finds nothing. The answer and the edited
 * message tell the founder what happened; the buttons are removed.
 */
export async function handlePress(update: unknown, now = new Date()): Promise<PressResult> {
  const q = (update as { callback_query?: CallbackQuery } | null)?.callback_query;
  if (!q || typeof q.data !== "string") return "ignored";
  const chat = founderChat();
  const answer = (text: string) => telegram("answerCallbackQuery", { callback_query_id: String(q.id ?? ""), text });
  if (!chat || String(q.from?.id ?? "") !== chat || String(q.message?.chat?.id ?? "") !== chat) {
    await answer("غير مسموح.");
    return "not_founder";
  }
  const m = CALLBACK_SHAPE.exec(q.data);
  if (!m) return "ignored";
  const [, choice, id] = m;
  const p = await db.getdel<OpsProposal>(globalKey.opsProposal(id));
  let result: PressResult;
  let note: string;
  if (!p || !OPS_ACTIONS.includes(p.action)) {
    result = "expired";
    note = "انتهى هذا الاقتراح أو نُفّذ من قبل. لم يتغيّر شيء.";
  } else if (choice === "no") {
    result = "rejected";
    note = "رُفض. لم يتغيّر شيء.";
  } else {
    const url = await openIssue(p, now);
    result = url === null ? "failed" : "opened";
    note = url === null ? "تعذّر فتح المشكلة في GitHub. لم يتغيّر شيء، اطلب من الوكيل يعيد الاقتراح." : `فُتحت المشكلة: ${url}`;
  }
  const original = typeof q.message?.text === "string" ? q.message.text : "";
  await Promise.all([
    answer(note.slice(0, 190)),
    telegram("editMessageText", {
      chat_id: chat,
      message_id: q.message?.message_id,
      text: `${original}\n\n${note}`.slice(0, 4096),
      link_preview_options: { is_disabled: true },
    }),
  ]);
  return result;
}
