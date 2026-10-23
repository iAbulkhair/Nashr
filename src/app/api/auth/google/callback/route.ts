import { NextResponse } from "next/server";
import { createSession, currentUser } from "@/lib/auth";
import { exchangeCode, googleSignInOn, linkGoogle, resolveGoogle, takeState } from "@/lib/google-signin";
import { finishLogin, rememberLoginMethod } from "@/lib/login-finish";
import { isPersonLockTimeout } from "@/lib/person";
import { actingLogin } from "@/lib/own-password";
import { appOrigin } from "@/lib/origin";
import { afterSignup, signupPartner } from "@/lib/partners";
import { allow, clientIp } from "@/lib/rate";
import { applyReferral, registerCode } from "@/lib/referral";
import { track } from "@/lib/track";
import { appHref } from "@/lib/ws-path";

const go = (path: string) => NextResponse.redirect(`${appOrigin()}${path}`, 303);

/**
 * GET /api/auth/google/callback?code&state (rules 1946-1953). Public, as any OAuth return address, and rate limited with
 * the login route's per-address bucket. Takes the flow's state (it must match this browser's cookie and is used once),
 * trades the code with the PKCE verifier, verifies the ID token, then:
 *   link:   the session's own login (the one that started) gets this Google account; back to Security settings.
 *   login / signup: `resolveGoogle` picks or creates the login, and `finishLogin` runs the same refusals, two-step
 *           challenge and session as a password sign-in. Every outcome is a redirect to a fixed path on this site.
 */
export async function GET(req: Request) {
  if (!googleSignInOn()) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const st = await takeState(q.get("state"));
  const lang = st?.lang ?? "ar";
  const fail = (code: string, page: "login" | "signup" = "login") => go(appHref(lang, `/${page}?google=${code}`));
  if (!(await allow(`login:ip:${clientIp(req)}`, 20, 900))) return fail("slow_down");
  if (!st) return fail("google_failed");
  if (q.get("error")) return st.mode === "link" ? go(`/${lang}/app/settings/security?google=google_cancelled`) : fail("google_cancelled", st.mode === "signup" ? "signup" : "login");
  const id = await exchangeCode(q.get("code"), st);
  if (!id) return st.mode === "link" ? go(`/${lang}/app/settings/security?google=google_failed`) : fail("google_failed", st.mode === "signup" ? "signup" : "login");

  if (st.mode === "link") {
    const u = await currentUser();
    const me = u ? await actingLogin(u) : null;
    if (!me || !st.login || me.email !== st.login) return fail("google_failed");
    const r = await linkGoogle(me.email, id);
    return go(`/${lang}/app/settings/security?google=${r === "ok" ? "linked" : r}`);
  }

  // A new account is throttled per address as the signup route is (trial credits and a free onboarding run).
  if (st.mode === "signup" && !(await allow(`signup:ip:${clientIp(req)}`, 5, 3600))) return fail("slow_down", "signup");
  // A sign-up writes the new person under `lock:person` (rule 2139): a lock held past the wait wrote nothing, and the
  // person is sent back to try again, as for any failed Google sign-in.
  let res: Awaited<ReturnType<typeof resolveGoogle>>;
  try {
    res = await resolveGoogle(id, st.mode, lang);
  } catch (e) {
    if (isPersonLockTimeout(e)) return fail("google_failed", st.mode === "signup" ? "signup" : "login");
    throw e;
  }
  if (res.kind === "refused") return fail(res.error, st.mode === "signup" ? "signup" : "login");
  if (res.kind === "created") {
    // The new account's id is its person id (rule 1985); the address only signs in.
    const id = res.login.pid;
    await registerCode(id);
    if (st.ref) await applyReferral(id, st.ref).catch(() => false);
    const partner = await signupPartner(undefined).catch(() => null);
    if (partner && partner !== "bad") await afterSignup({ id, email: res.email }, partner).catch(() => false);
    await createSession(res.email);
    await rememberLoginMethod("google");
    await track(id, "signup");
    // A new account has one brand, "default": its start page by name, no legacy hop (rule 894).
    return go(st.next || appHref(lang, "/start", null, "default"));
  }
  const f = await finishLogin(res.login, { via: "google", next: st.next });
  if (f.kind === "refused") {
    const j = (await f.res.json().catch(() => ({}))) as { error?: string };
    return fail(typeof j.error === "string" && /^[a-z_]{1,40}$/.test(j.error) ? j.error : "invalid");
  }
  if (f.kind === "mfa") return go(`/${lang}/app/login?mfa=1${st.next ? `&next=${encodeURIComponent(st.next)}` : ""}`);
  return go(st.next || appHref(lang));
}
