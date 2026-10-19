import { describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { jar, json, newUser, signIn, signOut } from "./helpers/session";
import { createSession, currentUser, getUser, saveUser, sessionRecord } from "@/lib/auth";
import { charge } from "@/lib/credits";
import { createMcpToken, userFromBearer } from "@/lib/mcp";
import { issueCode, issueTokens, listGrants, redeemCode, registerClient, rotateRefresh } from "@/lib/oauth";
import { db } from "@/lib/db";

vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (...a: unknown[]) => { const { text: text } = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as { to: string; subject: string; text: string }; lastMail = text; return true; } }));
let lastMail = "";

import * as account from "@/app/api/account/route";
import * as forgot from "@/app/api/auth/forgot/route";
import * as reset from "@/app/api/auth/reset/route";
import * as grantsRoute from "@/app/api/mcp/grants/route";
import * as approve from "@/app/api/oauth/approve/route";

const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${++ipN}` });

describe("sessions end when the password changes", () => {
  it("changing the password signs out every other device and keeps this one", async () => {
    const u = await newUser("sess");
    const stolen = await signIn(u.email); // a cookie copied from another device
    const mine = await signIn(u.email);
    const res = await account.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "newpass123" }));
    expect(res.status).toBe(200);
    expect((await currentUser())!.email).toBe(u.email); // this device: fresh session
    expect(jar().get("thakeen_session")).not.toBe(mine);
    jar().set("thakeen_session", stolen);
    expect(await currentUser()).toBeNull();
    jar().set("thakeen_session", mine);
    expect(await currentUser()).toBeNull();
  });
  it("a wrong current password changes nothing and revokes nothing", async () => {
    const u = await newUser("sess");
    const other = await signIn(u.email);
    await signIn(u.email);
    expect((await account.PATCH(json("/api/account", "PATCH", { currentPassword: "nope12345", newPassword: "newpass123" }))).status).toBe(401);
    jar().set("thakeen_session", other);
    expect((await currentUser())!.email).toBe(u.email);
  });
  it("a reset kills old sessions, legacy ones without an issue time included, and every MCP token", async () => {
    // Pins the legacy shape (multi-org M1): a session from before R1 belongs to a legacy owner.
    const u = await newUser("sess", { legacy: true });
    const old = await signIn(u.email);
    const legacy = randomBytes(32).toString("hex");
    // Legacy sessions only exist for accounts from before 2026-09-18, which carry no creation stamp in sessionsAfter
    // (createUser now sets one, so a re-registered address never inherits an old session).
    await saveUser({ ...(await getUser(u.email))!, sessionsAfter: undefined });
    await db.set(`session:${legacy}`, u.email); // the format written before 2026-09-18
    jar().set("thakeen_session", legacy);
    expect((await currentUser())!.email).toBe(u.email); // legacy sessions keep working until a password change
    const personal = await createMcpToken(u.email);
    const client = await registerClient({ redirect_uris: ["https://claude.example/cb"], client_name: "Claude" });
    const oauth = await issueTokens(u.email, client.client_id, "noor");
    expect(await userFromBearer(bearer(oauth.access_token))).not.toBeNull();

    signOut();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
    await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email }, ip()));
    const token = lastMail.match(/#t=([a-f0-9]{64})/)![1];
    expect((await reset.POST(json("/api/auth/reset", "POST", { token, password: "fresh12345" }, ip()))).status).toBe(200);
    expect((await currentUser())!.email).toBe(u.email); // the session the reset created

    for (const t of [old, legacy]) { jar().set("thakeen_session", t); expect(await currentUser()).toBeNull(); }
    expect(await userFromBearer(bearer(personal))).toBeNull();
    expect(await userFromBearer(bearer(oauth.access_token))).toBeNull();
    expect(await rotateRefresh(oauth.refresh_token, client.client_id)).toBeNull();
    expect(await listGrants(u.email)).toHaveLength(0);
  });
  it("saving the new password does not undo a credit charge made meanwhile", async () => {
    const u = await newUser("sess");
    await signIn(u.email);

    // The charge has to land INSIDE the window, not before it. Charging first only proves that PATCH does not
    // invent credits: the handler would read 40, write 40, and the test passed whether or not the fix was there.
    // The lost update happens when the charge commits after the request has read the record and before it saves,
    // so the charge is fired from the request's own first read of that record, and the stale snapshot is returned
    // to the caller exactly as a real concurrent request would have seen it.
    const userKey = `user:${u.email}`;
    let fired = false;
    const realGet = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation(async <T,>(key: string) => {
      const before = await realGet<T>(key);
      if (key === userKey && !fired) {
        fired = true;
        await charge(u.email, 10); // commits 50 -> 40 while the handler still holds the 50 it just read
      }
      return before;
    });

    try {
      await account.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "newpass123" }));
    } finally {
      spy.mockRestore();
    }

    expect(fired, "the charge must have raced the request, or this test proves nothing").toBe(true);
    expect((await getUser(u.email))!.credits, "the password write must not roll the balance back to 50").toBe(40);
  });
});

describe("connected apps (OAuth grants)", () => {
  it("lists apps without their tokens, revokes one at once, and never reaches another account's grant", async () => {
    const a = await newUser("grant"), b = await newUser("grant");
    const client = await registerClient({ redirect_uris: ["https://claude.example/cb"], client_name: "Claude" });
    const ta = await issueTokens(a.email, client.client_id, "noor");
    const tb = await issueTokens(b.email, client.client_id, "noor");

    await signIn(a.email);
    const list = (await (await grantsRoute.GET()).json()) as { grants: Record<string, string>[] };
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0]).toMatchObject({ client_name: "Claude", scope: "noor" });
    expect(JSON.stringify(list)).not.toContain(ta.access_token);
    expect(JSON.stringify(list)).not.toContain(ta.refresh_token);

    const idOfB = (await listGrants(b.email))[0].id;
    expect((await grantsRoute.DELETE(json(`/api/mcp/grants?id=${idOfB}`, "DELETE"))).status).toBe(404);
    expect(await userFromBearer(bearer(tb.access_token))).not.toBeNull();

    expect((await grantsRoute.DELETE(json(`/api/mcp/grants?id=${list.grants[0].id}`, "DELETE"))).status).toBe(200);
    expect(await userFromBearer(bearer(ta.access_token))).toBeNull();
    expect(await rotateRefresh(ta.refresh_token, client.client_id)).toBeNull();
    expect(await userFromBearer(bearer(tb.access_token))).not.toBeNull();

    signOut();
    expect((await grantsRoute.GET()).status).toBe(401);
    expect((await grantsRoute.DELETE(json("/api/mcp/grants?all=1", "DELETE"))).status).toBe(401);
  });
  it("refreshing keeps one grant and kills the previous access token", async () => {
    const u = await newUser("grant");
    const client = await registerClient({ redirect_uris: ["https://claude.example/cb"] });
    const first = await issueTokens(u.email, client.client_id, "noor");
    const second = (await rotateRefresh(first.refresh_token, client.client_id))!;
    expect(await userFromBearer(bearer(first.access_token))).toBeNull();
    expect(await userFromBearer(bearer(second.access_token))).not.toBeNull();
    expect(await rotateRefresh(first.refresh_token, client.client_id)).toBeNull(); // single use
    expect(await listGrants(u.email)).toHaveLength(1);
  });
  it("PKCE and the registered redirect are required, a code works once, and unknown scopes are never written", async () => {
    const u = await newUser("grant");
    await signIn(u.email);
    const client = await registerClient({ redirect_uris: ["https://claude.example/cb"] });
    const verifier = "v".repeat(50), challenge = createHash("sha256").update(verifier).digest("base64url");
    const form = (o: Record<string, string>) => new Request("https://nashr.test/api/oauth/approve", { method: "POST", body: new URLSearchParams(o).toString() });
    const base = { client_id: client.client_id, redirect_uri: "https://claude.example/cb", decision: "allow", scope: "admin everything" };
    expect((await approve.POST(form(base))).status).toBe(400); // no PKCE
    expect((await approve.POST(form({ ...base, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" }))).status).toBe(400);
    const ok = await approve.POST(form({ ...base, code_challenge: challenge, code_challenge_method: "S256" }));
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    expect(await redeemCode(code, client.client_id, base.redirect_uri, "wrong-verifier")).toBeNull();
    expect(await redeemCode(code, client.client_id, base.redirect_uri, verifier)).toBeNull(); // burned by the failed try

    const code2 = await issueCode({ client_id: client.client_id, redirect_uri: base.redirect_uri, challenge, email: u.email, scope: "noor" });
    expect((await redeemCode(code2, client.client_id, base.redirect_uri, verifier))!.email).toBe(u.email);
    expect(await redeemCode(code2, client.client_id, base.redirect_uri, verifier)).toBeNull();

    const ok2 = await approve.POST(form({ ...base, code_challenge: challenge, code_challenge_method: "S256" }));
    const p = await redeemCode(new URL(ok2.headers.get("location")!).searchParams.get("code")!, client.client_id, base.redirect_uri, verifier);
    expect(p!.scope).toBe("noor");
    signOut();
    expect((await approve.POST(form({ ...base, code_challenge: challenge, code_challenge_method: "S256" }))).status).toBe(401);
  });
});

describe("createSession", () => {
  it("writes an issue time, so the session can be outlived by a password change", async () => {
    const u = await newUser("sess");
    signOut();
    await createSession(u.email);
    const rec = (await sessionRecord(jar().get("thakeen_session")!)) as { email: string; at: number } | null;
    expect(rec!.email).toBe(u.email);
    expect(rec!.at).toBeGreaterThan(Date.now() - 5000);
  });
});
