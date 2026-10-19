import { NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth";
import { googleLinked, googleSignInOn, startGoogle, unlinkGoogle } from "@/lib/google-signin";
import { actingLogin, ownPasswordMatches } from "@/lib/own-password";
import { allow, giveBack, retryLater, WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";

/** Wrong passwords per login and hour on this route (as the two-step, device and address routes). */
const PASSWORD_TRIES_PER_HOUR = 10;

/**
 * The acting login's Google link (rules 1946-1953). GET: whether Google sign-in is on and whether this login is linked.
 * POST {action: "unlink", password}: drops the link. The password is required, so an account opened with Google sets a
 * password first ("forgot password") and is never left without a way in.
 * POST {action: "link", password, lang?}: starts linking (rule 2302) and answers `{ok, url}`, Google's consent address,
 * which the settings card opens. A link is a way into the login that survives sessions, so it takes the password as
 * unlinking does: a stolen session alone cannot add one. The password rides in the JSON body, never in a URL, which is
 * why linking left GET /api/auth/google/start.
 * Owner or member, each for their own login; refused while a founder impersonates (`google.manage`).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "google.manage");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, on: googleSignInOn(), linked: await googleLinked(me.email) });
}

async function passwordRefusal(u: User, login: string, password: unknown): Promise<NextResponse | null> {
  const bucket = `googlepw:${login}`;
  if (!(await allow(bucket, PASSWORD_TRIES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!(await ownPasswordMatches(u, password))) return NextResponse.json({ ok: false, error: "wrong_password" }, { status: 401 });
  await giveBack(bucket);
  return null;
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "google.manage");
  if (no) return no;
  const me = await actingLogin(u);
  if (!me) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; password?: unknown; lang?: unknown };
  if (b.action !== "unlink" && b.action !== "link") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  if (b.action === "link" && !googleSignInOn()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const pw = await passwordRefusal(u, me.email, b.password);
  if (pw) return pw;
  if (b.action === "link") {
    // The flow records this login, so the callback links nothing to anyone else (src/lib/google-signin.ts).
    const url = await startGoogle({ mode: "link", lang: b.lang, login: me.email });
    return url ? NextResponse.json({ ok: true, url }) : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  await unlinkGoogle(me.email);
  return NextResponse.json({ ok: true });
}
