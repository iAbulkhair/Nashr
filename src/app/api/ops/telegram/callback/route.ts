import { NextResponse } from "next/server";
import { allow, clientIp, retryLater, OPS_CALLS_PER_IP_PER_MINUTE } from "@/lib/rate";
import { handlePress, telegramAuthorized } from "@/lib/ops";

/**
 * POST /api/ops/telegram/callback (rules 2386-2389): Telegram's webhook for the founder's button press (src/lib/ops.ts
 * `handlePress`). Per IP `OPS_CALLS_PER_IP_PER_MINUTE` a minute, then the `X-Telegram-Bot-Api-Secret-Token` header must
 * equal `TELEGRAM_WEBHOOK_SECRET` (`sameSecret`; 401 while unset). After that the answer is always 200 `{ ok: true }`,
 * whatever the update was, so Telegram does not resend it; what happened is told to the founder in the chat.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await allow("ops:ip:" + clientIp(req), OPS_CALLS_PER_IP_PER_MINUTE, 60))) return retryLater({ error: "slow_down" }, 60);
  if (!telegramAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  await handlePress(await req.json().catch(() => null));
  return NextResponse.json({ ok: true }, { headers });
}
