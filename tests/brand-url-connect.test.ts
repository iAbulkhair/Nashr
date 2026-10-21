import { afterEach, describe, expect, it, vi } from "vitest";
import { jar, newUser, params, seedActiveBrand, signIn, signOut } from "./helpers/session";
import { acct, currentUser, sc } from "@/lib/auth";
import { saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { globalKey, wsKey } from "@/lib/keys";
import { db } from "@/lib/db";
import { CONNECT_STARTS_PER_HOUR } from "@/lib/rate";
import { OAUTH_COOKIE, saveState } from "@/lib/connectors/store";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";

/**
 * Rule 894 (brand id in the URL, Part C; docs/system/tests/0885-brand-url.md): the OAuth connect flow writes the
 * connection to the brand whose page started it (`st.email`, kept in the server-side state), so it must also send the
 * browser back to that brand's page. The old `/{lang}/app/integrations` path goes to the session's stored brand, which
 * can be another one. The brand in the return link comes from the stored state or the session, never from the request.
 */

afterEach(() => { signOut(); vi.unstubAllEnvs(); });

const T0 = "2026-10-01T00:00:00.000Z";
const where = (r: Response) => new URL(r.headers.get("location")!);
const cb = (provider: string, q: string) => callback.GET(new Request(`https://app.test/api/connect/${provider}/callback?${q}`), params({ provider }));
const go = (provider: string, q = "lang=en") => start.GET(new Request(`https://app.test/api/connect/${provider}/start?${q}`), params({ provider }));

/** An owner with brands b1 and b2, the stored choice on b2 (Y); the flow below belongs to b1 (X). */
async function owner(prefix: string) {
  const u = await newUser(prefix);
  const rows: BrandMeta[] = [
    { id: "default", name: "", createdAt: T0, status: "active" },
    { id: "b1", name: "One", createdAt: T0, status: "active" },
    { id: "b2", name: "Two", createdAt: T0, status: "active" },
  ];
  await saveBrands(acct(u), rows);
  await seedActiveBrand(u.email, "b2");
  await signIn(u.email);
  return u;
}

describe("rule 894: the OAuth return link names the connection's brand", () => {
  it("a Connections callback for brand b1 with the stored choice on b2 goes to /b/b1/settings/connections, query kept", async () => {
    const u = await owner("cbx");
    await saveState("s-b1", { email: scopeFor(u.email, "b1"), provider: "x", lang: "en", shop: "", verifier: "v", actor: u.email });
    jar().set(OAUTH_COOKIE, "someone-elses");
    const to = where(await cb("x", "state=s-b1&code=c"));
    expect(to.pathname).toBe("/en/app/b/b1/settings/connections");
    expect(to.searchParams.get("error")).toBe("session_mismatch");
  });

  it("the Reem calendar callback for brand b1 goes to /b/b1/todo with its cal_error code", async () => {
    const u = await owner("cbcal");
    await saveState("s-cal", { email: scopeFor(u.email, "b1"), provider: "gcal", lang: "ar", shop: "", verifier: "", actor: u.email });
    jar().set(OAUTH_COOKIE, "someone-elses");
    const to = where(await cb("gcal", "state=s-cal&code=c"));
    expect(to.pathname).toBe("/ar/app/b/b1/todo");
    expect(to.search).toBe("?cal_error=session_mismatch");
  });

  it("a refusal after the state is read (wrong provider) also names the state's brand", async () => {
    const u = await owner("cbprov");
    await saveState("s-prov", { email: scopeFor(u.email, "b1"), provider: "x", lang: "en", shop: "", verifier: "", actor: u.email });
    const to = where(await cb("linkedin", "state=s-prov&code=c"));
    expect(to.pathname).toBe("/en/app/b/b1/settings/connections");
    expect(to.search).toBe("?error=invalid_state");
  });

  it("with no state at all there is no brand to name: the old path, which the legacy page sends to the stored brand", async () => {
    await owner("cbnone");
    const to = where(await cb("x", "error=access_denied"));
    expect(to.pathname).toBe("/ar/app/integrations");
    expect(to.searchParams.get("error")).toBe("access_denied");
    const cal = where(await cb("gcal", "error=access_denied"));
    expect(cal.pathname).toBe("/ar/app/todo");
  });

  it("the start's refusal goes to the session's brand connections page with the error code", async () => {
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xsecret");
    const u = await owner("cbstart");
    const me = (await currentUser())!;
    expect(me.brandId).toBe("b2");
    await db.set(globalKey.rate(wsKey.connectStartBucket(sc(me))), CONNECT_STARTS_PER_HOUR, 3600);
    const to = where(await go("x", "lang=ar"));
    expect(to.pathname).toBe("/ar/app/b/b2/settings/connections");
    expect(to.searchParams.get("error")).toBe("slow_down");
  });
});
