import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as listRoute from "@/app/api/workspaces/route";
import { getUser, sessionKey } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { claimSlug, releaseSlug, RESERVED_SLUGS, SLUG_RE, slugAllowed, slugCandidates, slugify, transliterate } from "@/lib/ws-slug";
import { addShadowMembership, json, newUser, signIn } from "./helpers/session";
import { ownerOf } from "@/lib/membership";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Rules 3504-3505: a readable, unique slug from a workspace's name. Arabic is transliterated, anything unusable becomes a
 * random `ws-` name, uniqueness is one atomic SET NX per candidate (never a scan), and reserved words (every route folder,
 * locales, our names, staff and abuse words) are never given out.
 */

describe("rule 3504: slugify", () => {
  it("transliterates Arabic and drops accents and diacritics", () => {
    expect(slugify("متجر الورد")).toBe("mtjr-alwrd");
    expect(slugify("Café Noir")).toBe("cafe-noir");
    expect(slugify("مَكتَبة")).toBe("mktba");
    expect(slugify("متجر ٢٤")).toBe("mtjr-24");
    expect(transliterate("ـــشـــاي")).toBe("shay");
  });

  it("is lowercase Latin, digits and single inner hyphens, 3 to 32 characters, cut at a hyphen", () => {
    expect(slugify("  Hello,   World!!  ")).toBe("hello-world");
    expect(slugify("ab")).toBe("");
    expect(slugify("🌹🌹🌹")).toBe("");
    const long = slugify("the quick brown fox jumps over the lazy dog again");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(SLUG_RE);
    expect(long.endsWith("-")).toBe(false);
    for (const s of ["a-b", "abc", "a1-b2-c3"]) expect(s).toMatch(SLUG_RE);
    for (const s of ["-ab", "ab-", "a--b", "AB", "a_b", "ab"]) expect(s).not.toMatch(SLUG_RE);
  });

  it("an unusable or reserved name goes straight to the random fallback", () => {
    for (const name of ["🌹", "a", "Admin", "API", "  Support  "]) {
      const c = slugCandidates(name);
      expect(c[0]).toMatch(/^ws-[a-z0-9]{6}$/);
      for (const s of c) expect(slugAllowed(s)).toBe(true);
    }
    const c = slugCandidates("Rose Shop");
    expect(c[0]).toBe("rose-shop");
    expect(c[1]).toMatch(/^rose-shop-[a-z0-9]{4}$/);
    expect(c.at(-1)).toMatch(/^ws-[a-z0-9]{6}$/);
  });
});

describe("rule 3504: unique by SET NX, in one round", () => {
  it("the first claim wins the base; a second account with the same name gets a different slug", async () => {
    const name = `Twin Shop ${Date.now().toString(36)}`;
    const a = await claimSlug(name, "a_aaaaaaaaaaaaaaaaaaaaaaaa");
    const b = await claimSlug(name, "a_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(a).toBe(slugify(name));
    expect(b).not.toBe(a);
    expect(b).toMatch(SLUG_RE);
    expect(await db.get(globalKey.wsSlug(a!))).toBe("a_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(await db.get(globalKey.wsSlug(b!))).toBe("a_bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("parallel claims of one name never share a slug, and the losers' extra wins are released", async () => {
    const name = `Race Shop ${Date.now().toString(36)}`;
    const ids = Array.from({ length: 6 }, (_, i) => `a_${String(i).repeat(24)}`);
    const got = await Promise.all(ids.map((id) => claimSlug(name, id)));
    const won = got.filter(Boolean) as string[];
    expect(new Set(won).size).toBe(won.length);
    const owners = await Promise.all(won.map((s) => db.get(globalKey.wsSlug(s))));
    won.forEach((_, i) => expect(owners[i]).toBe(ids[got.indexOf(won[i])]));
    // Every slug key for this base names exactly one of the accounts that kept it.
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;
    const keys = [...mem.kv.keys()].filter((k) => k.startsWith(`wsslug:${slugify(name)}`));
    expect(keys.length).toBe(won.filter((s) => s.startsWith(slugify(name))).length);
  });

  it("claims in one Promise.all and releases only its own slug: no await in a loop, no scan", async () => {
    const src = readFileSync("src/lib/ws-slug.ts", "utf8");
    expect(src).toContain("Promise.all(cands.map((s) => db.setNx(");
    expect(src).not.toMatch(/db\.(scan|keys)\(/);
    await claimSlug("Keep Mine Shop", "a_cccccccccccccccccccccccc");
    await releaseSlug("keep-mine-shop", "a_dddddddddddddddddddddddd");
    expect(await db.get(globalKey.wsSlug("keep-mine-shop"))).toBe("a_cccccccccccccccccccccccc");
    await releaseSlug("keep-mine-shop", "a_cccccccccccccccccccccccc");
    expect(await db.get(globalKey.wsSlug("keep-mine-shop"))).toBeNull();
  });

  it("a new workspace stores its slug, the list shows it, and wiping the account releases it", async () => {
    const u = await newUser("wsl", { shadow: false });
    await addShadowMembership(ownerOf(u), u.createdAt);
    const token = await signIn(u.email);
    const r = await listRoute.POST(json("/api/workspaces", "POST", { name: "مخبز السعادة", lang: "ar" }));
    expect(r.status).toBe(200);
    const aid = (await db.get<{ acct: string }>(sessionKey(token)))!.acct;
    const made = (await getUser(aid))!;
    expect(made.workspaceSlug).toMatch(/^mkhbz-alsaada(-[a-z0-9]{4})?$|^ws-[a-z0-9]{6}$/);
    expect(await db.get(globalKey.wsSlug(made.workspaceSlug!))).toBe(aid);
    const list = (await (await listRoute.GET()).json()) as { workspaces: { slug?: string }[] };
    expect(list.workspaces.map((w) => w.slug)).toContain(made.workspaceSlug);
    await wipeAccount(aid);
    expect(await db.get(globalKey.wsSlug(made.workspaceSlug!))).toBeNull();
  });
});

describe("rule 3505: reserved slugs", () => {
  /** Every static top-level route folder (its first dot part: `llms.txt` → `llms`). */
  const folders = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^[[(_@]/.test(d.name))
      .map((d) => d.name.split(".")[0].toLowerCase());

  it("every route folder under src/app, src/app/[lang] and src/app/[lang]/app is reserved", () => {
    const all = ["src/app", path.join("src/app", "[lang]"), path.join("src/app", "[lang]", "app")].flatMap(folders);
    expect(all.length).toBeGreaterThan(20);
    const missing = all.filter((f) => !RESERVED_SLUGS.has(f));
    expect(missing).toEqual([]);
  });

  it("covers the short segments, locales, our names and staff words", () => {
    for (const s of ["app", "api", "admin", "w", "b", "ar", "en", "login", "help", "blog", "settings", "thakeen", "zakeen", "support", "official", "staff", "abuse", "root"]) {
      expect(RESERVED_SLUGS.has(s)).toBe(true);
      expect(slugAllowed(s)).toBe(false);
    }
  });

  it("is display only: the request selector stays the w_ handle", () => {
    const wsPath = readFileSync("src/lib/ws-path.ts", "utf8");
    expect(wsPath).not.toContain("wsSlug");
    expect(readFileSync("src/lib/ws-handle.ts", "utf8")).not.toContain("wsslug");
  });
});
