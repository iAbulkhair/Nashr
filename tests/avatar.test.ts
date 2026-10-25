import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import * as avatarRoute from "@/app/api/account/avatar/route";
import * as planRoute from "@/app/api/account/avatar/upload/route";
import * as serveRoute from "@/app/api/avatar/[name]/route";
import { acct, currentUser, type User } from "@/lib/auth";
import { avatarSig, avatarUrls, forgetAvatar, getAvatar, setAvatar } from "@/lib/avatar";
import { db } from "@/lib/db";
import { personKey } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { MEDIA_KEYS } from "@/lib/media/store";
import { storage } from "@/lib/media/storage";
import { teamView } from "@/lib/team";
import { mediaEnv, resetMediaCounters } from "./helpers/media";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";

/**
 * Rules 3502-3503: a person's picture. Stored per person (`avatar:{pid}`), re-encoded server-side (sharp: upright, 256 px
 * square JPEG, no metadata), image only and capped; shown in the sidebar and the team list; removable; served only by
 * `/api/avatar/{name}?s=` to a signed-in user, with a signature only our server can make.
 */

const png = (w = 600, h = 400, background = "#336699") => sharp({ create: { width: w, height: h, channels: 4, background } }).png().toBuffer();
const upload = (body: Uint8Array, type = "image/png") =>
  avatarRoute.POST(new Request("https://nashr.test/api/account/avatar", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }));
const nameOf = (url: string) => url.slice("/api/avatar/".length, url.indexOf("?"));
const serve = (url: string) => serveRoute.GET(new Request(`https://nashr.test${url}`), params({ name: nameOf(url) }));
const counters = async () => ({ bytes: Number((await db.get(MEDIA_KEYS.bytes())) ?? 0), count: Number((await db.get(MEDIA_KEYS.count())) ?? 0) });

let u: User;
beforeEach(async () => {
  resetMediaCounters();
  mediaEnv({ store: true });
  u = await newUser("av");
  await signIn(u.email);
});
afterEach(() => vi.unstubAllEnvs());

describe("rule 3502: set, replace and remove a picture", () => {
  it("stores one 256 px JPEG per person, served back to a signed-in user", async () => {
    const before = await counters();
    const res = await upload(await png());
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/api\/avatar\/[a-f0-9]{32}\.jpg\?s=[A-Za-z0-9_-]{32}$/);
    expect(await getAvatar(ownerOf(u))).toBe(url);
    const got = await serve(url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    const meta = await sharp(Buffer.from(await got.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["jpeg", 256, 256, undefined]);
    const after = await counters();
    expect(after.count - before.count).toBe(1);
    expect(after.bytes).toBeGreaterThan(before.bytes);
  });

  it("a new picture replaces the old file; removing deletes the pointer and the file", async () => {
    const first = ((await (await upload(await png())).json()) as { url: string }).url;
    const mid = await counters();
    const second = ((await (await upload(await png(300, 300, "#aa0000"))).json()) as { url: string }).url;
    expect(second).not.toBe(first);
    expect(await storage().head(nameOf(first))).toBeNull();
    expect((await counters()).count).toBe(mid.count);
    const del = await avatarRoute.DELETE();
    expect(await del.json()).toEqual({ ok: true });
    expect(await getAvatar(ownerOf(u))).toBeNull();
    expect(await storage().head(nameOf(second))).toBeNull();
    expect((await counters()).count).toBe(mid.count - 1);
  });

  it("refuses what is not an image, an image type outside the list, and bytes over the cap", async () => {
    expect((await upload(Buffer.from("<html><script>alert(1)</script></html>"), "text/html")).status).toBe(415);
    expect((await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).status).toBe(415);
    // HTML declared as PNG: judged by its magic numbers.
    expect((await upload(Buffer.from("<html>pretend</html>"), "image/png")).status).toBe(415);
    expect((await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 1), "image/png")).status).toBe(413);
    expect(await getAvatar(ownerOf(u))).toBeNull();
  });

  it("a founder impersonating and an anonymous visitor cannot change anyone's picture", async () => {
    vi.stubEnv("ADMIN_EMAILS", "founder-av@test.example");
    await signIn(u.email, { imp: "founder-av@test.example" });
    expect((await upload(await png())).status).toBe(403);
    expect((await avatarRoute.DELETE()).status).toBe(403);
    expect((await planRoute.POST(json("/api/account/avatar/upload", "POST", { contentType: "image/png", size: 10 }))).status).toBe(403);
    signOut();
    expect((await upload(await png())).status).toBe(401);
    expect(await getAvatar(ownerOf(u))).toBeNull();
  });

  it("the plan route answers the server upload on the disk, and refuses a wrong type", async () => {
    const r = await planRoute.POST(json("/api/account/avatar/upload", "POST", { contentType: "image/webp", size: 1000 }));
    expect(await r.json()).toMatchObject({ ok: true, mode: "server", maxBytes: 5 * 1024 * 1024 });
    expect((await planRoute.POST(json("/api/account/avatar/upload", "POST", { contentType: "application/pdf", size: 10 }))).status).toBe(415);
  });

  it("a signed-upload completion with a name that has no ticket of this person finds nothing", async () => {
    const res = await avatarRoute.POST(json("/api/account/avatar", "POST", { name: `${"a".repeat(32)}.jpg` }));
    expect(res.status).toBe(404);
  });

  it("is per person: a member's picture shows in the owner's team list, the owner's too, in one read", async () => {
    const m = await newMember(u);
    await setAvatar(m.pid, await png());
    await setAvatar(ownerOf(u), await png());
    const mget = vi.spyOn(db, "mget");
    const view = await teamView((await currentUser())!);
    expect(view).not.toBeNull();
    expect(mget.mock.calls.filter((c) => (c[0] as string[]).some((k) => k.startsWith("avatar:")))).toHaveLength(1);
    mget.mockRestore();
    const rows = JSON.stringify(view);
    expect(rows).toContain((await getAvatar(m.pid))!);
    expect(rows).toContain((await getAvatar(ownerOf(u)))!);
    const faces = await avatarUrls([m.pid, ownerOf(u), "p_nobody" as never]);
    expect(faces.size).toBe(2);
  });

  it("is forgotten with the person: pointer and file go, and a second call is harmless", async () => {
    const url = (await setAvatar(ownerOf(u), await png())) as { ok: true; url: string };
    await forgetAvatar(ownerOf(u));
    expect(await db.get(personKey.avatar(ownerOf(u)))).toBeNull();
    expect(await storage().head(nameOf(url.url))).toBeNull();
    await expect(forgetAvatar(ownerOf(u))).resolves.toBeUndefined();
    const account = readFileSync("src/lib/account.ts", "utf8");
    expect(account).toMatch(/if \(alone\) await forgetAvatar\(self\)/);
    expect(readFileSync("src/lib/team.ts", "utf8")).toMatch(/forgetAvatar\(pid\)/);
  });

  it("is shown in the sidebar account menu and the team list, with an initial when there is none", () => {
    const sidebar = readFileSync("src/components/app/Sidebar.tsx", "utf8");
    const team = readFileSync("src/components/app/TeamPanel.tsx", "utf8");
    const face = readFileSync("src/components/app/PersonAvatar.tsx", "utf8");
    expect(sidebar).toContain("<PersonAvatar src={user.avatar}");
    expect(team).toContain("<PersonAvatar src={m.avatar}");
    expect(face).toContain("onError");
    expect(face).toContain("initialOf");
    const ui = readFileSync("src/components/app/settings/AvatarUpload.tsx", "utf8");
    expect(ui).toContain("صورتك");
    expect(ui).toContain("Your picture");
  });
});

