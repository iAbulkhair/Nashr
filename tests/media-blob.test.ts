import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { mediaEnv, noNetwork } from "./helpers/media";

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, opts?: { httpsOnly?: boolean }) => Promise<Response>>());
const blob = vi.hoisted(() => ({
  put: vi.fn<(pathname: string, body: unknown, opts: Record<string, unknown>) => Promise<{ url: string }>>(),
  del: vi.fn<(url: string, opts: Record<string, unknown>) => Promise<void>>(),
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));
vi.mock("@vercel/blob", () => blob);
vi.mock("@/lib/media/keys", async (orig) => {
  const k = await orig<typeof import("@/lib/media/keys")>();
  return { ...k, abortAfter: vi.fn(k.abortAfter) };
});

import { copyToBlob, probeBlob, sniff } from "@/lib/media/blob";
import { abortAfter } from "@/lib/media/keys";

/**
 * The Blob store keeps our own copy of every provider result (spec 4.6). The source URL is provider output: it is fetched
 * only through safeFetch, capped while it streams, and judged by its magic bytes. Images become one upright JPEG with
 * transparency on white; video bytes are kept as they are. The stored path carries no tenant identifier.
 */
const SRC = "https://tempfile.provider.example/result/abc";
const STORE = "https://s1.public.blob.vercel-storage.com/";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
const HTML = Buffer.from("<!doctype html><html><body>not an image</body></html>");
const reply = (bytes: Uint8Array, headers: Record<string, string> = {}, status = 200) => new Response(new Uint8Array(bytes), { status, headers });
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).png().toBuffer();
const far = () => Date.now() + 100_000;

let net: ReturnType<typeof noNetwork>;
beforeEach(() => {
  safeFetch.mockReset();
  blob.put.mockReset().mockImplementation(async (pathname) => ({ url: STORE + pathname }));
  blob.del.mockReset().mockResolvedValue(undefined);
  vi.mocked(abortAfter).mockClear();
  mediaEnv({ blob: true });
  net = noNetwork();
});
afterEach(() => {
  net.restore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
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
    const out = await copyToBlob(SRC, "image", far());
    expect(out.contentType).toBe("image/jpeg");
    const body = blob.put.mock.calls[0][1] as Buffer;
    expect(sniff(body)).toBe("jpeg");
    expect(out.bytes).toBe(body.length);
    const px = await sharp(body).raw().toBuffer();
    expect([px[0], px[1], px[2]].every((v) => v >= 250), `pixel ${px[0]},${px[1]},${px[2]}`).toBe(true);
  });

  it("shrinks a large image to fit 1440×1920", async () => {
    safeFetch.mockResolvedValue(reply(await png(3000, 3000)));
    await copyToBlob(SRC, "image", far());
    const meta = await sharp(blob.put.mock.calls[0][1] as Buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(1440);
    expect(meta.height).toBeLessThanOrEqual(1920);
  });

  it("refuses a truncated PNG instead of storing a half-decoded picture", async () => {
    const noisy = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    safeFetch.mockResolvedValue(reply(noisy.subarray(0, noisy.length >> 1)));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_convert_failed");
    expect(blob.put).not.toHaveBeenCalled();
  });

  it("stores one public JPEG under a random path with no tenant in it", async () => {
    safeFetch.mockResolvedValue(reply(await png(32, 32)));
    const out = await copyToBlob(SRC, "image", far());
    expect(blob.put).toHaveBeenCalledTimes(1);
    const [pathname, , opts] = blob.put.mock.calls[0];
    expect(pathname).toMatch(/^media\/[a-f0-9]{32}\.jpg$/);
    expect(pathname).not.toMatch(/[@#]/);
    expect(opts).toMatchObject({ access: "public", contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: false, token: "test-blob_read_write_token" });
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(out.url).toBe(STORE + pathname);
  });

  it("downloads through safeFetch, https on every hop, and never through bare fetch", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    await copyToBlob(SRC, "image", far());
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe(SRC);
    expect(safeFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(safeFetch.mock.calls[0][2]).toEqual({ httpsOnly: true });
    expect(net.hosts).toEqual([]);
  });

  it("refuses HTML served as image/jpeg, and a video served for an image", async () => {
    safeFetch.mockResolvedValue(reply(HTML, { "content-type": "image/jpeg" }));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_not_media");
    safeFetch.mockResolvedValue(reply(MP4, { "content-type": "image/jpeg" }));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_not_media");
    expect(blob.put).not.toHaveBeenCalled();
  });
});

describe("copying a video", () => {
  it("stores the MP4 bytes unchanged as video/mp4", async () => {
    safeFetch.mockResolvedValue(reply(MP4, { "content-type": "video/mp4" }));
    const out = await copyToBlob(SRC, "video", far());
    const [pathname, body, opts] = blob.put.mock.calls[0];
    expect(pathname).toMatch(/^media\/[a-f0-9]{32}\.mp4$/);
    expect(Buffer.compare(body as Buffer, MP4)).toBe(0);
    expect(opts).toMatchObject({ contentType: "video/mp4", access: "public" });
    expect(out).toEqual({ url: STORE + pathname, bytes: MP4.length, contentType: "video/mp4" });
  });

  it("refuses anything that is not MP4", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8), { "content-type": "video/mp4" }));
    await expect(copyToBlob(SRC, "video", far())).rejects.toThrow("store_not_media");
  });
});

