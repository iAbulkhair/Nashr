import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newOpaqueUser, newUser, PERSONS, signIn, signOut, useWorkspace } from "./helpers/session";
import { enrolPasskeys, PASSKEY_ORIGIN } from "./helpers/passkeys";
import { acct, getLogin, getUser } from "@/lib/auth";
import { ownerOf } from "@/lib/membership";
import { OPAQUE_ACCOUNT_ID, OPAQUE_IDS } from "@/lib/account-id";
import { handler } from "@/lib/api-handler";
import { db } from "@/lib/db";
import { accountKey, personKey } from "@/lib/keys";
import { listPasskeys } from "@/lib/passkeys";
import { removeMember } from "@/lib/team";
import { moveUnverifiedAccount } from "@/lib/verify-email";
import { MULTI_ORG } from "@/lib/multi-org";
import { approvePartner } from "@/lib/partners";
import { handleOf } from "@/lib/ws-handle";
import { WS_HEADER, workspaceFree, workspaceMissing } from "@/lib/ws-path";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import * as signupRoute from "@/app/api/auth/signup/route";

/**
 * Multi-workspace M2 "enable" with account-id R2 "enable" (decision 11): rules 3810-3822, listed in
 * docs/system/tests/3810-multi-org-switch-on.md. Both switches are on; every other test file runs with them on too,
 * except the rollback-floor files of rule 3814.
 */

afterEach(() => signOut());
const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });

describe("rule 3810: both release switches are on", () => {
  it("MULTI_ORG and OPAQUE_IDS are code constants, true, and still no environment variable", () => {
    expect(MULTI_ORG).toBe(true);
    expect(OPAQUE_IDS).toBe(true);
    expect(read("src/lib/multi-org.ts")).toContain("export const MULTI_ORG = true;");
    expect(read("src/lib/account-id.ts")).toContain("export const OPAQUE_IDS = true;");
    const vars = read("docs/system/variables.md");
    expect(vars).not.toContain("MULTI_ORG");
    expect(vars).not.toContain("OPAQUE_IDS");
  });

  it("a sign-up through the route is a p_ person owning an a_ account, reached through its login", async () => {
    const e = `on${Date.now()}@test.example`;
    const res = await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "On", lang: "en" }, ip()));
    expect(res.status).toBe(200);
    const l = (await getLogin(e))!;
    expect(l.kind).toBe("owner");
    expect(l.pid).toMatch(/^p_/);
    expect(l.acct).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await getUser(e)).toBeNull();
    expect((await getUser(l.acct!))!.email).toBe(e);
  });
});

describe("rule 3811: the test client names its workspace as the page does", () => {
  it("after signIn a JSON request carries the session account's handle; a named header wins; useWorkspace(null) and signOut drop it", async () => {
    const u = await newUser("ws");
    await signIn(u.email);
    expect(json("/api/x", "POST", {}).headers.get(WS_HEADER)).toBe(handleOf(u));
    expect(json("/api/x", "POST", {}, { [WS_HEADER]: "other" }).headers.get(WS_HEADER)).toBe("other");
    useWorkspace(null);
    expect(json("/api/x", "POST", {}).headers.get(WS_HEADER)).toBeNull();
    await signIn(u.email);
    signOut();
    expect(json("/api/x", "POST", {}).headers.get(WS_HEADER)).toBeNull();
  });
});

describe("rule 3812: the route wrapper answers a signed-out caller 401 before the workspace check", () => {
  const h = handler({ auth: "user" }, () => Response.json({ ok: true }));
  it("signed out, no handle: the route's own 401, never 409 workspace_missing", async () => {
    const r = await h(json("/api/probe", "POST", { x: 1 }));
    expect(r.status).toBe(401);
  });
  it("signed in, no handle: 409 workspace_missing; with its handle: the route runs", async () => {
    const u = await newUser("wsh");
    await signIn(u.email);
    expect((await h(json("/api/probe", "POST", { x: 1 }))).status).toBe(200);
    useWorkspace(null);
    const r = await h(json("/api/probe", "POST", { x: 1 }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "workspace_missing" });
  });
  it("the session is read before the workspace check (source order)", () => {
    const src = read("src/lib/api-handler.ts");
    expect(src.indexOf("if (!u) return fail(opts.unauthorized, 401);")).toBeLessThan(src.indexOf('fail("workspace_missing", 409)'));
  });
});

