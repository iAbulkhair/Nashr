import { expect } from "vitest";
import { getLogin } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey, personKey, type PersonId } from "@/lib/keys";
import { addPasskey, ensureUid } from "@/lib/passkeys";
import { getPerson } from "@/lib/person";
import * as optionsRoute from "@/app/api/auth/passkey/options/route";
import * as verifyRoute from "@/app/api/auth/passkey/verify/route";
import { json } from "./session";
import { softAuthenticator, type SoftAuthenticator } from "./soft-authenticator";

/**
 * Passkey fixtures shared by the wipe and move tests (customer passkeys, Task 6, rules 2402, 2424, 2425): a person's set
 * of real soft-authenticator credentials written through the store, an open registration, a scan of the memory store
 * for every passkey key a person still has, and a sign-in through the two public routes. A test that signs in stubs
 * `APP_ORIGIN` to `PASSKEY_ORIGIN` (the RP ID is its host).
 */

export const PASSKEY_ORIGIN = "https://thakeen.com";
export const PASSKEY_RP = "thakeen.com";

export type Enrolled = { pid: PersonId; uid: string; born: string; softs: SoftAuthenticator[] };

/**
 * `count` passkeys (default two) for the login at `email`, through `ensureUid` and `addPasskey` as the settings route
 * writes them, with the person's own birth, and an open registration `pkreg:{pid}` (300 s) unless `reg` is false.
 */
export async function enrolPasskeys(email: string, { count = 2, reg = true }: { count?: number; reg?: boolean } = {}): Promise<Enrolled> {
  const login = await getLogin(email);
  if (!login) throw new Error("enrolPasskeys: no login");
  const pid = login.pid;
  const born = (await getPerson(pid))!.createdAt;
  const u = await ensureUid(pid, born);
  if (u === "invalid") throw new Error("enrolPasskeys: ensureUid answered invalid");
  const softs = Array.from({ length: count }, () => softAuthenticator());
  // Sequential: each add takes the person lock anyway.
  for (const [i, s] of softs.entries()) {
    const r = await addPasskey(pid, born, { id: s.credId, pk: s.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, `Key ${i + 1}`);
    expect(r).toMatchObject({ ok: true });
  }
  if (reg) await db.set(personKey.passkeyReg(pid), { challenge: "open-registration-challenge", sess: "0".repeat(64), at: Date.now() }, 300);
  return { pid, uid: u.uid, born, softs };
}

/**
 * Every passkey key of `pid` left in the memory store: `passkeys:{pid}`, `pkreg:{pid}` and each `pkcred:` entry whose value
 * names the pid (a scan of the whole store, so an entry the set no longer lists is found too).
 */
export function passkeyResidue(pid: PersonId): string[] {
  const kv = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem.kv;
  const prefix = globalKey.passkeyCred("");
  const own = new Set([personKey.passkeys(pid), personKey.passkeyReg(pid)]);
  return [...kv.entries()].filter(([k, v]) => own.has(k) || (k.startsWith(prefix) && String(v) === pid)).map(([k]) => k).sort();
}

/** Every `pkcred:` entry naming `pid` (the reverse entries of its set). */
export function reverseEntriesOf(pid: PersonId): string[] {
  const prefix = globalKey.passkeyCred("");
  return passkeyResidue(pid).filter((k) => k.startsWith(prefix));
}

let ipN = 0;
/** A fresh client address per sign-in, so the per-IP buckets never fill up across a file. */
const ip = () => ({ "x-forwarded-for": `198.18.${Math.floor(++ipN / 250) % 250}.${(ipN % 250) + 1}` });

/**
 * Options then verify through the public routes with `soft`'s assertion, carrying `userHandle` and `counter` (each
 * sign-in needs a higher counter than the last one the set stored). The cookie travels in the test jar.
 */
export async function passkeySignIn(soft: SoftAuthenticator, userHandle: string, counter: number): Promise<{ status: number; body: unknown }> {
  const h = ip();
  const o = await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, h));
  expect(o.status).toBe(200);
  const challenge = (await o.json()).options.challenge as string;
  const response = soft.makeAssertion({ challenge, origin: PASSKEY_ORIGIN, rpId: PASSKEY_RP, userHandle, counter });
  const r = await verifyRoute.POST(json("/api/auth/passkey/verify", "POST", { response }, h));
  return { status: r.status, body: await r.json() };
}