describe("limits", () => {
  it("refuses a Content-Length over the cap without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    safeFetch.mockResolvedValue(new Response(body, { headers: { "content-length": String(26 * 1024 * 1024) } }));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_too_large");
    expect(pulls).toBe(0);
  });

  it("stops a streamed body past the cap, whatever the headers said", async () => {
    const mb = new Uint8Array(1024 * 1024);
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(mb); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    safeFetch.mockResolvedValue(new Response(body, { headers: { "content-length": "1000" } }));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_too_large");
    expect(pulls).toBeLessThanOrEqual(26);
    expect(cancelled).toBe(true);
    expect(blob.put).not.toHaveBeenCalled();
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
    await expect(copyToBlob("https://8.8.8.8/result/a.mp4", "video", far())).rejects.toThrow("store_fetch_failed");
    expect(requested).toEqual(["https://8.8.8.8/result/a.mp4"]);
    expect(blob.put).not.toHaveBeenCalled();
  });

  it("refuses a source that is not https, and works only with a Blob token", async () => {
    await expect(copyToBlob("http://tempfile.provider.example/a.jpg", "image", far())).rejects.toThrow("store_not_https");
    await expect(copyToBlob("not a url", "image", far())).rejects.toThrow("store_not_https");
    mediaEnv({});
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_no_blob");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports a failed download with one code, whatever went wrong", async () => {
    safeFetch.mockResolvedValue(reply(HTML, {}, 404));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_fetch_failed");
    safeFetch.mockRejectedValue(new Error("unsafe_url:private_ip"));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_fetch_failed");
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("socket hang up")); } });
    safeFetch.mockResolvedValue(new Response(broken));
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_fetch_failed");
  });

  it("refuses a store that answers with a URL that is not ours, and a failed upload", async () => {
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    blob.put.mockResolvedValueOnce({ url: "https://s1.private.blob.vercel-storage.com/media/x.jpg" });
    await expect(copyToBlob(SRC, "image", far())).rejects.toThrow("store_put_failed");
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    blob.put.mockRejectedValueOnce(new Error("BlobStoreSuspendedError: token tok_secret"));
    const e = await copyToBlob(SRC, "image", far()).then(() => null, (x: Error) => x);
    expect(e?.message, "the store's own message (and anything in it) never leaves this module").toBe("store_put_failed");
  });

  it("does not start a download it cannot finish before the deadline", async () => {
    await expect(copyToBlob(SRC, "image", Date.now() + 5_000)).rejects.toThrow("store_no_time");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("bounds every step by the deadline: a video 40 s away downloads for 30 s, not 45", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    safeFetch.mockResolvedValue(reply(MP4));
    await copyToBlob(SRC, "video", Date.now() + 40_000);
    expect(vi.mocked(abortAfter).mock.calls.map((c) => c[0])).toEqual([30_000, 30_000]);
  });

  it("uses the step maximums when time is plentiful: image download 15 s, upload 20 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    safeFetch.mockResolvedValue(reply(await png(8, 8)));
    await copyToBlob(SRC, "image", Date.now() + 100_000);
    expect(vi.mocked(abortAfter).mock.calls.map((c) => c[0])).toEqual([15_000, 20_000]);
  });
});

describe("the founder console probe", () => {
  const signal = () => new AbortController().signal;

  it("writes a tiny public file, checks the host, and deletes it", async () => {
    expect(await probeBlob(signal())).toBe("ok");
    const [pathname, body, opts] = blob.put.mock.calls[0];
    expect(pathname).toMatch(/^media\/check-[a-f0-9]{16}\.txt$/);
    expect(body).toBe("ok");
    expect(opts).toMatchObject({ access: "public", contentType: "text/plain", addRandomSuffix: false });
    expect(blob.del).toHaveBeenCalledWith(STORE + pathname, expect.objectContaining({ token: "test-blob_read_write_token" }));
  });

  it("names each failure with a fixed code and never throws", async () => {
    blob.put.mockRejectedValueOnce(new Error("BlobAccessError"));
    expect(await probeBlob(signal())).toBe("error:put_failed");
    expect(blob.del).not.toHaveBeenCalled();

    blob.put.mockResolvedValueOnce({ url: "https://files.example.com/media/check.txt" });
    expect(await probeBlob(signal())).toBe("error:foreign_host");
    expect(blob.del).toHaveBeenCalledWith("https://files.example.com/media/check.txt", expect.anything());

    blob.del.mockRejectedValueOnce(new Error("BlobServiceNotAvailable"));
    expect(await probeBlob(signal())).toBe("error:del_failed");
  });

  it("does not write without a token", async () => {
    mediaEnv({});
    expect(await probeBlob(signal())).toBe("error:no_blob");
    expect(blob.put).not.toHaveBeenCalled();
  });
});
