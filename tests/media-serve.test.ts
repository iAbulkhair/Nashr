import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { newMember, newUser, signIn, signOut } from "./helpers/session";
import { ipHeaders, mediaEnv, resetMediaCounters } from "./helpers/media";
import { GET, HEAD } from "@/app/m/[name]/route";
import { writeToStore } from "@/lib/media/store";
import { SHARE_TTL_S, shareUrl, shareValid } from "@/lib/media/share";
import { acct, sc, type User } from "@/lib/auth";

/**
 * Our media files are private by default (rules 1754-1758): `/m/{name}` serves a file to a signed-in member of the
 * workspace whose index holds it, or to a short signed link minted at hand-off, and answers everything else with the
 * same bare 404. Range requests work for video players; the headers keep a file from ever running as a page.
 */
let owner: User;
let other: User;
let ip = 1;
const BODY = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), randomBytes(1000)]);
const nameOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const call = (name: string, query = "", headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") =>
  (method === "GET" ? GET : HEAD)(new NextRequest(`https://thakeen.com/m/${name}${query}`, { method, headers: { ...ipHeaders(ip), ...headers } }), ctx(name));
const store = async (scope: string) => nameOf((await writeToStore(BODY, "video", { scope, taskId: "t1" })).url);

beforeAll(async () => {
  owner = await newUser("mserve");
  other = await newUser("mserveother");
});
beforeEach(() => {
  resetMediaCounters();
  mediaEnv({ store: true });
  vi.stubEnv("CONNECT_SECRET", "a-test-connect-secret-for-media-share");
  ip++;
  signOut();
});
afterEach(() => vi.unstubAllEnvs());

describe("who may read a file (rule 1754)", () => {
  it("a signed-in member of the owning workspace gets it; everyone else gets the same bare 404", async () => {
    const name = await store(sc(owner));
    await signIn(owner.email);
    const ok = await call(name);
    expect(ok.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await ok.arrayBuffer()), BODY)).toBe(0);

    const missing = `${"f".repeat(32)}.mp4`;
    const answers = [];
    signOut();
    answers.push(await call(name));
    await signIn(other.email);
    answers.push(await call(name), await call(missing));
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("a team member sees the owner's workspace files", async () => {
    const name = await store(sc(owner));
    const m = await newMember(owner, "member", "mservem");
    await signIn(m.email);
    expect((await call(name)).status).toBe(200);
  });

  it("an index entry with no file on disk is a 404, not an error", async () => {
    const name = await store(sc(owner));
    await fs.unlink(path.join(process.env.MEDIA_DIR!, name.slice(0, 2), name));
    await signIn(owner.email);
    expect((await call(name)).status).toBe(404);
  });

  it("refuses every name that is not a store name before touching the disk or the index", async () => {
    await signIn(owner.email);
    for (const bad of ["..%2F..%2Fetc%2Fpasswd", "../x", `${"A".repeat(32)}.jpg`, `${"a".repeat(32)}.png`, `${"a".repeat(31)}.jpg`, `${"a".repeat(32)}.jpg.`, ".sentinel", ".tmp", ""]) {
      expect((await call(bad)).status, bad).toBe(404);
    }
  });
});

describe("signed share links (rule 1755)", () => {
  it("a fresh link opens the file with no session, for that name only, and is never cached", async () => {
    const name = await store(sc(owner));
    const signed = shareUrl(`https://thakeen.com/m/${name}`);
    const q = signed.slice(signed.indexOf("?"));
    const r = await call(name, q);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const second = await store(sc(owner));
    expect((await call(second, q)).status, "the signature names one file").toBe(404);
  });

  it("expired, forged, too-long and half links are the bare 404; a session does not rescue a bad signature", async () => {
    const name = await store(sc(owner));
    const now = Date.now();
    const sig = (exp: number) => new URL(shareUrl(`https://thakeen.com/m/${name}`, exp * 1000 - SHARE_TTL_S * 1000)).searchParams.get("sig")!;
    const past = Math.floor(now / 1000) - 10;
    const far = Math.floor(now / 1000) + SHARE_TTL_S + 3600;
    await signIn(owner.email);
    for (const q of [`?exp=${past}&sig=${sig(past)}`, `?exp=${far}&sig=${sig(far)}`, `?exp=${past + 20}&sig=AAAA`, `?sig=${sig(past)}`, `?exp=${past}`, "?exp=abc&sig=x"]) {
      expect((await call(name, q)).status, q).toBe(404);
    }
  });

  it("the key is derived from CONNECT_SECRET with a fixed label, and rotating it ends every link", () => {
    const name = `${"a".repeat(32)}.jpg`;
    const now = 1_800_000_000_000;
    const url = new URL(shareUrl(`https://thakeen.com/m/${name}`, now));
    const exp = url.searchParams.get("exp")!;
    expect(Number(exp)).toBe(now / 1000 + SHARE_TTL_S);
    const key = createHmac("sha256", "a-test-connect-secret-for-media-share").update("media-share:v1").digest();
    expect(url.searchParams.get("sig")).toBe(createHmac("sha256", key).update(`${name}.${exp}`).digest("base64url"));
    expect(url.searchParams.get("sig")).not.toContain("a-test-connect-secret");
    expect(shareValid(name, exp, url.searchParams.get("sig"), now)).toBe(true);
    vi.stubEnv("CONNECT_SECRET", "a-rotated-secret");
    expect(shareValid(name, exp, url.searchParams.get("sig"), now)).toBe(false);
  });

  it("only a disk-store URL is signed; a legacy Blob copy, a fal link and undefined pass unchanged", () => {
    for (const u of ["https://abc.public.blob.vercel-storage.com/media/x.jpg", "https://v3.fal.media/files/x.jpg", undefined]) expect(shareUrl(u)).toBe(u);
  });
});

describe("headers, ranges and HEAD (rules 1756-1757)", () => {
  it("never runs as a page, never indexed, inline unless download=1, and private-cached for a member", async () => {
    const name = await store(sc(owner));
    await signIn(owner.email);
    const r = await call(name);
    expect(Object.fromEntries(["content-type", "content-security-policy", "x-content-type-options", "x-robots-tag", "content-disposition", "cache-control", "accept-ranges", "content-length"].map((h) => [h, r.headers.get(h)]))).toEqual({
      "content-type": "video/mp4",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      "content-disposition": "inline",
      "cache-control": "private, max-age=86400",
      "accept-ranges": "bytes",
      "content-length": String(BODY.length),
    });
    expect((await call(name, "?download=1")).headers.get("content-disposition")).toBe(`attachment; filename="thakeen-${name.slice(0, 8)}.mp4"`);
    const etag = r.headers.get("etag")!;
    expect((await call(name, "", { "if-none-match": etag })).status).toBe(304);
  });

  it("answers one range with 206, an unsatisfiable one with 416, and several with the whole file", async () => {
    const name = await store(sc(owner));
    await signIn(owner.email);
    const part = await call(name, "", { range: "bytes=4-11" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${BODY.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("ftypisom");
    const tail = await call(name, "", { range: "bytes=-10" });
    expect(Buffer.compare(Buffer.from(await tail.arrayBuffer()), BODY.subarray(-10))).toBe(0);
    const open = await call(name, "", { range: `bytes=${BODY.length - 3}-` });
    expect(open.headers.get("content-length")).toBe("3");
    const bad = await call(name, "", { range: `bytes=${BODY.length}-` });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${BODY.length}`);
    expect((await call(name, "", { range: "bytes=-0" })).status).toBe(416);
    const multi = await call(name, "", { range: "bytes=0-1,4-5" });
    expect(multi.status).toBe(200);
    expect(multi.headers.get("content-length")).toBe(String(BODY.length));
  });

  it("HEAD answers the headers with no body, under the same checks", async () => {
    const name = await store(sc(owner));
    expect((await call(name, "", {}, "HEAD")).status).toBe(404);
    await signIn(owner.email);
    const h = await call(name, "", {}, "HEAD");
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(String(BODY.length));
    expect(await h.text()).toBe("");
  });
});

describe("rate limit (rule 1758)", () => {
  it("1200 requests an hour per IP, counted before the name is even checked", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    const { allow } = await import("@/lib/rate");
    const { WINDOW } = await import("@/lib/rate");
    for (let i = 0; i < 1200; i++) await allow(`mfile:203.0.113.${ip}`, 1200, WINDOW.hour);
    const r = await call("not-a-name");
    expect(r.status).toBe(429);
  });
});

describe("account deletion takes the files with it (rule 1761)", () => {
  it("wipeAccount removes the owner's files from disk and the index, and leaves another account's alone", async () => {
    const { wipeAccount } = await import("@/lib/account");
    const { db } = await import("@/lib/db");
    const { MEDIA_KEYS, mediaPath } = await import("@/lib/media/store");
    const gone = await newUser("mservewipe");
    const mine = await store(sc(gone));
    const theirs = await store(sc(other));
    await wipeAccount(acct(gone));
    await expect(fs.stat(mediaPath(mine)!)).rejects.toThrow();
    expect(await db.get(MEDIA_KEYS.entry(sc(gone), mine))).toBeNull();
    expect(await db.smembers(MEDIA_KEYS.names(sc(gone)))).toEqual([]);
    expect((await fs.stat(mediaPath(theirs)!)).isFile()).toBe(true);
    await signIn(other.email);
    expect((await call(theirs)).status).toBe(200);
  });
});
