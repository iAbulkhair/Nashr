import { describe, expect, it } from "vitest";
import { newUser } from "./helpers/session";
import { getUser, saveUser } from "@/lib/auth";
import { addBrand, scopeFor } from "@/lib/brands";
import { db } from "@/lib/db";
import { wipeAccount } from "@/lib/account";
import { getPerf } from "@/lib/perf-store";
import { getSalesSnapshot, getSyncFailure } from "@/lib/store-sales";
import { AD_PROVIDERS } from "@/lib/connectors/ads";

/**
 * Rule 637: the per-brand snapshots read from a connected store or ad account (the store's sales snapshot and its
 * failure note, the campaign results, each ad platform's last read time) go with the account, for every brand.
 */
describe("store and ad snapshots go with the account (rule 637)", () => {
  it("wipeAccount deletes storesales, storesyncfail, perfimport and every adsync key of every brand", async () => {
    const u = await newUser("snap-wipe");
    await saveUser({ ...(await getUser(u.email))!, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scopes = [u.email, scopeFor(u.email, second.id)];
    const keys = scopes.flatMap((s) => [`storesales:${s}`, `storesyncfail:${s}`, `perfimport:${s}`, ...AD_PROVIDERS.map((p) => `adsync:${s}:${p}`)]);
    await Promise.all(
      scopes.flatMap((s) => [
        db.set(`storesales:${s}`, { orders: 3, revenue: 120 }),
        db.set(`storesyncfail:${s}`, { at: "2026-10-05T00:00:00.000Z", provider: "salla", error: "http_500" }, 3600),
        db.set(`perfimport:${s}`, { rows: 1 }),
        ...AD_PROVIDERS.map((p) => db.set(`adsync:${s}:${p}`, "2026-10-05T00:00:00.000Z")),
      ]),
    );
    // The readers use the same key names as the seed above.
    expect(await getSalesSnapshot(scopes[1])).not.toBeNull();
    expect(await getSyncFailure(scopes[1])).not.toBeNull();
    expect(await getPerf(scopes[1])).not.toBeNull();

    await wipeAccount(u.email);

    expect(await Promise.all(keys.map((k) => db.get(k)))).toEqual(keys.map(() => null));
    for (const s of scopes) {
      expect(await getSalesSnapshot(s)).toBeNull();
      expect(await getSyncFailure(s)).toBeNull();
      expect(await getPerf(s)).toBeNull();
    }
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;
    expect([...mem.kv.keys()].filter((k) => /^(storesales|storesyncfail|perfimport|adsync):/.test(k) && k.includes(u.email))).toEqual([]);
  });
});
