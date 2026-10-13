import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { mediaEnv, noNetwork, resetMediaCounters, tempMediaDir } from "./helpers/media";

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, opts?: { httpsOnly?: boolean }) => Promise<Response>>());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));
vi.mock("@/lib/media/keys", async (orig) => {
  const k = await orig<typeof import("@/lib/media/keys")>();
  return { ...k, abortAfter: vi.fn(k.abortAfter) };
});

import { FULL_AT, MEDIA_KEYS, copyToStore, forgetScopeMedia, mediaPath, probeStore, sniff, storeHasRoom, writeToStore, type MediaEntry } from "@/lib/media/store";
import { mediaDir, storeLimits } from "@/lib/media/config";
import { abortAfter } from "@/lib/media/keys";
import { db } from "@/lib/db";

/**
 * The disk store keeps our own copy of every provider result (spec 4.6, rules 1750-1753, 1761-1762). The source URL is
 * provider output: it is fetched only through safeFetch, capped while it streams, and judged by its magic bytes. Images
 * become one upright JPEG with transparency on white; video bytes are kept as they are. The file name carries no tenant
 * identifier; the owner is in the index, written with the job's own scope.
 */
const SRC = "https://tempfile.provider.example/result/abc";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
const HTML = Buffer.from("<!doctype html><html><body>not an image</body></html>");
const reply = (bytes: Uint8Array, headers: Record<string, string> = {}, status = 200) => new Response(new Uint8Array(bytes), { status, headers });
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).png().toBuffer();
const far = () => Date.now() + 100_000;
const OWNER = { scope: "owner@x.example", taskId: "t1" };
const nameOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
/** Every stored file under MEDIA_DIR, with no .tmp parts or sentinel. */
const filesOnDisk = () => {
  const dir = mediaDir()!;
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== ".tmp").flatMap((d) => readdirSync(path.join(dir, d.name)));
};
const bodyOf = (url: string) => fs.readFile(mediaPath(nameOf(url))!);

