import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { createMcpToken, getMcpToken, revokeMcpToken } from "@/lib/mcp";
import { forbid } from "@/lib/roles";

/**
 * The personal MCP token is an owner credential: a bearer resolves to the whole account (src/lib/mcp.ts
 * `userFromBearer`), so only the owner, signed in as themselves, may see, mint or revoke it. A member, and a founder
 * impersonating the account, get 403 (src/lib/roles.ts "mcp.token").
 *
 * The slot is keyed by the account (`acct(u)`, rule 1985): the same key `revokeAllMcp(acct(u))` clears on a password
 * change, a reset or a deletion, and the value `userFromBearer` reads the account by. Past the gate the actor is always
 * the owner; any other actor (should a gate ever let one through) keys by its own login, which `userFromBearer` finds
 * no account for, so the rule fails closed.
 */
const holder = (u: User) => (u.actor?.kind === "owner" ? acct(u) : u.actor!.email);

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "mcp.token");
  if (no) return no;
  // Only whether one exists: the token is stored as a hash and is shown once, by POST, never again.
  const t = await getMcpToken(holder(u));
  return NextResponse.json({ ok: true, exists: !!t });
}
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "mcp.token");
  if (no) return no;
  await revokeMcpToken(holder(u));
  const token = await createMcpToken(holder(u));
  return NextResponse.json({ ok: true, token }); // shown once
}
export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "mcp.token");
  if (no) return no;
  await revokeMcpToken(holder(u));
  return NextResponse.json({ ok: true });
}
