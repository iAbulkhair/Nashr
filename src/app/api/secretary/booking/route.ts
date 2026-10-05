import { NextResponse } from "next/server";
import { currentUser, sc, type User } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow } from "@/lib/rate";
import { BOOK_PROVIDERS, bookingKey, createBook, getBookStatus, hashBookToken, revokeBook, type BookRecord } from "@/lib/booking-token";
import { calendlySubscribe } from "@/lib/secretary-booking";
import { appOrigin } from "@/lib/origin";
import { SEC_READS_PER_HOUR } from "@/lib/secretary";

/**
 * One's own booking links (Reem phase 3 B2a): the address a booking tool (Cal.com, Calendly) calls when someone books,
 * managed by a signed-in login. The record belongs to the login that is acting (the member's own address for a member, the
 * account address for an owner) and to `sc(u)`; neither is taken from the request. Authenticates and checks the role first.
 * GET: which providers have a live link, since when, and whether each belongs to the brand shown now (`sameBrand`; `read`),
 * never a link, key, hash or scope. POST (`booking.manage`, refused while a founder impersonates): `{ provider: "calcom", lang? }`
 * mints a link, replacing the old one, and answers `{ url, secret }` once, `Cache-Control: no-store`: the url to paste into Cal.com and the signing
 * key to paste as its webhook secret (derived by `bookingKey`, never stored); `{ provider: "calendly", token }` sets Calendly
 * up through its API with the owner's personal access token, which is used for those two calls only and is never stored,
 * logged, put in a URL or echoed (400 `bad_token` unless a non-empty string of at most 2,000 characters; 422 `calendly_rejected`
 * or `calendly_plan` on a refusal). DELETE `?provider=` (`booking.manage`): stop that provider's link, idempotently; the
 * provider must be named (400 `bad_provider`). POST and DELETE count against one bucket per login (`sec:book:{login}`, 20 an
 * hour, `too_many`); the status read has its own (`sec:read:{login}`, `SEC_READS_PER_HOUR`). The URL origin is `appOrigin()`.
 */
const PER_HOUR = 20;
const MAX_TOKEN = 2000;
const NO_STORE = { "cache-control": "no-store" };
const loginOf = (u: User): string => (u.actor?.kind === "member" ? u.actor.email : u.email);
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const tooMany = () => NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
const bad = (error: "bad_provider" | "bad_token") => NextResponse.json({ ok: false, error }, { status: 400, headers: NO_STORE });
const providerOf = (v: unknown): BookRecord["provider"] | null => ((BOOK_PROVIDERS as readonly unknown[]).includes(v) ? (v as BookRecord["provider"]) : null);

export async function GET() {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "read");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:read:${login}`, SEC_READS_PER_HOUR, 3600))) return tooMany();
  const links = await getBookStatus(login, sc(u));
  return NextResponse.json({ ok: true, links }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "booking.manage");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:book:${login}`, PER_HOUR, 3600))) return tooMany();
  const raw: unknown = await req.json().catch(() => null);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const provider = providerOf(body.provider);
  if (!provider) return bad("bad_provider");
  const pat = body.token;
  if (provider === "calendly" && (typeof pat !== "string" || !pat.trim() || pat.length > MAX_TOKEN)) return bad("bad_token");
  const lang: "ar" | "en" = body.lang === "ar" || body.lang === "en" ? body.lang : (u.actor?.lang ?? u.lang) === "en" ? "en" : "ar";
  const token = await createBook(login, sc(u), provider, lang);
  if (token === "busy") return NextResponse.json({ ok: false, error: "busy" }, { status: 409, headers: NO_STORE });
  const url = `${appOrigin()}/api/secretary/booking/${token}`;
  const secret = bookingKey(hashBookToken(token));
  if (provider === "calcom") return NextResponse.json({ ok: true, url, secret }, { headers: NO_STORE });
  // The record exists first, so the address Calendly will call and the key it will sign with are the real ones; any failure removes it.
  const done = await calendlySubscribe((pat as string).trim(), url, secret).catch(() => ({ ok: false, error: "calendly_rejected" }) as const);
  if (!done.ok) {
    await revokeBook(login, "calendly");
    return NextResponse.json({ ok: false, error: done.error }, { status: 422, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return unauthorized();
  const no = forbid(u, "booking.manage");
  if (no) return no;
  const login = loginOf(u);
  if (!(await allow(`sec:book:${login}`, PER_HOUR, 3600))) return tooMany();
  const provider = providerOf(new URL(req.url).searchParams.get("provider"));
  if (!provider) return bad("bad_provider");
  await revokeBook(login, provider);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