let net: ReturnType<typeof noNetwork>;
/** The memory store is shared by the whole file: each test starts with no index. */
function clearIndex() {
  const mem = (globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; sets: Map<string, Set<string>> } }).__nashrMem;
  for (const m of [mem?.kv, mem?.sets]) for (const k of [...(m?.keys() ?? [])]) if (k.startsWith("mfile")) m!.delete(k);
}
beforeEach(() => {
  resetMediaCounters();
  clearIndex();
  safeFetch.mockReset();
  vi.mocked(abortAfter).mockClear();
  mediaEnv({ store: true });
  net = noNetwork();
});
afterEach(() => {
  net.restore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("MEDIA_DIR (rule 1750)", () => {
  it("must be absolute and outside the deployed app, or the store is off", () => {
    expect(mediaDir()).toMatch(/^\//);
    for (const bad of ["media", "./media", "", "   ", path.join(process.cwd(), "media"), process.cwd()]) {
      vi.stubEnv("MEDIA_DIR", bad);
      expect(mediaDir(), bad).toBeNull();
    }
  });

  it("names are checked before any path is built: no traversal, no uppercase, no other extension", () => {
    const n = "0123456789abcdef0123456789abcdef.jpg";
    expect(mediaPath(n)).toBe(path.join(mediaDir()!, "01", n));
    for (const bad of ["../etc/passwd", `../${n}`, n.toUpperCase(), n.replace(".jpg", ".png"), `${n}/x`, `${n}\0`, "%2e%2e", ""]) expect(mediaPath(bad), bad).toBeNull();
  });

  it("creates its folders for the owner only", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    const out = await copyToStore(SRC, "image", far(), OWNER);
    const file = mediaPath(nameOf(out.url))!;
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("magic bytes", () => {
  it("names each format by its first bytes, and nothing else", () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("png");
    expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniff(Buffer.from("GIF89a"))).toBe("gif");
    expect(sniff(MP4)).toBe("mp4");
    expect(sniff(HTML)).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
    expect(sniff(Buffer.from("RIFF"))).toBeNull();
  });
});

describe("copying an image", () => {
  it("turns a transparent PNG into a JPEG on white, not black", async () => {
    const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    safeFetch.mockResolvedValue(reply(transparent, { "content-type": "image/png" }));
    const out = await copyToStore(SRC, "image", far(), OWNER);
    expect(out.contentType).toBe("image/jpeg");
    const body = await bodyOf(out.url);
    expect(sniff(body)).toBe("jpeg");
    expect(out.bytes).toBe(body.length);
    const px = await sharp(body).raw().toBuffer();
    expect([px[0], px[1], px[2]].every((v) => v >= 250), `pixel ${px[0]},${px[1]},${px[2]}`).toBe(true);
  });

  it("shrinks a large image to fit 1440×1920", async () => {
    safeFetch.mockResolvedValue(reply(await png(3000, 3000)));
    const out = await copyToStore(SRC, "image", far(), OWNER);
    const meta = await sharp(await bodyOf(out.url)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1440);
    expect(meta.height).toBeLessThanOrEqual(1920);
  });

  it("refuses a truncated PNG instead of storing a half-decoded picture", async () => {
    const noisy = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    safeFetch.mockResolvedValue(reply(noisy.subarray(0, noisy.length >> 1)));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_convert_failed");
    expect(filesOnDisk()).toEqual([]);
  });

  it("stores one private JPEG under a random name with no tenant in it, indexed under the job's own scope (rules 1751-1752)", async () => {
    safeFetch.mockResolvedValue(reply(await png(32, 32)));
    const out = await copyToStore(SRC, "image", far(), OWNER);
    const name = nameOf(out.url);
    expect(out.url).toBe(`https://thakeen.com/m/${name}`);
    expect(name).toMatch(/^[a-f0-9]{32}\.jpg$/);
    expect(filesOnDisk()).toEqual([name]);
    expect(await db.get<MediaEntry>(MEDIA_KEYS.entry(OWNER.scope, name))).toMatchObject({ taskId: "t1", kind: "image", bytes: out.bytes });
    expect(await db.smembers(MEDIA_KEYS.names(OWNER.scope))).toEqual([name]);
    expect(await db.mget<number>([MEDIA_KEYS.bytes(), MEDIA_KEYS.count()])).toEqual([out.bytes, 1]);
    expect(await db.get(MEDIA_KEYS.entry("other@x.example", name)), "no other workspace holds it").toBeNull();
    expect(readdirSync(path.join(mediaDir()!, ".tmp")), "the .part file is gone after the link").toEqual([]);
  });

  it("the URL follows APP_ORIGIN only when it is one of our media hosts", async () => {
    safeFetch.mockImplementation(async () => reply(await png(8, 8)));
    vi.stubEnv("APP_ORIGIN", "https://staging.thakeen.com");
    expect((await copyToStore(SRC, "image", far(), OWNER)).url).toMatch(/^https:\/\/staging\.thakeen\.com\/m\//);
    vi.stubEnv("APP_ORIGIN", "https://evil.example");
    expect((await copyToStore(SRC, "image", far(), OWNER)).url).toMatch(/^https:\/\/thakeen\.com\/m\//);
  });

  it("downloads through safeFetch, https on every hop, and never through bare fetch", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    await copyToStore(SRC, "image", far(), OWNER);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe(SRC);
    expect(safeFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(safeFetch.mock.calls[0][2]).toEqual({ httpsOnly: true });
    expect(net.hosts).toEqual([]);
  });

  it("refuses HTML served as image/jpeg, and a video served for an image", async () => {
    safeFetch.mockResolvedValue(reply(HTML, { "content-type": "image/jpeg" }));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_not_media");
    safeFetch.mockResolvedValue(reply(MP4, { "content-type": "image/jpeg" }));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_not_media");
    expect(filesOnDisk()).toEqual([]);
  });
});

describe("copying a video", () => {
  it("stores the MP4 bytes unchanged as video/mp4", async () => {
    safeFetch.mockResolvedValue(reply(MP4, { "content-type": "video/mp4" }));
    const out = await copyToStore(SRC, "video", far(), OWNER);
    expect(nameOf(out.url)).toMatch(/^[a-f0-9]{32}\.mp4$/);
    expect(Buffer.compare(await bodyOf(out.url), MP4)).toBe(0);
    expect(out).toEqual({ url: out.url, bytes: MP4.length, contentType: "video/mp4" });
  });

  it("refuses anything that is not MP4", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8), { "content-type": "video/mp4" }));
    await expect(copyToStore(SRC, "video", far(), OWNER)).rejects.toThrow("store_not_media");
  });
});

describe("limits", () => {
  it("refuses a Content-Length over the cap without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    safeFetch.mockResolvedValue(new Response(body, { headers: { "content-length": String(26 * 1024 * 1024) } }));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_too_large");
    expect(pulls).toBe(0);
  });

  it("stops a streamed body past the cap, whatever the headers said", async () => {
    const mb = new Uint8Array(1024 * 1024);
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(mb); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    safeFetch.mockResolvedValue(new Response(body, { headers: { "content-length": "1000" } }));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_too_large");
    expect(pulls).toBeLessThanOrEqual(26);
    expect(cancelled).toBe(true);
    expect(filesOnDisk()).toEqual([]);
  });

  it("refuses a result whose https URL redirects to plain http, through the real safeFetch", async () => {
    const real = await vi.importActual<typeof import("@/lib/safe-fetch")>("@/lib/safe-fetch");
    safeFetch.mockImplementation(real.safeFetch);
    // IP literals, so safeFetch's own checks never reach DNS. The CDN downgrades the hop; the http leg would serve bytes
    // anyone on the path could have swapped, and they would pass the magic-byte sniff.
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      requested.push(u);
      return u.startsWith("https:") ? new Response(null, { status: 302, headers: { location: "http://8.8.4.4/result/a.mp4" } }) : reply(MP4);
    }) as typeof fetch;
    await expect(copyToStore("https://8.8.8.8/result/a.mp4", "video", far(), OWNER)).rejects.toThrow("store_fetch_failed");
    expect(requested).toEqual(["https://8.8.8.8/result/a.mp4"]);
    expect(filesOnDisk()).toEqual([]);
  });

  it("refuses a source that is not https, and works only with MEDIA_DIR set", async () => {
    await expect(copyToStore("http://tempfile.provider.example/a.jpg", "image", far(), OWNER)).rejects.toThrow("store_not_https");
    await expect(copyToStore("not a url", "image", far(), OWNER)).rejects.toThrow("store_not_https");
    mediaEnv({});
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_no_store");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports a failed download with one code, whatever went wrong", async () => {
    safeFetch.mockResolvedValue(reply(HTML, {}, 404));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_fetch_failed");
    safeFetch.mockRejectedValue(new Error("unsafe_url:private_ip"));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_fetch_failed");
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("socket hang up")); } });
    safeFetch.mockResolvedValue(new Response(broken));
    await expect(copyToStore(SRC, "image", far(), OWNER)).rejects.toThrow("store_fetch_failed");
  });

  it("a failed write leaves no file, no .part and no index entry, and its message carries nothing from the disk", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    const dir = mediaDir()!;
    // A plain file where the .tmp folder belongs: mkdir and open both fail.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".tmp"), "x");
    const e = await copyToStore(SRC, "image", far(), OWNER).then(() => null, (x: Error) => x);
    expect(e?.message).toBe("store_put_failed");
    expect(await db.smembers(MEDIA_KEYS.names(OWNER.scope))).toEqual([]);
    expect(await db.mget<number>([MEDIA_KEYS.bytes(), MEDIA_KEYS.count()])).toEqual([null, null]);
  });

  it("does not start a download it cannot finish before the deadline", async () => {
    await expect(copyToStore(SRC, "image", Date.now() + 5_000, OWNER)).rejects.toThrow("store_no_time");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("bounds every step by the deadline: a video 40 s away downloads for 30 s, not 45", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    safeFetch.mockResolvedValue(reply(MP4));
    await copyToStore(SRC, "video", Date.now() + 40_000, OWNER);
    expect(vi.mocked(abortAfter).mock.calls.map((c) => c[0])).toEqual([30_000]);
  });

  it("uses the step maximum when time is plentiful: image download 15 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    await copyToStore(SRC, "image", Date.now() + 100_000, OWNER);
    expect(vi.mocked(abortAfter).mock.calls.map((c) => c[0])).toEqual([15_000]);
  });
});

