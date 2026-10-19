import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { listGrants, revokeAllGrants, revokeGrant } from "@/lib/oauth";
import { forbid } from "@/lib/roles";

/**
 * Apps connected through OAuth (Claude and others). GET lists them; DELETE ?id= revokes one, DELETE ?all=1 revokes all.
 * Owner only (src/lib/roles.ts "oauth.grants"): every grant acts as the whole account, and only the owner approves them.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "oauth.grants");
  if (no) return no;
  return NextResponse.json({ ok: true, grants: await listGrants(acct(u)) });
}
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "oauth.grants");
  if (no) return no;
  const q = new URL(req.url).searchParams;
  if (q.get("all") === "1") return NextResponse.json({ ok: true, revoked: await revokeAllGrants(acct(u)) });
  const id = q.get("id") ?? "";
  if (!/^[a-f0-9]{16}$/.test(id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  // Looked up under the caller's own account only: another account's grant id is simply not found.
  return (await revokeGrant(acct(u), id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}
