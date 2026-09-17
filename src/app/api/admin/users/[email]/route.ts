import { NextResponse } from "next/server";
import { getUser, isAdmin } from "@/lib/auth";
import { getBrand, listTasks } from "@/lib/brand";

export async function GET(req: Request, ctx: { params: Promise<{ email: string }> }) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const { email } = await ctx.params;
  const u = await getUser(decodeURIComponent(email));
  if (!u) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const [brand, tasks] = await Promise.all([getBrand(u.email), listTasks(u.email)]);
  const { passHash: _omit, ...safe } = u;
  void _omit;
  return NextResponse.json({ ok: true, user: safe, brand, tasks });
}
