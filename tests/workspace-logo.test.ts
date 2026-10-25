import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import * as logoRoute from "@/app/api/account/logo/route";
import * as planRoute from "@/app/api/account/logo/upload/route";
import * as serveRoute from "@/app/api/logo/[name]/route";
import { currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { addBrand } from "@/lib/brands";
import { setAccess } from "@/lib/team";
import { avatarSig } from "@/lib/avatar";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey } from "@/lib/keys";
import { aidOf } from "@/lib/membership";
import { MEDIA_KEYS } from "@/lib/media/store";
import { storage } from "@/lib/media/storage";
import { can } from "@/lib/roles";
import { LOGO_UPLOAD, newUploadName } from "@/lib/upload";
import { forgetLogo, getLogo, logoSig, logoUrls, setLogo } from "@/lib/workspace-logo";
import { mediaEnv, resetMediaCounters } from "./helpers/media";
import { json, newMember, newUser, params, signIn, signOut } from "./helpers/session";

/**
 * Rules 3610-3612: a workspace's logo. Stored per account (`wslogo:{aid}`, the session's account only), re-encoded on the
 * server (sharp: upright, the whole mark inside a 256 px white square, JPEG, no metadata), set and removed by an owner
 * or an admin only (never a member, a token or a founder impersonating), its upload tickets a kind and an owner of their
 * own, served only by `/api/logo/{name}?s=` to a signed-in user under a signature key of its own.
 */

const png = (w = 600, h = 400, background = "#336699") => sharp({ create: { width: w, height: h, channels: 4, background } }).png().toBuffer();
const upload = (body: Uint8Array, type = "image/png") =>
  logoRoute.POST(new Request("https://nashr.test/api/account/logo", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) }));
const nameOf = (url: string) => url.slice("/api/logo/".length, url.indexOf("?"));
const serve = (url: string) => serveRoute.GET(new Request(`https://nashr.test${url}`), params({ name: nameOf(url) }));
const counters = async () => ({ bytes: Number((await db.get(MEDIA_KEYS.bytes())) ?? 0), count: Number((await db.get(MEDIA_KEYS.count())) ?? 0) });

let u: User;
beforeEach(async () => {
  resetMediaCounters();
  mediaEnv({ store: true });
  u = await newUser("wl");
  await signIn(u.email);
});
afterEach(() => vi.unstubAllEnvs());

