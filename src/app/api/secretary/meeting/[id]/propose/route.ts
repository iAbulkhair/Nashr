import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { modelState } from "@/lib/model";
import { allow } from "@/lib/rate";
import { SEC_WRITES_PER_HOUR } from "@/lib/secretary";
import { MEET_PROPOSE_MAX_DURATION_S, liveBooking, proposeFromText } from "@/lib/secretary-meeting";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = MEET_PROPOSE_MAX_DURATION_S;

/**
 * Tasks proposed for a meeting from the owner's typed notes or a pasted transcript (Reem phase 3 B2b,
 * `proposeFromText` in src/lib/secretary-meeting.ts). Body `{ kind: "notes" | "transcript", text }`: notes up to 4,000
 * characters (free, 20 a day), a transcript up to 40,000 (one credit, charged before the model and refunded when it fails,
 * finds no task or the set cannot be saved). `todo.write`, any signed-in member; authenticates first; the id is
 * format-checked and must be a live `booking` item of the caller's active brand (`sc(u)`), else the same 404 for every id,
 * before the body is read; a body over 256 KB is refused unread. The account and the scope are the session's, never the
 * body's. 200 `{ ok, proposals }` (each `{ ref, title, agent, dueAt? }`, stored as the item's pending set, replacing any);
 * it creates nothing, `POST .../approve` alone does. Refusals `{ ok: false, error }`: 400 `bad_request`, 402 `no_credits`,
 * 402 `trial_over`, 402 `agent_cap` with `{ agent, spent, cap }` (the owner's monthly cap for Reem, as `/api/generate`), 413 `too_long`, 422 `no_tasks`, 429 `too_many`, 502
 * `model_failed`, 503 `busy` / `lock_timeout` / `model_paused`. The text is never stored or logged. `sec:write:{email}`,
 * like the other Reem writes.
 */
const MAX_BODY = 256_000;
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const STATUS: Record<string, number> = { bad_request: 400, no_credits: 402, trial_over: 402, agent_cap: 402, too_long: 413, no_tasks: 422, too_many: 429, model_failed: 502, busy: 503, lock_timeout: 503, not_found: 404 };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const { id } = await ctx.params;
  const scope = sc(u);
  if (!(await liveBooking(scope, id))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (Number(req.headers.get("content-length")) > MAX_BODY) return NextResponse.json({ ok: false, error: "too_long" }, { status: 413 });
  // Claude paused: refused before a credit moves, like the other model routes (rule 76).
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ ok: false, error: "too_long" }, { status: 413 });
  let b: unknown = null;
  try { b = JSON.parse(raw); } catch { /* a body that is not JSON is a bad request below */ }
  const { kind, text } = b && typeof b === "object" && !Array.isArray(b) ? (b as { kind?: unknown; text?: unknown }) : {};
  if ((kind !== "notes" && kind !== "transcript") || typeof text !== "string") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const r = await proposeFromText(u, id, kind, text, u.lang, { deadline });
  // As /api/generate: `agent_cap` names the agent and what it spent of the owner's cap, so the app raises the same dialog.
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.error === "agent_cap" ? { agent: r.agent, spent: r.spent, cap: r.cap } : {}) }, { status: STATUS[r.error] ?? 400 });
  return NextResponse.json({ ok: true, proposals: r.proposals.map((p) => ({ ref: p.ref, title: p.title, agent: p.agent, ...(p.dueAt ? { dueAt: p.dueAt } : {}) })) }, { headers: { "cache-control": "no-store" } });
}