describe("quota (rule 1753)", () => {
  it("refuses a file over MEDIA_MAX_FILE_BYTES before anything is written", async () => {
    vi.stubEnv("MEDIA_MAX_FILE_BYTES", "100");
    await expect(writeToStore(MP4, "video", OWNER)).rejects.toThrow("store_too_large");
    expect(filesOnDisk()).toEqual([]);
    expect(await db.smembers(MEDIA_KEYS.names(OWNER.scope))).toEqual([]);
  });

  it("is full at 95 % of MEDIA_MAX_BYTES or MEDIA_MAX_FILES, before the charge and again at the write", async () => {
    vi.stubEnv("MEDIA_MAX_BYTES", "1000");
    vi.stubEnv("MEDIA_MAX_FILE_BYTES", "1000");
    expect(storeLimits()).toMatchObject({ maxBytes: 1000, maxFileBytes: 1000 });
    expect(await storeHasRoom("video", 950)).toBe(true);
    expect(await storeHasRoom("video", 951)).toBe(false);
    await db.incrby(MEDIA_KEYS.bytes(), 1000 * FULL_AT - MP4.length + 1);
    await expect(writeToStore(MP4, "video", OWNER)).rejects.toThrow("store_full");
    vi.stubEnv("MEDIA_MAX_BYTES", "");
    vi.stubEnv("MEDIA_MAX_FILES", "10");
    await db.incrby(MEDIA_KEYS.count(), 9);
    await expect(writeToStore(MP4, "video", OWNER)).rejects.toThrow("store_full");
    expect(filesOnDisk()).toEqual([]);
  });

  it("conservative defaults when unset or not a positive number: 10 GiB, 50,000 files, 100 MiB a file", () => {
    for (const v of ["", "abc", "-5", "0", "1e400"]) {
      vi.stubEnv("MEDIA_MAX_BYTES", v);
      vi.stubEnv("MEDIA_MAX_FILES", v);
      vi.stubEnv("MEDIA_MAX_FILE_BYTES", v);
      expect(storeLimits(), v).toEqual({ maxBytes: 10 * 1024 ** 3, maxFiles: 50_000, maxFileBytes: 100 * 1024 ** 2 });
    }
  });

  it("is not ready at all without MEDIA_DIR", async () => {
    mediaEnv({});
    expect(await storeHasRoom("image")).toBe(false);
  });
});

