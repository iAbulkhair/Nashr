import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { clientIpReport } from "@/lib/rate";

/**
 * GET /api/admin/client-ip (rule 908): what the app receives as the caller's address, for the founder only. It answers
 * the open question of rule 979 without a guess: which forwarded-for hop Hostinger's proxies append, so
 * `TRUSTED_PROXY_HOPS` can be set from evidence (flows.md section 51 item 7). The founder's own request only; nothing
 * is stored or logged, and the answer is never cached.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, ...clientIpReport(req) }, { headers: { "Cache-Control": "no-store" } });
}
