import { NextResponse, after } from "next/server";
import { allow, clientIp, sameSecret } from "@/lib/rate";
import { verifyQstash } from "@/lib/qstash";
import { SWEEP_BUDGET_TICK_MS, sweepReminders } from "@/lib/secretary-remind";
import { zonesDue } from "@/lib/secretary-evening";

export const maxDuration = 60;

/** Failed calls per IP a minute. QStash calls once every 15 minutes; this only bounds what an unsigned caller can cost. */
const PER_IP_PER_MINUTE = 60;
/** QStash's body is empty or tiny, and its signature a few hundred characters: anything far bigger is refused unread. */
const TICK_BODY_MAX = 64 * 1024;
const TICK_SIGNATURE_MAX = 4096;

/** The raw body, or null past `max` bytes: refused by its declared length, else by counting while reading. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reem's tick: every 15 minutes from an Upstash QStash schedule (the Vercel project is on Hobby, whose crons run once a
 * day). It fires the reminders whose time has come (`sweepReminders`, which starts nothing new after
 * `SWEEP_BUDGET_TICK_MS`) and, when a zone's evening wrap time has just passed, starts the wrap for that zone's
 * workspaces (`/api/cron/evening?zones=…`, with the cron bearer; only when CRON_SECRET is set). Answers counts only.
 *
 * Who may call: QStash, proven by the `Upstash-Signature` JWT over the raw body (src/lib/qstash.ts: the current or next
 * signing key, issuer, destination, validity window, body hash); or the CRON_SECRET bearer, compared with `sameSecret`,
 * for manual runs. Oversized input is refused first, unread (413 for a body over 64 KB, 401 for a signature header over
 * 4096 characters). Anything unauthenticated is 401 and nothing runs; only those failed calls count against the per-IP
 * limit (429 past it), so strangers sharing QStash's egress addresses can never fill the bucket the real tick uses.
 */
export async function POST(req: Request) {
  const sig = req.headers.get("upstash-signature");
  if (sig && sig.length > TICK_SIGNATURE_MAX) return NextResponse.json({ ok: false }, { status: 401 });
  const raw = await readCapped(req, TICK_BODY_MAX);
  if (raw === null) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const byBearer = sameSecret(bearer, process.env.CRON_SECRET);
  const byQstash = !byBearer && verifyQstash(sig, raw, { path: "/api/cron/secretary" });
  if (!byBearer && !byQstash) {
    if (!(await allow(`cronsec:${clientIp(req)}`, PER_IP_PER_MINUTE, 60))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const now = Date.now();
  const sweep = await sweepReminders(now, { fromQstash: byQstash, deadline: now + SWEEP_BUDGET_TICK_MS });
  // The evening pass: the zones whose wrap time (18:00, or 21:30 in Ramadan) fell within the last tick. The batch runs
  // in its own invocation with the cron bearer, so it has the daily job's time budget and its resumable markers.
  const zones = zonesDue(now);
  const secret = process.env.CRON_SECRET;
  if (zones.length && secret) {
    const url = new URL(`/api/cron/evening?zones=${encodeURIComponent(zones.join(","))}`, req.url).toString();
    const kick = () => fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) }).then(() => undefined, () => undefined);
    try { after(kick); } catch { void kick(); }
  }
  return NextResponse.json({ ok: true, via: byQstash ? "qstash" : "bearer", ...sweep, evening: zones.length && secret ? zones.length : 0 });
}
