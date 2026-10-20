import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { authenticationOptions, registrationOptions, responseId, rp, verifyAuthentication, verifyRegistration } from "@/lib/webauthn";
import { softAuthenticator, type AssertionJSON } from "./helpers/soft-authenticator";

/**
 * Customer passkeys, task 1: the WebAuthn seam `src/lib/webauthn.ts` (spec docs/specs/2026-10-20-passkeys.md).
 * Real crypto end to end: a software ES256 authenticator (tests/helpers/soft-authenticator.ts) answers the options the
 * seam makes, and @simplewebauthn/server verifies them through the seam. Nothing is mocked.
 *
 * Rule 2409: UV required, resident key required, attestation none; a wrong UV flag, origin, RP ID, challenge,
 * signature or client data is refused. Rule 2406: RP ID and origin come from `appOrigin()` alone. Rule 2427: only the
 * seam imports the server package, only client components import the browser one, both pinned exactly.
 */

const LIVE = "https://thakeen.com";
const STAGING = "https://staging.thakeen.com";
const uid = () => randomBytes(32).toString("base64url");

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", LIVE);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

/** Register a soft authenticator through the seam and return what a store would keep. */
async function enrolled() {
  const auth = softAuthenticator();
  const handle = uid();
  const { challenge } = await registrationOptions({ uid: handle, userName: "a@example.com", displayName: "A", exclude: [] });
  const r = await verifyRegistration(auth.makeAttestation({ challenge, origin: LIVE, rpId: "thakeen.com", userHandle: handle }), challenge);
  if (!r.ok) throw new Error("enrolment failed");
  return { auth, handle, cred: { id: r.cred.id, pk: r.cred.pk, transports: r.cred.transports } };
}

describe("rule 2409: registration options and verification (real crypto)", () => {
  it("options ask for a resident key, user verification and no attestation, with user.id = uid and the three algorithms", async () => {
    const handle = uid();
    const exclude = [{ id: randomBytes(32).toString("base64url"), transports: ["internal"] }];
    const { options, challenge } = await registrationOptions({ uid: handle, userName: "a@example.com", displayName: "A", exclude });
    expect(options.authenticatorSelection?.residentKey).toBe("required");
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.attestation).toBe("none");
    expect(options.user.id).toBe(handle);
    expect(options.user.name).toBe("a@example.com");
    expect(options.user.displayName).toBe("A");
    expect(options.rp).toEqual({ id: "thakeen.com", name: "Thakeen" });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([exclude[0].id]);
    expect(options.challenge).toBe(challenge);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("a uid that is not 32 bytes of base64url is refused before any option is made", async () => {
    await expect(registrationOptions({ uid: "a@example.com", userName: "a@example.com", displayName: "A", exclude: [] })).rejects.toThrow();
  });

  it("a non-canonical 43-character uid (padding bits set, so it decodes to another string) is refused", async () => {
    const odd = `${"A".repeat(42)}B`;
    expect(odd).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(odd, "base64url").toString("base64url")).not.toBe(odd);
    await expect(registrationOptions({ uid: odd, userName: "a@example.com", displayName: "A", exclude: [] })).rejects.toThrow();
    const canonical = `${"A".repeat(42)}A`;
    expect((await registrationOptions({ uid: canonical, userName: "a@example.com", displayName: "A", exclude: [] })).options.user.id).toBe(canonical);
  });

  it("an attestation with the right challenge, origin and RP ID verifies and returns the credential", async () => {
    const auth = softAuthenticator();
    const { challenge } = await registrationOptions({ uid: uid(), userName: "a@example.com", displayName: "A", exclude: [] });
    const r = await verifyRegistration(auth.makeAttestation({ challenge, origin: LIVE, rpId: "thakeen.com" }), challenge);
    expect(r).toEqual({
      ok: true,
      cred: { id: auth.credId, pk: auth.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: false },
    });
  });

  it.each([
    ["UV off", { uv: false }],
    ["another origin", { origin: "https://thakeen.com.evil.example" }],
    ["another RP ID", { rpId: "evil.example" }],
    ["another challenge", { challenge: randomBytes(32).toString("base64url") }],
  ])("%s is refused as { ok: false, reason: 'invalid' }", async (_, bend) => {
    const auth = softAuthenticator();
    const { challenge } = await registrationOptions({ uid: uid(), userName: "a@example.com", displayName: "A", exclude: [] });
    const resp = auth.makeAttestation({ challenge, origin: LIVE, rpId: "thakeen.com", ...bend });
    expect(await verifyRegistration(resp, challenge)).toEqual({ ok: false, reason: "invalid" });
  });

  it("a registration whose response id differs from the credential id in the authenticator data is refused", async () => {
    const auth = softAuthenticator();
    const { challenge } = await registrationOptions({ uid: uid(), userName: "a@example.com", displayName: "A", exclude: [] });
    const resp = auth.makeAttestation({ challenge, origin: LIVE, rpId: "thakeen.com" });
    const other = randomBytes(32).toString("base64url");
    resp.id = other;
    resp.rawId = other;
    expect(await verifyRegistration(resp, challenge)).toEqual({ ok: false, reason: "invalid" });
  });

  it("junk never throws, and the log line carries no value from the response", async () => {
    for (const junk of [null, undefined, "x", 42, {}, { id: "x", response: {} }, []]) {
      expect(await verifyRegistration(junk, "c".repeat(43))).toEqual({ ok: false, reason: "invalid" });
    }
    const auth = softAuthenticator();
    const secretChallenge = randomBytes(32).toString("base64url");
    await verifyRegistration(auth.makeAttestation({ challenge: secretChallenge, origin: LIVE, rpId: "thakeen.com" }), "other");
    expect(warn).toHaveBeenCalledWith("webauthn reg invalid");
    for (const call of warn.mock.calls) {
      expect(call).toEqual(["webauthn reg invalid"]);
      expect(JSON.stringify(call)).not.toContain(secretChallenge);
      expect(JSON.stringify(call)).not.toContain(auth.credId);
    }
  });
});

