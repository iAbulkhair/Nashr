import { describe, expect, it, vi, afterEach } from "vitest";

// safeFetch resolves every hop before it connects; the test hosts are not real, so the resolver answers with a public
// address. Without this the guard rejects them as "dns" before any redirect logic runs.
vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
import { safeName, listFiles, readFile, writeFile } from "@/lib/files";
import { newUser } from "./helpers/session";

describe("workspace file names survive Arabic (P1: silent overwrite)", () => {
  it("two different Arabic names do not collapse onto the same key", () => {
    const a = safeName("ملاحظات.md");
    const b = safeName("خطة-التسويق.md");
    // Before the fix both were "-.md", so writing the second destroyed the first.
    expect(a).not.toBe(b);
    expect(a).not.toBe("-.md");
    expect(b).not.toBe("-.md");
  });

  it("keeps the Arabic letters rather than stripping them", () => {
    expect(safeName("ملاحظات.md")).toContain("ملاحظات");
  });

  it("still normalises ASCII exactly as before", () => {
    expect(safeName("notes.md")).toBe("notes.md");
    expect(safeName("My Notes.MD")).toBe("my-notes.md");
    expect(safeName("a//b\\c.md")).toBe("a-b-c.md");
    expect(safeName("")).toBe("file.md");
  });

  it("never emits a character that could split a Redis key", () => {
    for (const n of ["a:b.md", "a#b.md", "مل:ف#.md", "../../etc/passwd"]) {
      const s = safeName(n);
      expect(s).not.toContain(":");
      expect(s).not.toContain("#");
      expect(s).not.toContain("/");
    }
  });

  it("two Arabic files coexist in one workspace", async () => {
    const u = await newUser("arabicfiles");
    await writeFile(u.email, "ملاحظات.md", "الأول", "user");
    await writeFile(u.email, "خطة.md", "الثاني", "user");
    const names = (await listFiles(u.email)).map((f) => f.name);
    expect(names).toHaveLength(2);
    expect((await readFile(u.email, "ملاحظات.md"))!.content).toBe("الأول");
    expect((await readFile(u.email, "خطة.md"))!.content).toBe("الثاني");
  });
});

describe("safeFetch does not carry credentials across hosts (P1: credential leak)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("drops Authorization when a redirect changes the host", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ url, auth });
      if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { safeFetch } = await import("@/lib/safe-fetch");
    await safeFetch("https://shop.example/wp-json/wc/v3/products", { headers: { Authorization: "Basic c2VjcmV0OnNlY3JldA==" } });

    expect(seen).toHaveLength(2);
    expect(seen[0].auth, "the store the owner configured gets its own credential").toBe("Basic c2VjcmV0OnNlY3JldA==");
    expect(seen[1].auth, "a different host must never receive it").toBeNull();
  });

  it("keeps Authorization when the redirect stays on the same host", async () => {
    const seen: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (seen.length === 1) return new Response(null, { status: 301, headers: { location: "https://shop.example/wp-json/wc/v3/products/" } });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { safeFetch } = await import("@/lib/safe-fetch");
    await safeFetch("https://shop.example/wp-json/wc/v3/products", { headers: { Authorization: "Basic x" } });
    expect(seen).toEqual(["Basic x", "Basic x"]);
  });
});

describe("deleting a conversation frees its slot in the index (P1: live threads vanish)", () => {
  it("a deleted id does not keep occupying the 100-entry window", async () => {
    const { createConversation, deleteConversation, listConversations } = await import("@/lib/conversations");
    const { db } = await import("@/lib/db");
    const scope = "convs-scope@test.example";

    // Create and delete 100 conversations, then create one more. The index reads only the newest 100 ids, so if the
    // deleted ones keep their slots the survivor is pushed out of the window and disappears from the owner's list.
    for (let i = 0; i < 100; i++) {
      const c = await createConversation(scope, `gone ${i}`);
      await deleteConversation(scope, c.id);
    }
    const survivor = await createConversation(scope, "still here");

    expect(await db.lrange(`convs:${scope}`, 0, -1), "dead ids must not accumulate").toHaveLength(1);
    const list = await listConversations(scope);
    expect(list.map((c) => c.id)).toEqual([survivor.id]);
  });
});

describe("share-for-credits is granted once (P1: credit minting)", () => {
  it("ten concurrent claims for one platform grant the bonus exactly once", async () => {
    const u = await newUser("share");
    const { getUser } = await import("@/lib/auth");
    const share = await import("@/app/api/referral/share/route");
    const { signIn, json } = await import("./helpers/session");
    await signIn(u.email);

    const results = await Promise.all(Array.from({ length: 10 }, () => share.POST(json("/api/referral/share", "POST", { platform: "x" }))));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as { credited: number }[];
    const granted = bodies.reduce((sum, b) => sum + (b.credited ?? 0), 0);

    const { SHARE_CREDITS } = await import("@/lib/referral");
    expect(granted, "the bonus is once per platform, however many requests race").toBe(SHARE_CREDITS);
    expect((await getUser(u.email))!.credits).toBe(50 + SHARE_CREDITS);
  });
});

describe("deleting an account leaves nothing behind (P1: re-registering inherits data)", () => {
  it("no key anywhere in the store still mentions the address", async () => {
    const u = await newUser("wipe-all");
    const email = u.email;

    // Exercise the account across the features that write account-level keys, not just brand-scoped ones.
    const [{ saveBrand }, { writeFile }, { pushNotif }, { registerCode, applyReferral }, { track }, { meter }, { markSent }, { createConversation }, { db }, { wipeAccount }] = await Promise.all([
      import("@/lib/brand"), import("@/lib/files"), import("@/lib/notifications"), import("@/lib/referral"),
      import("@/lib/track"), import("@/lib/usage"), import("@/lib/notify"), import("@/lib/conversations"),
      import("@/lib/db"), import("@/lib/account"),
    ]);
    await saveBrand(email, { name: "X", website: "", industry: "i", dialect: "saudi", languages: ["ar"], tone: "", products: "p", audience: "a", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: new Date().toISOString() });
    await writeFile(email, "notes.md", "content", "user");
    await createConversation(email, "thread");
    await pushNotif(email, { kind: "weekly", agent: "noor", title: "t", body: "b", href: "" });
    await registerCode(email);
    await track(email, "generate");
    await meter(email, "claude-opus-5-5", "generate", { input_tokens: 10, output_tokens: 10 });
    await markSent(email, "nudge1");
    await db.sadd(`shared:${email}`, "x");

    const referrer = await newUser("wipe-ref");
    await registerCode(referrer.email);
    await applyReferral(email, (await import("@/lib/referral")).codeFor(referrer.email));

    await wipeAccount(email);

    // The memory adapter exposes every key it holds, so this catches anything added later too.
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>>; hashes: Map<string, Map<string, unknown>> } }).__nashrMem;
    const all = [...mem.kv.keys(), ...mem.lists.keys(), ...mem.sets.keys(), ...mem.hashes.keys()];
    const residue = all.filter((k) => k.includes(email) && mem.kv.get(k) !== null);

    expect(residue, `keys still holding this account's data: ${residue.join(", ")}`).toEqual([]);
  });
});