describe("rule 3813: approving a partner stamps the owner's account by its id", () => {
  it("an a_ owner gets partnerCode on user:{a_…}, and nothing is written at user:{address}", async () => {
    const o = await newOpaqueUser("pa");
    const code = `ON${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const r = await approvePartner({ email: o.email, code, name: "Partner", consentOutOfBand: true }, "key");
    expect(r.ok).toBe(true);
    expect((await getUser(acct(o)))!.partnerCode).toBe(code);
    expect(await db.get(accountKey.user(o.email))).toBeNull();
  });
});

describe("rule 3814: the rollback floor is still proved with the switches off", () => {
  // Files that turn the switches off for the whole file, and files that turn them off per test (a getter). The on path of
  // tests/passkeys-moves.test.ts is rule 3818.
  const WHOLE = ["tests/multi-org-flag-off.test.ts", "tests/multi-org-brand-url-off.test.ts", "tests/multi-org-links-scan.test.ts", "tests/account-id-r1.test.ts", "tests/passkeys-moves.test.ts"];
  const PER_TEST = ["tests/multi-org-m3-legacy.test.ts", "tests/multi-org-signin.test.ts", "tests/multi-org-credentials.test.ts", "tests/multi-org-team.test.ts", "tests/multi-org-wipe.test.ts"];
  it("each floor file mocks MULTI_ORG off, and the M1 floor file OPAQUE_IDS too", () => {
    for (const f of WHOLE) expect(read(f), f).toContain("MULTI_ORG: false");
    expect(read("tests/multi-org-flag-off.test.ts")).toContain("OPAQUE_IDS: false");
    expect(read("tests/account-id-r1.test.ts")).toContain("OPAQUE_IDS: false");
    for (const f of PER_TEST) expect(read(f), f).toContain("get MULTI_ORG()");
  });
});

describe("rule 3815: an address-id account is a test's choice only", () => {
  it("no production caller passes createUser options; the sign-up route and Google sign-in take the default", () => {
    expect(read("src/app/api/auth/signup/route.ts")).toMatch(/createUser\(\{ email, name: [^\n]*\}\)/);
    expect(read("src/lib/google-signin.ts")).toMatch(/createUser\(\{ email: id\.email, [^\n]*\}\)/);
    expect(read("src/lib/auth.ts")).toContain("const opaque = opts.opaque ?? (OPAQUE_IDS || (split && MULTI_ORG));");
  });
  it("the fixture's addressId makes an account whose id is its address, the default an a_ one", async () => {
    const old = await newUser("ad", { addressId: true });
    expect(acct(old)).toBe(old.email);
    expect((await getUser(old.email))!.email).toBe(old.email);
    const fresh = await newUser("ad");
    expect(acct(fresh)).toMatch(OPAQUE_ACCOUNT_ID);
  });
});

describe("rule 3816: a founder's bell is found through the login, never at user:{address}", () => {
  // Behaviour: tests/fair-use.test.ts ("the founder") and tests/margin-integrations.test.ts (rules 1535-1538) read the
  // founder's bell at acct(founder). Here: no founder lookup by address is left, and every bell goes to acct(f).
  it("fair-use, margin and golden resolve ADMIN_EMAILS with accountByLogin and notify acct(f)", () => {
    for (const f of ["src/lib/fair-use.ts", "src/lib/margin.ts", "src/lib/golden.ts"]) {
      const src = read(f);
      expect(src, f).toContain("adminEmails().map((e) => accountByLogin(e))");
      expect(src, f).not.toMatch(/adminEmails\(\)\.map\(\(e\) => getUser\(e\)\)/);
      expect(src, f).toMatch(/notifyItem\(acct\(f\), /);
      expect(src, f).not.toMatch(/notifyItem\((e|f\.email), /);
    }
  });
});

describe("rule 3817: a link made before M1 is checked against the owner's account id", () => {
  it("legacyHolds reads the brand list of acct(owner), never of the address", () => {
    const src = read("src/lib/secretary-feed.ts");
    const body = src.slice(src.indexOf("async function legacyHolds"), src.indexOf("export const feedHolds"));
    expect(body).toContain("owner = acct(login.user);");
    expect(body).toContain("owner = acct(u);");
    expect(body).not.toMatch(/owner = (login\.user|u)\.email;/);
  });
});

describe("rule 3818: with the switches on a passkey set stays with its p_ person", () => {
  // tests/passkeys-moves.test.ts pins the floor (the set copied to a new legacy pid); this is the on path.
  it("an owner's in-place address move and a member's removal leave the set at the same pid", async () => {
    vi.stubEnv("APP_ORIGIN", PASSKEY_ORIGIN);
    try {
      const o = await newUser("pkon", { verified: false });
      const pid = (await getLogin(o.email))!.pid;
      // A p_ person, or with TEST_PERSONS=legacy the production shape: the owner's person id is its account id.
      expect(pid).toMatch(PERSONS === "p" ? /^p_/ : /^a_/);
      const e = await enrolPasskeys(o.email);
      expect(e.pid).toBe(pid);
      const to = `pkon-to-${Date.now()}@test.example`;
      expect(await moveUnverifiedAccount((await getUser(acct(o)))!, to)).toBe("ok");
      expect((await getLogin(to))!.pid).toBe(pid);
      expect(await listPasskeys(pid, e.born)).toHaveLength(e.softs.length);

      const owner = await newUser("pkonm");
      const m = await newMember(owner, "member", "pkm");
      const mpid = (await getLogin(m.email))!.pid;
      const me = await enrolPasskeys(m.email);
      expect(me.pid).toBe(mpid);
      const actor = { kind: "owner" as const, pid: ownerOf(owner), home: true, email: owner.email, name: owner.name, lang: owner.lang, role: "owner" as const };
      expect(await removeMember(owner, actor, m.email)).toEqual({ ok: true });
      expect(await db.get(personKey.person(mpid))).not.toBeNull();
      expect(await listPasskeys(mpid, me.born)).toHaveLength(me.softs.length);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("rule 3819: the system's console rows on an account name its sign-in address", () => {
  // Behaviour: tests/money-price-fixes.test.ts (rule 1304, hand_refill) and tests/admin-team-suspension.test.ts
  // (suspension.expired) read the log by the address of an a_ account. Here: neither row takes the account id it is called with.
  it("hand_refill and suspension.expired take the address from the saved record", () => {
    expect(read("src/lib/credits.ts")).toContain('action: "hand_refill", target: hand.address,');
    expect(read("src/lib/suspension-server.ts")).toContain("target: done.address,");
  });
});

describe("rule 3820: the partner side keys the partner by its address and its account through the login", () => {
  // Behaviour: tests/partners.test.ts (rules 398-417 bank and payouts, red before the fix; rule 396 "same team" both ways).
  it("the bank route saves under the sign-in address; settle checks the roster with the partner's person and account", () => {
    expect(read("src/app/api/partner/route.ts")).toContain("saveBank(u.email, {");
    const settle = read("src/lib/partners.ts");
    expect(settle).toContain("onRoster(e, theirs?.pid ?? at.partner)");
    expect(settle).toContain("partnerAccount ? onRoster(partnerAccount, ownerOf(u)) : false");
    expect(settle).not.toContain("onRoster(at.partner, e)");
  });
});

describe("rule 3821: a login is counted under the account id, and retention reads the same id", () => {
  // Behaviour: tests/teams-flows.test.ts ("a login counts the ACCOUNT in the active sets", red before the fix).
  it("login-finish tracks acct(counted); admin-stats checks the week set with acct(u)", () => {
    expect(read("src/lib/login-finish.ts")).toContain('track(acct(counted), "login")');
    expect(read("src/lib/admin-stats.ts")).toContain("weekSet.has(acct(u))");
  });
});

describe("rule 3822: no scope falls back to the sign-in address", () => {
  it("no source reads `scope ?? <user>.email`; the fallback is the account id", () => {
    const files = ["src/app/api/cron/daily/route.ts", "src/lib/routines.ts", "src/lib/schedule.ts", "src/lib/lifecycle.ts", "src/lib/chat.ts", "src/lib/chat-run-tool.ts", "src/lib/handoff-auto.ts", "src/lib/rate.ts"];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\b(u|user)\.scope \?\? (u|user)\.email\b/);
      expect(src, f).toMatch(/\.scope \?\? acct\((u|user)\)/);
    }
  });
});

describe("rule 3826: the Security page's writes need no workspace", () => {
  const req = (path: string, method: string) =>
    new NextRequest("https://thakeen.example" + path, { method, headers: { cookie: "thakeen_session=tok", "sec-fetch-site": "same-origin" } });

  it("the proxy lets the password change and the passkey route through without a handle; deleting the account stays guarded", () => {
    for (const [method, path] of [["PATCH", "/api/account"], ["POST", "/api/account/passkeys"], ["DELETE", "/api/account/passkeys"]]) {
      expect(proxy(req(path, method)).status, `${method} ${path}`).not.toBe(409);
    }
    expect(proxy(req("/api/account", "DELETE")).status).toBe(409);
    expect(workspaceMissing("PATCH", "/api/account/", true, null)).toBe(false);
    for (const m of ["POST", "PUT", "DELETE"]) expect(workspaceMissing(m, "/api/account", true, null), m).toBe(true);
  });

  it("every write the Security page's cards send is outside the guard (the page is a person page: no handle)", () => {
    const cards = ["SecuritySettings", "TwoStepSettings", "DeviceList", "GoogleLink", "PasskeySettings"].map((n) => `src/components/app/settings/${n}.tsx`);
    expect(read("src/app/[lang]/app/settings/security/page.tsx")).toContain("SecuritySettings");
    let writes = 0;
    for (const f of cards) {
      for (const m of read(f).matchAll(/fetch\("(\/api\/[^"?]*)"(?:, \{ method(?:: "([A-Z]+)")?)?/g)) {
        const [, path, literal] = m;
        if (!m[0].includes("method")) continue; // a GET
        writes++;
        if (literal) expect(workspaceMissing(literal, path, true, null), `${f}: ${literal} ${path}`).toBe(false);
        else expect(workspaceFree(path), `${f}: ${path} (method from a variable)`).toBe(true);
      }
    }
    expect(writes).toBeGreaterThanOrEqual(5);
  });
});

describe("rule 3828: a sign-in lands in the app with a full load", () => {
  it("log-in, a password reset and an invite accept assign the app's address; none pushes into it and refreshes", () => {
    const auth = read("src/components/app/AuthForm.tsx");
    const join = read("src/components/app/JoinForm.tsx");
    // The log-in's `arrive` and the reset's success; the join form's accept.
    expect(auth.match(/window\.location\.assign\(appHref\(lang\)\);/g)).toHaveLength(2);
    expect(join.match(/window\.location\.assign\(appHref\(lang\)\);/g)).toHaveLength(1);
    // A client push into the app followed by `refresh()` refetched a `/w/{handle}` page whose server redirect it could not
    // follow, without end (a brand with no file: the start page).
    for (const [f, src] of [["AuthForm", auth], ["JoinForm", join]] as const) expect(src, f).not.toMatch(/push\(appHref\(lang\)\);\s*\w+\.refresh\(\)/);
  });
});
