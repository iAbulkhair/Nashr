import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { SEC_READS_PER_HOUR, SEC_WRITES_PER_HOUR } from "@/lib/secretary";
import { WALK_KEY, walkNext, walkSkip } from "@/lib/secretary-walk";

/**
 * "Walk me through my to-dos" for the active brand (`sc(u)`): one card at a time, built in code (src/lib/secretary-walk.ts).
 * GET: the next card and how many are left (`read`, any member). POST `{action: "next", key}`: skip that card for 3
 * hours and answer the next one (`todo.write`, any member). A card's own buttons call the existing routes
 * (`/api/secretary/{id}`, `/api/tasks/{id}`), so each keeps its gate; the card lists only what the viewer may do.
 * `?lang=ar|en` words the card's line; dates are the brand's local time.
 */
const langOf = (req: Request, fallback: "ar" | "en") => {
  const l = new URL(req.url).searchParams.get("lang");
  return l === "ar" || l === "en" ? l : fallback;
};

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const w = await walkNext(sc(u), Date.now(), { viewer: u, lang: langOf(req, u.actor?.lang ?? u.lang) });
  return NextResponse.json({ ok: true, card: w.card, left: w.left });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { action?: unknown; key?: unknown } | null;
  if (!body || typeof body !== "object" || body.action !== "next" || typeof body.key !== "string" || !WALK_KEY.test(body.key)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const scope = sc(u);
  const now = Date.now();
  await walkSkip(scope, body.key, now);
  const w = await walkNext(scope, now, { viewer: u, lang: langOf(req, u.actor?.lang ?? u.lang) });
  return NextResponse.json({ ok: true, card: w.card, left: w.left });
}
