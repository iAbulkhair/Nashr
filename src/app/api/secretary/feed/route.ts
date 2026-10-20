import { NextResponse } from "next/server";
import { currentUser, sc, type User } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater } from "@/lib/rate";
import { createFeed, getFeedStatus, revokeFeed } from "@/lib/feed-token";
import { appOrigin } from "@/lib/origin";
import { SEC_READS_PER_HOUR } from "@/lib/secretary";
import { linkOwner } from "@/lib/secretary-feed";

/**
 * One's own private calendar feed link (Reem phase 3 B1), managed by a signed-in login. The link belongs to the acting
 * person in the ACTIVE account (`linkOwner`: `u.actor.pid` and the session's account, multi-workspace M1, rule 2119), and
 * in the person's home account also to the acting login's legacy pointer (the member's own address for a member, the
 * account address for an owner), so a link made before M1 keeps working there. Neither the person, the account, the
 * login, the scope nor the language is taken from the request except `lang`, which only picks "ar" or "en" for the calendar text (default: the acting login's own language).
 * GET: whether a link exists, when it was made and whether it belongs to the brand shown now (`sameBrand`; `read`), never the link, its hash or its scope. POST: mint a new link, replacing
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
/** Every bucket here is an hour long. */
const tooMany = () => retryLater({ ok: false, error: "too_many" }, 3600);

export async function GET() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "read");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:read:${login}`, SEC_READS_PER_HOUR, 3600))) return tooMany();
  // `sameBrand` says whether the link was made in the brand this page shows; the record's scope itself is never sent.
  const who = linkOwner(u);
  if (!who) return unauthorized();
  const { exists, createdAt, sameBrand } = await getFeedStatus(who, sc(u));
  return NextResponse.json({ ok: true, exists, createdAt, sameBrand }, { headers: { "cache-control": "no-store" } });
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
  const who = linkOwner(u);
  if (!who) return unauthorized();
  const token = await createFeed(who, sc(u), lang);
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
  const who = linkOwner(u);
  if (!who) return unauthorized();
  await revokeFeed(who);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
