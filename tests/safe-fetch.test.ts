import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, safeFetch } from "@/lib/safe-fetch";

// IP literals only, so these tests never touch DNS or the network.
const blocked = [
  "http://169.254.169.254/latest/meta-data", "http://localhost:3000", "http://127.0.0.1", "http://10.0.0.5/x", "http://192.168.1.1", "http://172.16.0.1",
  "http://0.0.0.0/", "http://2130706433/", "http://0x7f.0.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/",
  "http://[::ffff:10.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:7f00:1]/", "http://[::10.0.0.1]/",
  "ftp://example.com", "file:///etc/passwd", "http://user:pw@8.8.8.8/", "http://printer.local/", "http://db.internal/", "not a url",
];

describe("assertPublicUrl", () => {
  it.each(blocked)("blocks %s", async (u) => { await expect(assertPublicUrl(u)).rejects.toThrow(/unsafe_url/); });
  it("allows public IP literals, including IPv4-mapped public addresses", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://[::ffff:8.8.8.8]/")).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("re-validates every redirect hop and refuses a redirect into the private network", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch("https://8.8.8.8/start")).rejects.toThrow(/unsafe_url:private_ip/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the internal address was never requested
  });
  it("gives up after too many redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://8.8.4.4/next" } })));
    await expect(safeFetch("https://8.8.8.8/")).rejects.toThrow(/too_many_redirects/);
  });
  it("returns the final response when the target is public", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    expect(await (await safeFetch("https://8.8.8.8/")).text()).toBe("ok");
  });
});