describe("rule 3610: one logo per workspace, re-encoded, replaced, removed and forgotten with the account", () => {
  it("stores one 256 px JPEG for the session's account; a wide mark is kept whole on white", async () => {
    const before = await counters();
    const res = await upload(await png(800, 200, "#cc0000"));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/api\/logo\/[a-f0-9]{32}\.jpg\?s=[A-Za-z0-9_-]{32}$/);
    expect(await getLogo(aidOf(u))).toBe(url);
    const got = await serve(url);
    expect(got.status).toBe(200);
    const buf = Buffer.from(await got.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["jpeg", 256, 256, undefined]);
    // "contain": the 4:1 mark fills the width; above and below it is white, the middle is the mark's red.
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(px(128, 4).every((c) => c > 240)).toBe(true);
    expect(px(128, 128)[0]).toBeGreaterThan(180);
    expect(px(128, 128)[2]).toBeLessThan(60);
    const after = await counters();
    expect(after.count - before.count).toBe(1);
  });

  it("a new logo replaces the old file; removing deletes the pointer and the file", async () => {
    const first = ((await (await upload(await png())).json()) as { url: string }).url;
    const mid = await counters();
    const second = ((await (await upload(await png(300, 300, "#00aa00"))).json()) as { url: string }).url;
    expect(second).not.toBe(first);
    expect(await storage().head(nameOf(first))).toBeNull();
    expect((await counters()).count).toBe(mid.count);
    expect(await (await logoRoute.DELETE()).json()).toEqual({ ok: true });
    expect(await getLogo(aidOf(u))).toBeNull();
    expect(await storage().head(nameOf(second))).toBeNull();
  });

  it("refuses what is not an image and bytes over the cap", async () => {
    expect((await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).status).toBe(415);
    expect((await upload(Buffer.from("<html>pretend</html>"), "image/png")).status).toBe(415);
    expect((await upload(Buffer.alloc(5 * 1024 * 1024 + 1, 1), "image/png")).status).toBe(413);
    expect(await getLogo(aidOf(u))).toBeNull();
  });

  it("is per account: every workspace's logo in ONE mget for the switcher", async () => {
    const other = await newUser("wl2");
    await setLogo(aidOf(u), await png());
    await setLogo(aidOf(other), await png());
    const mget = vi.spyOn(db, "mget");
    const urls = await logoUrls([aidOf(u), aidOf(other), "a_nobody" as never]);
    expect(mget).toHaveBeenCalledTimes(1);
    mget.mockRestore();
    expect(urls.size).toBe(2);
    expect(urls.get(aidOf(u))).not.toBe(urls.get(aidOf(other)));
    expect(readFileSync("src/lib/workspaces.ts", "utf8")).toContain("logoUrls(held.map((h) => h.aid))");
  });

  it("is forgotten with the account: pointer and file go, a second call is harmless, and wipeAccount calls it", async () => {
    const r = (await setLogo(aidOf(u), await png())) as { ok: true; url: string };
    await forgetLogo(aidOf(u));
    expect(await db.get(accountKey.logo(aidOf(u)))).toBeNull();
    expect(await storage().head(nameOf(r.url))).toBeNull();
    await expect(forgetLogo(aidOf(u))).resolves.toBeUndefined();
    expect(readFileSync("src/lib/account.ts", "utf8")).toMatch(/await forgetLogo\(aid\);/);
  });

  it("is shown beside the workspace's name in the shell, with an initial when there is none", () => {
    const logo = readFileSync("src/components/app/WorkspaceLogo.tsx", "utf8");
    expect(logo).toContain("onError");
    expect(logo).toContain("initialOf(name)");
    expect(readFileSync("src/components/app/WorkspaceSwitcher.tsx", "utf8")).toContain("<WorkspaceLogo src={current.logo}");
    expect(readFileSync("src/components/app/WorkspaceSwitcher.tsx", "utf8")).toContain("<WorkspaceLogo src={w.logo}");
    expect(readFileSync("src/components/app/WorkspacesPanel.tsx", "utf8")).toContain("<WorkspaceLogo src={w.logo}");
    expect(readFileSync("src/components/app/BrandSwitcher.tsx", "utf8")).toContain("<WorkspaceLogo src={logo}");
    expect(readFileSync("src/app/[lang]/app/layout.tsx", "utf8")).toContain("getLogo(aidOf(user))");
    const card = readFileSync("src/components/app/settings/LogoUpload.tsx", "utf8");
    expect(card).toContain("شعار مساحة العمل");
    expect(card).toContain("Workspace logo");
  });
});

