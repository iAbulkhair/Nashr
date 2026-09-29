import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { confirmOnboard, onboardUrl } from "@/lib/onboard-confirm";
import { forbid } from "@/lib/roles";

/**
 * The owner's "build my workspace from this site", pressed on the start page. POST {url} → {ok}.
 * Nothing is crawled and no model is called here: it only records the one URL `POST /api/onboard` may build from
 * (src/lib/onboard-confirm.ts). The session cookie is SameSite=Lax, so another site cannot submit this for a signed-in owner.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "onboard");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = onboardUrl(b.url);
  if (url.length < 4) return NextResponse.json({ ok: false, error: "bad_url" }, { status: 400 });
  const scope = sc(u);
  if (await getBrand(scope)) return NextResponse.json({ ok: false, error: "already_onboarded" }, { status: 409 });
  await confirmOnboard(scope, url);
  return NextResponse.json({ ok: true });
}
