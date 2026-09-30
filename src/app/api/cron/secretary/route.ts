import { NextResponse, after } from "next/server";
import { allow, clientIp, sameSecret } from "@/lib/rate";
import { verifyQstash } from "@/lib/qstash";
import { sweepReminders } from "@/lib/secretary-remind";
import { zonesDue } from "@/lib/secretary-evening";

export const maxDuration = 60;

/** Calls per IP a minute. QStash calls once every 15 minutes; this only bounds what an unsigned caller can cost. */
const PER_IP_PER_MINUTE = 60;

/**
 * Reem's tick: every 15 minutes from an Upstash QStash schedule (the Vercel project is on Hobby, whose crons run once a
 * day). It fires the reminders whose time has come (`sweepReminders`) and, when a zone's evening wrap time has just
 * passed, starts the wrap for that zone's workspaces (`/api/cron/evening?zones=…`, with the cron bearer). Answers
 * counts only.
 *
 * Who may call: QStash, proven by the `Upstash-Signature` JWT over the raw body (src/lib/qstash.ts: the current or next
 * signing key, issuer, destination, validity window, body hash); or the CRON_SECRET bearer, compared with `sameSecret`,
 * for manual runs. Anything else is 401 and nothing runs. Rate limited per IP before any check.
 */
export async function POST(req: Request) {
  if (!(await allow(`cronsec:${clientIp(req)}`, PER_IP_PER_MINUTE, 60))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const raw = await req.text();
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const byBearer = sameSecret(bearer, process.env.CRON_SECRET);
  const byQstash = !byBearer && verifyQstash(req.headers.get("upstash-signature"), raw, { path: "/api/cron/secretary" });
  if (!byBearer && !byQstash) return NextResponse.json({ ok: false }, { status: 401 });
  const now = Date.now();
  const sweep = await sweepReminders(now, { fromQstash: byQstash });
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
