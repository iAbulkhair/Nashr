import { NextResponse } from "next/server";
import { currentUser, sc, type User } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { createFeed, getFeedStatus, revokeFeed } from "@/lib/feed-token";
import { appOrigin } from "@/lib/origin";
import { SEC_READS_PER_HOUR } from "@/lib/secretary";

/**
 * One's own private calendar feed link (Reem phase 3 B1), managed by a signed-in login. The record belongs to the login
 * that is acting: the member's own address for a member, the account address for an owner. Neither the login, the scope
 * nor the language is taken from the request except `lang`, which only picks "ar" or "en" for the calendar text (default: the acting login's own language).
 * GET: whether a link exists and when it was made (`read`), never the link or its hash. POST: mint a new link, replacing
 * the old one (`feed.manage`, refused while a founder impersonates); the link is in this one answer, `Cache-Control:
 * no-store`, and is never stored in plain form. DELETE: stop the link, idempotently (`feed.manage`). Each authenticates
 * and checks the role first. POST and DELETE count against one bucket per login (`sec:feed:{login}`, 20 an hour,
 * `too_many`); the status read has its own, like the other read routes (`sec:read:{login}`, `SEC_READS_PER_HOUR`), so
 * opening My to-dos never uses up the writes. The URL origin is `appOrigin()`,
 * never the request's.
 */
const PER_HOUR = 20;
const loginOf = (u: User): string => (u.actor?.kind === "member" ? u.actor.email : u.email);
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const tooMany = () => NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });

export async function GET() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "read");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:read:${login}`, SEC_READS_PER_HOUR, 3600))) return tooMany();
  const { exists, createdAt } = await getFeedStatus(login);
  return NextResponse.json({ ok: true, exists, createdAt }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "feed.manage");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:feed:${login}`, PER_HOUR, 3600))) return tooMany();
  const body: unknown = await req.json().catch(() => null);
  const asked = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).lang : undefined;
  const lang: "ar" | "en" = asked === "ar" || asked === "en" ? asked : (u.actor?.lang ?? u.lang) === "en" ? "en" : "ar";
  const token = await createFeed(login, sc(u), lang);
  if (token === "busy") return NextResponse.json({ ok: false, error: "busy" }, { status: 409, headers: { "cache-control": "no-store" } });
  const url = `${appOrigin()}/api/secretary/feed/${token}.ics`;
  return NextResponse.json({ ok: true, url, webcal: url.replace(/^https?:/, "webcal:") }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "feed.manage");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:feed:${login}`, PER_HOUR, 3600))) return tooMany();
  await revokeFeed(login);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
