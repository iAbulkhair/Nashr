import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { ACCOUNT_EXPORTS_PER_DAY, ACCOUNT_EXPORTS_PER_HOUR, buildExport } from "@/lib/privacy-export";

export const dynamic = "force-dynamic";

/**
 * GET — the signed-in owner's own data as one JSON file (rules 1320-1324, src/lib/privacy-export.ts): account, consent
 * record, plan and credits, and every brand's profile, tasks, files, conversations and connection details without
 * tokens. Owner only and refused while a founder impersonates (`account.export`). Nothing is read from the request: the
 * account is the session's. JSON, not CSV, so no cell is ever opened by a spreadsheet; `csvSafe` has nothing to guard.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "account.export");
  if (no) return no;
  if (!(await allow(`accountexport:h:${u.email}`, ACCOUNT_EXPORTS_PER_HOUR, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  if (!(await allow(`accountexport:d:${u.email}`, ACCOUNT_EXPORTS_PER_DAY, 86400))) return retryLater({ ok: false, error: "slow_down" }, 86400);
  const data = await buildExport(u);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="thakeen-data-${data.exportedAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