describe("rule 3611: owner or admin only, with tickets of its own kind and owner", () => {
  it("an admin sets it; a member gets 403 on every route and changes nothing", async () => {
    const admin = await newMember(u, "admin");
    await signIn(admin.email);
    expect((await upload(await png())).status).toBe(200);
    const shown = await getLogo(aidOf(u));
    expect(shown).toBeTruthy();
    const m = await newMember(u, "member");
    await signIn(m.email);
    expect((await upload(await png())).status).toBe(403);
    expect((await logoRoute.DELETE()).status).toBe(403);
    expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/png", size: 10 }))).status).toBe(403);
    expect(await getLogo(aidOf(u))).toBe(shown);
  });

  it("a founder impersonating, an AI client's token and an anonymous visitor cannot change it", async () => {
    vi.stubEnv("ADMIN_EMAILS", "founder-wl@test.example");
    await signIn(u.email, { imp: "founder-wl@test.example" });
    expect((await upload(await png())).status).toBe(403);
    expect((await logoRoute.DELETE()).status).toBe(403);
    expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/png", size: 10 }))).status).toBe(403);
    signOut();
    expect((await upload(await png())).status).toBe(401);
    const owner = { ...u, actor: { kind: "owner", role: "owner" } } as unknown as User;
    const token = { ...u, actor: { kind: "token", role: "owner" } } as unknown as User;
    expect(can(owner, "workspace.logo")).toBe(true);
    expect(can(token, "workspace.logo")).toBe(false);
    expect(await getLogo(aidOf(u))).toBeNull();
  });

  it("rule 3621: an admin scoped to some brands is refused on every route; an unscoped admin may; the logo stays", async () => {
    await saveUser({ ...(await getUser(u.email))!, plan: "pro" });
    const o = { ...(await currentUser())!, plan: "pro" as const };
    const b = await addBrand(o, "Second");
    if ("error" in b) throw new Error(`addBrand: ${b.error}`);
    const [scoped, open] = await Promise.all([newMember(u, "admin", "wls"), newMember(u, "admin", "wlo")]);
    expect(await setAccess(o, o.actor!, scoped.email, { brands: [b.id] })).toEqual({ ok: true });
    await signIn(open.email);
    expect((await upload(await png())).status).toBe(200);
    const shown = await getLogo(aidOf(u));
    expect(shown).toBeTruthy();
    await signIn(scoped.email);
    const s = (await currentUser())!;
    expect(s.actor).toMatchObject({ kind: "member", role: "admin", brands: [b.id] });
    expect(can(s, "workspace.logo")).toBe(false);
    expect((await upload(await png())).status).toBe(403);
    expect((await logoRoute.DELETE()).status).toBe(403);
    expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/png", size: 10 }))).status).toBe(403);
    expect(await getLogo(aidOf(u))).toBe(shown);
  });

  it("rule 3621: a Viewer and an Editor are refused and get the card read-only", async () => {
    const [viewer, editor] = await Promise.all([newMember(u, "viewer", "wlv"), newMember(u, "member", "wle")]);
    for (const who of [viewer, editor]) {
      await signIn(who.email);
      const me = (await currentUser())!;
      // The settings page passes `canEdit={can(u, "workspace.logo")}` to the logo card: false is the read-only card.
      expect(can(me, "workspace.logo")).toBe(false);
      expect((await upload(await png())).status).toBe(403);
      expect((await logoRoute.DELETE()).status).toBe(403);
      expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/png", size: 10 }))).status).toBe(403);
    }
    expect(await getLogo(aidOf(u))).toBeNull();
    const page = readFileSync("src/app/[lang]/app/settings/account/page.tsx", "utf8");
    expect(page).toContain('canEdit={can(u, "workspace.logo")}');
  });

  it("the plan route answers the server upload on the disk, and refuses a wrong type or size", async () => {
    const r = await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/webp", size: 1000 }));
    expect(await r.json()).toMatchObject({ ok: true, mode: "server", maxBytes: 5 * 1024 * 1024 });
    expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/svg+xml", size: 10 }))).status).toBe(415);
    expect((await planRoute.POST(json("/api/account/logo/upload", "POST", { contentType: "image/png", size: 6 * 1024 * 1024 }))).status).toBe(413);
  });

  it("a ticket of another kind, or under a person's owner, never redeems as a logo", async () => {
    const me = (await currentUser())!;
    const aid = aidOf(me);
    const put = async () => { const n = newUploadName(); await storage().put(n, await png()); return n; };
    // An avatar's ticket filed under the workspace's own owner: the kind does not match.
    const a = await put();
    await db.set(globalKey.uploadTicket(accountKey.logoUploadOwner(aid), a), { kind: "avatar", contentTypes: LOGO_UPLOAD.contentTypes, maxBytes: LOGO_UPLOAD.maxBytes, at: new Date().toISOString() }, 900);
    expect((await logoRoute.POST(json("/api/account/logo", "POST", { name: a }))).status).toBe(404);
    // A logo ticket under the person's owner (`p:{pid}`), not the workspace's (`w:{aid}`): not found.
    const b = await put();
    await db.set(globalKey.uploadTicket(personKey.uploadOwner(me.actor!.pid), b), { kind: "logo", contentTypes: LOGO_UPLOAD.contentTypes, maxBytes: LOGO_UPLOAD.maxBytes, at: new Date().toISOString() }, 900);
    expect((await logoRoute.POST(json("/api/account/logo", "POST", { name: b }))).status).toBe(404);
    // The right kind under the right owner redeems once.
    const c = await put();
    await db.set(globalKey.uploadTicket(accountKey.logoUploadOwner(aid), c), { kind: "logo", contentTypes: LOGO_UPLOAD.contentTypes, maxBytes: LOGO_UPLOAD.maxBytes, at: new Date().toISOString() }, 900);
    expect((await logoRoute.POST(json("/api/account/logo", "POST", { name: c }))).status).toBe(200);
    expect((await logoRoute.POST(json("/api/account/logo", "POST", { name: c }))).status).toBe(404);
    expect(accountKey.logoUploadOwner(aid)).toBe(`w:${aid}`);
  });

  it("every route is rate limited per workspace, from the session's account", () => {
    for (const f of ["src/app/api/account/logo/route.ts", "src/app/api/account/logo/upload/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("aidOf(u)");
      expect(src).toMatch(/allow\(accountKey\.logo(Set|Plan)Bucket\(aid\)/);
      expect(src).toContain('can(u, "workspace.logo")');
    }
  });
});

describe("rule 3612: the serving route", () => {
  it("answers the same bare 404 to a wrong signature, an avatar's signature, a made-up name, no session and a missing file", async () => {
    const url = ((await (await upload(await png())).json()) as { url: string }).url;
    const name = nameOf(url);
    const bad = [
      serveRoute.GET(new Request(`https://nashr.test/api/logo/${name}?s=${"x".repeat(32)}`), params({ name })),
      serveRoute.GET(new Request(`https://nashr.test/api/logo/${name}?s=${avatarSig(name)}`), params({ name })),
      serveRoute.GET(new Request(`https://nashr.test/api/logo/${name}`), params({ name })),
      serveRoute.GET(new Request(`https://nashr.test/api/logo/x.jpg?s=${logoSig("x.jpg")}`), params({ name: "x.jpg" })),
      serveRoute.GET(new Request(`https://nashr.test/api/logo/${"c".repeat(32)}.jpg?s=${logoSig(`${"c".repeat(32)}.jpg`)}`), params({ name: `${"c".repeat(32)}.jpg` })),
    ];
    for (const r of await Promise.all(bad)) expect(r.status).toBe(404);
    expect(avatarSig(name)).not.toBe(logoSig(name));
    signOut();
    expect((await serve(url)).status).toBe(404);
  });

  it("is inert and cached by the browser only, answers 304 for the same etag, and is outside every brand's index", async () => {
    const url = ((await (await upload(await png())).json()) as { url: string }).url;
    const first = await serve(url);
    expect(first.headers.get("content-security-policy")).toContain("sandbox");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toBe("private, max-age=86400");
    const again = await serveRoute.GET(new Request(`https://nashr.test${url}`, { headers: { "if-none-match": first.headers.get("etag")! } }), params({ name: nameOf(url) }));
    expect(again.status).toBe(304);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;
    expect([...mem.kv.keys()].some((k) => k.startsWith("mfile:") && k.endsWith(nameOf(url)))).toBe(false);
    expect(readFileSync("src/lib/workspace-logo.ts", "utf8")).toContain('update("wslogo:v1")');
    expect(readFileSync("src/app/api/logo/[name]/route.ts", "utf8")).toMatch(/allow\(globalKey\.logoGetBucket\(clientIp\(req\)\)/);
  });
});
