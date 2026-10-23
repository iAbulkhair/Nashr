import { NextResponse } from "next/server";
import { globalKey } from "@/lib/keys";
import { unsubscribe } from "@/lib/newsletter";
import { allow, clientIp, retryLater } from "@/lib/rate";

/** Confirm and unsubscribe posts per IP per 15 minutes. */
const TRIES_PER_IP = 30;

/**
 * POST {token} → unsubscribes the address the link in a newsletter mail belongs to (rules 3600-3609). No login: the
 * token is the credential, 64 hex from the link fragment, stored only as its SHA-256. Idempotent: a second post answers
 * `{ ok: true }` again, and the record stays as the suppression list. A token this list never minted, or one older than
 * 400 days, is 400 `bad_token`. The answer never names the address. Rate limited per IP.
 */
export async function POST(req: Request) {
  if (!(await allow(globalKey.newsletterTokenBucket(clientIp(req)), TRIES_PER_IP, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
  const b = (await req.json().catch(() => ({}))) as { token?: unknown };
  const r = await unsubscribe(b.token);
  if (r === "bad_token") return NextResponse.json({ ok: false, error: "bad_token" }, { status: 400 });
  if (r === "busy") return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