describe("rule 2409: sign-in options and assertion verification (real crypto)", () => {
  it("options name no credential and ask for user verification", async () => {
    const { options, challenge } = await authenticationOptions();
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe("thakeen.com");
    expect(options.challenge).toBe(challenge);
    // As long as the challenge lives, so the browser never ends a waiting conditional request first (fix round 2, N4).
    expect(options.timeout).toBe(300_000);
  });

  it("an assertion signed by the registered key verifies with the new counter and the user handle", async () => {
    const { auth, handle, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    const r = await verifyAuthentication(auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 7 }), challenge, cred);
    expect(r).toEqual({ ok: true, newCounter: 7, userHandle: handle });
  });

  it("a counter of 0 passes the seam (the counter rule lives in passkeys.ts, rule 2421)", async () => {
    const { auth, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    const r = await verifyAuthentication(auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 0 }), challenge, cred);
    expect(r).toMatchObject({ ok: true, newCounter: 0 });
  });

  it("userHandle is null when the authenticator sends none or a malformed one, never undefined", async () => {
    const { auth, cred } = await enrolled();
    const a = await authenticationOptions();
    const none = await verifyAuthentication(auth.makeAssertion({ challenge: a.challenge, origin: LIVE, rpId: "thakeen.com", userHandle: null }), a.challenge, cred);
    expect(none).toEqual({ ok: true, newCounter: 0, userHandle: null });
    const b = await authenticationOptions();
    const bad = await verifyAuthentication(auth.makeAssertion({ challenge: b.challenge, origin: LIVE, rpId: "thakeen.com", userHandle: "not base64url!" }), b.challenge, cred);
    expect(bad).toEqual({ ok: true, newCounter: 0, userHandle: null });
  });

  it("an assertion signed by a second key under the same credential id is refused", async () => {
    const { auth, cred } = await enrolled();
    const thief = softAuthenticator({ credId: auth.credId });
    const { challenge } = await authenticationOptions();
    const r = await verifyAuthentication(thief.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 1 }), challenge, cred);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("an assertion for another credential id than the stored one is refused", async () => {
    const { auth, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    const other = randomBytes(32).toString("base64url");
    const r = await verifyAuthentication(auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", credId: other }), challenge, cred);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    ["UV off", { uv: false }],
    ["another origin", { origin: STAGING }],
    ["another RP ID", { rpId: "staging.thakeen.com" }],
    ["another challenge", { challenge: randomBytes(32).toString("base64url") }],
  ])("%s is refused", async (_, bend) => {
    const { auth, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    const r = await verifyAuthentication(auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 1, ...bend }), challenge, cred);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("a tampered clientDataJSON (signature no longer covers it) is refused, and the log names no value", async () => {
    const { auth, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    const resp: AssertionJSON = auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 1 });
    const cd = JSON.parse(Buffer.from(resp.response.clientDataJSON, "base64url").toString("utf8")) as Record<string, unknown>;
    resp.response.clientDataJSON = Buffer.from(JSON.stringify({ ...cd, extra: "x" }), "utf8").toString("base64url");
    warn.mockClear();
    expect(await verifyAuthentication(resp, challenge, cred)).toEqual({ ok: false, reason: "invalid" });
    expect(warn.mock.calls).toEqual([["webauthn auth invalid"]]);
  });

  it("junk input and a broken stored key never throw", async () => {
    const { auth, cred } = await enrolled();
    const { challenge } = await authenticationOptions();
    for (const junk of [null, "x", {}, { id: cred.id }, { id: cred.id, rawId: cred.id, response: {} }]) {
      expect(await verifyAuthentication(junk, challenge, cred)).toEqual({ ok: false, reason: "invalid" });
    }
    const good = auth.makeAssertion({ challenge, origin: LIVE, rpId: "thakeen.com", counter: 1 });
    expect(await verifyAuthentication(good, challenge, { ...cred, pk: "AAAA" })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("responseId", () => {
  it("answers the id only when it is base64url of 16 to 1366 characters", () => {
    const id = randomBytes(32).toString("base64url");
    expect(responseId({ id })).toBe(id);
    expect(responseId({ id: "A".repeat(16) })).toBe("A".repeat(16));
    expect(responseId({ id: "A".repeat(1366) })).toBe("A".repeat(1366));
    for (const bad of [null, undefined, "x", 1, {}, { id: 5 }, { id: "A".repeat(15) }, { id: "A".repeat(1367) }, { id: "a+b/c=".repeat(4) }, { id: `${id}\n` }]) {
      expect(responseId(bad)).toBeNull();
    }
  });
});

describe("rule 2406: RP ID and origin come from appOrigin(), never from the request", () => {
  it("with APP_ORIGIN = staging, rp() answers that host and origin, and the options carry it", async () => {
    vi.stubEnv("APP_ORIGIN", STAGING);
    expect(rp()).toEqual({ id: "staging.thakeen.com", origin: STAGING, name: "Thakeen" });
    expect((await authenticationOptions()).options.rpId).toBe("staging.thakeen.com");
    expect((await registrationOptions({ uid: uid(), userName: "a@example.com", displayName: "A", exclude: [] })).options.rp.id).toBe("staging.thakeen.com");
  });

  it("on staging, a registration or an assertion built for https://thakeen.com fails; one built for staging passes", async () => {
    vi.stubEnv("APP_ORIGIN", STAGING);
    const auth = softAuthenticator();
    const reg = await registrationOptions({ uid: uid(), userName: "a@example.com", displayName: "A", exclude: [] });
    expect(await verifyRegistration(auth.makeAttestation({ challenge: reg.challenge, origin: LIVE, rpId: "thakeen.com" }), reg.challenge)).toEqual({ ok: false, reason: "invalid" });
    // The origin alone differs (RP ID right): still refused, so no second origin is ever accepted.
    expect(await verifyRegistration(auth.makeAttestation({ challenge: reg.challenge, origin: LIVE, rpId: "staging.thakeen.com" }), reg.challenge)).toEqual({ ok: false, reason: "invalid" });
    const good = await verifyRegistration(auth.makeAttestation({ challenge: reg.challenge, origin: STAGING, rpId: "staging.thakeen.com" }), reg.challenge);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const cred = { id: good.cred.id, pk: good.cred.pk, transports: good.cred.transports };
    const a = await authenticationOptions();
    expect(await verifyAuthentication(auth.makeAssertion({ challenge: a.challenge, origin: LIVE, rpId: "thakeen.com", counter: 1 }), a.challenge, cred)).toEqual({ ok: false, reason: "invalid" });
    const o = await authenticationOptions();
    expect(await verifyAuthentication(auth.makeAssertion({ challenge: o.challenge, origin: LIVE, rpId: "staging.thakeen.com", counter: 1 }), o.challenge, cred)).toEqual({ ok: false, reason: "invalid" });
    const b = await authenticationOptions();
    expect(await verifyAuthentication(auth.makeAssertion({ challenge: b.challenge, origin: STAGING, rpId: "staging.thakeen.com", counter: 1 }), b.challenge, cred)).toMatchObject({ ok: true });
  });

  it("the seam reads no request: no headers, Request, Host or forwarded names in its source", () => {
    const src = readFileSync("src/lib/webauthn.ts", "utf8");
    expect(src).not.toMatch(/\bheaders\b/);
    expect(src).not.toMatch(/\b(?:Next)?Request\b/);
    expect(src).not.toMatch(/x-forwarded|["']host["']|["']origin["']/i);
    expect(src).not.toMatch(/process\.env/);
    expect(src).toMatch(/appOrigin\(\)/);
  });
});

describe("rule 2427: where the library may be imported, and exact versions", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(n) ? [p] : [];
  });
  const all = files("src");

  it("only src/lib/webauthn.ts names @simplewebauthn/server", () => {
    const hits = all.filter((p) => /["'`]@simplewebauthn\/server(?:\/[^"'`]*)?["'`]/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([join("src", "lib", "webauthn.ts")]);
  });

  it("@simplewebauthn/browser is named only by files that start with \"use client\"", () => {
    const hits = all.filter((p) => /["'`]@simplewebauthn\/browser(?:\/[^"'`]*)?["'`]/.test(readFileSync(p, "utf8")));
    const notClient = hits.filter((p) => !/^\s*["']use client["'];?/.test(readFileSync(p, "utf8")));
    expect(notClient).toEqual([]);
  });

  it("both packages are runtime dependencies pinned to an exact version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of ["@simplewebauthn/server", "@simplewebauthn/browser"]) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.devDependencies[name]).toBeUndefined();
    }
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/@simplewebauthn/server"]?.version).toBe(pkg.dependencies["@simplewebauthn/server"]);
    expect(lock.packages["node_modules/@simplewebauthn/browser"]?.version).toBe(pkg.dependencies["@simplewebauthn/browser"]);
  });
});