describe("account deletion (rule 1761)", () => {
  it("deletes every file of every scope it is given, gives the space back, and returns the index keys", async () => {
    safeFetch.mockImplementation(async () => reply(await png(8, 8)));
    const a = await copyToStore(SRC, "image", far(), OWNER);
    const b = await copyToStore(SRC, "image", far(), { scope: "owner@x.example#b2", taskId: "t2" });
    const keep = await copyToStore(SRC, "image", far(), { scope: "someone@else.example", taskId: "t3" });
    const keys = await forgetScopeMedia([OWNER.scope, "owner@x.example#b2"]);
    expect(filesOnDisk()).toEqual([nameOf(keep.url)]);
    expect(keys.sort()).toEqual([
      MEDIA_KEYS.entry(OWNER.scope, nameOf(a.url)), MEDIA_KEYS.entry("owner@x.example#b2", nameOf(b.url)),
      MEDIA_KEYS.names(OWNER.scope), MEDIA_KEYS.names("owner@x.example#b2"),
    ].sort());
    expect(await db.mget<number>([MEDIA_KEYS.bytes(), MEDIA_KEYS.count()])).toEqual([keep.bytes, 1]);
  });

  it("a file already gone is not an error; a scope with no media returns only its set key", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    const a = await copyToStore(SRC, "image", far(), OWNER);
    await fs.unlink(mediaPath(nameOf(a.url))!);
    await expect(forgetScopeMedia([OWNER.scope])).resolves.toHaveLength(2);
    expect(await forgetScopeMedia(["nobody@x.example"])).toEqual([MEDIA_KEYS.names("nobody@x.example")]);
  });

  it("a file that cannot be deleted stops the wipe, so the account is not reported gone while it remains", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    const a = await copyToStore(SRC, "image", far(), OWNER);
    const file = mediaPath(nameOf(a.url))!;
    await fs.unlink(file);
    await fs.mkdir(file); // unlink of a directory fails with EISDIR/EPERM, not ENOENT
    await expect(forgetScopeMedia([OWNER.scope])).rejects.toThrow("account wipe");
    await fs.rmdir(file);
  });

  it("a name in the set that is not a store name is never turned into a path", async () => {
    await db.sadd(MEDIA_KEYS.names(OWNER.scope), "../../etc/passwd");
    const keys = await forgetScopeMedia([OWNER.scope]);
    expect(keys).toContain(MEDIA_KEYS.names(OWNER.scope));
    expect(existsSync("/etc/passwd")).toBe(true);
  });
});

describe("the founder console probe (rule 1762)", () => {
  it("writes, reads and deletes a check file, and counts the builds the store outlived", async () => {
    vi.stubEnv("BUILD_COMMIT", "aaa");
    const first = await probeStore();
    expect(first).toMatchObject({ status: "ok", survivedBuilds: 0, usage: { bytes: 0, files: 0 } });
    expect(readdirSync(path.join(mediaDir()!, ".tmp"))).toEqual([]);
    expect(await probeStore()).toMatchObject({ survivedBuilds: 0 });
    vi.stubEnv("BUILD_COMMIT", "bbb");
    expect(await probeStore()).toMatchObject({ status: "ok", survivedBuilds: 1 });
  });

  it("names a missing or unwritable store with a fixed code and never throws", async () => {
    mediaEnv({});
    expect((await probeStore()).status).toBe("error:no_store");
    const dir = tempMediaDir();
    await fs.writeFile(path.join(dir, ".tmp"), "x");
    vi.stubEnv("MEDIA_DIR", dir);
    expect((await probeStore()).status).toBe("error:write_failed");
  });
});