describe("rule 3503: the serving route", () => {
  it("answers the same bare 404 to a wrong signature, a made-up name, no session and a missing file", async () => {
    const url = ((await (await upload(await png())).json()) as { url: string }).url;
    const name = nameOf(url);
    const bad = [
      serveRoute.GET(new Request(`https://nashr.test/api/avatar/${name}?s=${"x".repeat(32)}`), params({ name })),
      serveRoute.GET(new Request(`https://nashr.test/api/avatar/${name}`), params({ name })),
      serveRoute.GET(new Request(`https://nashr.test/api/avatar/x.jpg?s=${avatarSig("x.jpg")}`), params({ name: "x.jpg" })),
      serveRoute.GET(new Request(`https://nashr.test/api/avatar/${"b".repeat(32)}.jpg?s=${avatarSig(`${"b".repeat(32)}.jpg`)}`), params({ name: `${"b".repeat(32)}.jpg` })),
    ];
    for (const r of await Promise.all(bad)) expect(r.status).toBe(404);
    signOut();
    expect((await serve(url)).status).toBe(404);
  });

  it("answers 304 for the same etag", async () => {
    const url = ((await (await upload(await png())).json()) as { url: string }).url;
    const first = await serve(url);
    const etag = first.headers.get("etag")!;
    const again = await serveRoute.GET(new Request(`https://nashr.test${url}`, { headers: { "if-none-match": etag } }), params({ name: nameOf(url) }));
    expect(again.status).toBe(304);
  });

  it("is outside every workspace index, so /m/ never serves it, and the signature key is derived, never the secret itself", async () => {
    const url = ((await (await upload(await png())).json()) as { url: string }).url;
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;
    expect([...mem.kv.keys()].some((k) => k.startsWith("mfile:") && k.endsWith(nameOf(url)))).toBe(false);
    const src = readFileSync("src/lib/avatar.ts", "utf8");
    expect(src).toContain('update("avatar:v1")');
    expect(readFileSync("src/app/api/avatar/[name]/route.ts", "utf8")).toContain("sameSecret(");
    expect(acct(u)).toBeTruthy();
  });
});
