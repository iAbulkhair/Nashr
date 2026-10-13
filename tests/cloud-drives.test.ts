import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { fakeComposio, ok } from "./helpers/composio-fake";
import { mediaEnv, resetMediaCounters } from "./helpers/media";

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, opts?: { httpsOnly?: boolean }) => Promise<Response>>());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { currentUser, sc, type User } from "@/lib/auth";
import { readFile } from "@/lib/files";
import { saveConnection } from "@/lib/connectors/store";
import { PROVIDER_TOOLKITS, TOOLKITS } from "@/lib/connectors/composio-catalog";
import { TOOLKIT_VERSION, composioWrite, setComposioClientForTests } from "@/lib/connectors/composio";
import { PROVIDERS, getProvider, isAvailable } from "@/lib/connectors/registry";
import { DRIVES, WORKING_PROVIDERS } from "@/lib/connectors/working";
import { INTEGRATIONS } from "@/lib/integrations";
import { appDict } from "@/lib/app-i18n";
import { IMPERSONATION_BLOCKED, MIN_ROLE } from "@/lib/roles";
import { DriveFail, RESULTS_MAX, cleanName, exportToDrive, importFromDrive, kindOfName, searchDrive, textOf } from "@/lib/cloud-drives";
import { LIBRARY_MAX, deleteLibraryFile, listLibrary, mediaEntryOf, writeToStore } from "@/lib/media/store";
import * as drivesRoute from "@/app/api/drives/route";
import * as uploadRoute from "@/app/api/media/upload/route";

/**
 * Rules 1775-1789: the customer's cloud drives (Google Drive, Dropbox, OneDrive through Composio) and the media library.
 * Composio's client is a fake; the store is a temporary MEDIA_DIR; the download of a drive file goes through a mocked
 * safeFetch. iCloud has no integration (rule 1787): the device upload is the path, and the copy says so.
 */
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (res: Response) => ({ status: res.status, retry: res.headers.get("retry-after"), body: (await res.json()) as Body });
const post = (body: unknown) => drivesRoute.POST(json("/api/drives", "POST", body)).then(call);
const list = () => drivesRoute.GET().then(call);
const del = (name: string) => drivesRoute.DELETE(new Request(`https://nashr.test/api/drives?name=${encodeURIComponent(name)}`, { method: "DELETE" })).then(call);
const upload = (file: Blob | null, name = "photo.png", headers: Record<string, string> = {}) => {
  const fd = new FormData();
  if (file) fd.append("file", file, name);
  return uploadRoute.POST(new Request("https://nashr.test/api/media/upload", { method: "POST", body: fd, headers })).then(call);
};

const GD = "ca_drive_owner";
const DB = "ca_dropbox_owner";
const OD = "ca_onedrive_owner";
const GID = "1AbCdEfGhIjKlMnOpQrStUvWx";
const DID = "id:AbCdEfGh1234";
const OID = "01ABCDEF2345!678";
const S3 = "https://s3.composio.example/temp/file-abc";
const png = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } }).png().toBuffer();
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
const HTML = Buffer.from("<!doctype html><html><body>not an image</body></html>");
const reply = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200 });

let f: ReturnType<typeof fakeComposio>;
let staged: { file: string; toolSlug: string; toolkitSlug: string }[];

function clearIndex() {
  const mem = (globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; sets: Map<string, Set<string>> } }).__nashrMem;
  for (const m of [mem?.kv, mem?.sets]) for (const k of [...(m?.keys() ?? [])]) if (k.startsWith("mfile")) m!.delete(k);
}

beforeEach(() => {
  resetMediaCounters();
  clearIndex();
  safeFetch.mockReset();
  mediaEnv({ store: true });
  vi.stubEnv("CONNECT_SECRET", "a-test-connect-secret-for-cloud-drives");
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
  vi.stubEnv("COMPOSIO_PROVIDERS", "google_drive,dropbox,onedrive");
  vi.stubEnv("COMPOSIO_AUTH_GOOGLEDRIVE", "ac_gd");
  vi.stubEnv("COMPOSIO_AUTH_DROPBOX", "ac_db");
  vi.stubEnv("COMPOSIO_AUTH_ONEDRIVE", "ac_od");
  f = fakeComposio();
  staged = [];
  f.client.files.upload = async (p) => { staged.push(p); return { name: "staged.bin", mimetype: "application/octet-stream", s3key: `s3/${staged.length}` }; };
  setComposioClientForTests(f.client);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** A signed-in owner with all three drives connected through Composio unless `connected` is false. */
async function owner(prefix: string, { connected = true }: { connected?: boolean } = {}): Promise<User> {
  const u0 = await newUser(prefix);
  await signIn(u0.email);
  const u = (await currentUser())!;
  if (connected) {
    const at = new Date().toISOString();
    await Promise.all([
      saveConnection(sc(u), { provider: "google_drive", data: { googledrive: GD }, meta: { via: "composio", account: "Google Drive" }, connectedAt: at }),
      saveConnection(sc(u), { provider: "dropbox", data: { dropbox: DB }, meta: { via: "composio", account: "Dropbox" }, connectedAt: at }),
      saveConnection(sc(u), { provider: "onedrive", data: { one_drive: OD }, meta: { via: "composio", account: "OneDrive" }, connectedAt: at }),
    ]);
  }
  return u;
}

describe("rule 1775: the catalog, pinned", () => {
  it("each drive is one toolkit with its search, download and upload tools, at a pinned version", () => {
    expect(PROVIDER_TOOLKITS.google_drive).toEqual(["googledrive"]);
    expect(PROVIDER_TOOLKITS.dropbox).toEqual(["dropbox"]);
    expect(PROVIDER_TOOLKITS.onedrive).toEqual(["one_drive"]);
    expect(TOOLKITS.googledrive.read).toEqual({ GOOGLEDRIVE_FIND_FILE: ["q", "pageSize"], GOOGLEDRIVE_DOWNLOAD_FILE: ["fileId"] });
    expect(TOOLKITS.googledrive.write).toEqual({ GOOGLEDRIVE_UPLOAD_FILE: ["file_to_upload"], GOOGLEDRIVE_RESUMABLE_UPLOAD: ["file_to_upload"] });
    expect(TOOLKITS.dropbox.read).toEqual({ DROPBOX_SEARCH_FILE_OR_FOLDER: ["query", "options"], DROPBOX_READ_FILE: ["path"] });
    expect(TOOLKITS.one_drive.read).toEqual({ ONE_DRIVE_SEARCH_ITEMS: ["q", "top"], ONE_DRIVE_DOWNLOAD_FILE: ["item_id", "file_name"] });
    expect(TOOLKIT_VERSION.googledrive).toBe("20261001_00");
    expect(TOOLKIT_VERSION.dropbox).toBe("20261001_00");
    expect(TOOLKIT_VERSION.one_drive).toBe("20261013_00");
    expect([TOOLKITS.googledrive.authEnv, TOOLKITS.dropbox.authEnv, TOOLKITS.one_drive.authEnv]).toEqual(["COMPOSIO_AUTH_GOOGLEDRIVE", "COMPOSIO_AUTH_DROPBOX", "COMPOSIO_AUTH_ONEDRIVE"]);
    // No delete, move, share or permission tool for any drive: Thakeen never removes or exposes a customer's file.
    for (const t of ["googledrive", "dropbox", "one_drive"] as const) {
      for (const slug of [...Object.keys(TOOLKITS[t].read), ...Object.keys(TOOLKITS[t].write)]) expect(slug).not.toMatch(/DELETE|MOVE|SHARE|PERMISSION|TRASH|COPY/);
    }
  });
});

describe("rule 1776: an export never overwrites, never fetches a URL", () => {
  it("Dropbox must add with autorename and OneDrive must rename in /Thakeen, whatever the caller built", async () => {
    expect(TOOLKITS.dropbox.fixed).toEqual({ DROPBOX_UPLOAD_FILE: { mode: "add", autorename: true } });
    expect(TOOLKITS.one_drive.fixed).toEqual({ ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: { folder: "/Thakeen", conflict_behavior: "rename" } });
    const file = { name: "a.jpg", mimetype: "image/jpeg", s3key: "k" };
    await expect(composioWrite("s", "dropbox", "DROPBOX_UPLOAD_FILE", { path: "/Thakeen/a.jpg", content: file, mode: "overwrite", autorename: true }, DB)).rejects.toThrow("composio_argument_not_allowed");
    await expect(composioWrite("s", "one_drive", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", { file, folder: "/Thakeen", conflict_behavior: "replace" }, OD)).rejects.toThrow("composio_argument_not_allowed");
    // OneDrive's upload can fetch a URL itself (source_url); it is not in the allowlist, so a URL never reaches it.
    await expect(composioWrite("s", "one_drive", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", { file, folder: "/Thakeen", conflict_behavior: "rename", source_url: "https://evil.example/x" }, OD)).rejects.toThrow("composio_argument_not_allowed");
    expect(f.calls).toEqual([]);
  });
});

describe("rule 1777: the three drives are Composio-only connectors with no publish or metric path", () => {
  it("not available until Composio and the auth config are set; never in the working or metrics lists", () => {
    for (const id of DRIVES) {
      const p = getProvider(id)!;
      expect(p.kind, id).toBe("oauth");
      expect(p.capabilities, id).toEqual([]);
      expect(WORKING_PROVIDERS, id).not.toContain(id);
      expect(isAvailable(p), id).toBe(true);
    }
    vi.stubEnv("COMPOSIO_AUTH_DROPBOX", "");
    expect(isAvailable(getProvider("dropbox")!)).toBe(false);
    // Composio-only: no direct OAuth app, so without Composio a drive is never available, whatever else is set.
    vi.stubEnv("COMPOSIO_PROVIDERS", "");
    for (const id of DRIVES) expect(isAvailable(getProvider(id)!), id).toBe(false);
    expect(readFileSync("src/lib/connectors/registry.ts", "utf8")).toMatch(/COMPOSIO_ONLY = \[[^\]]*"google_drive", "dropbox", "onedrive"\]/);
    expect(readFileSync("src/lib/connectors/via-composio.ts", "utf8")).toMatch(/Google Drive[\s\S]*Dropbox[\s\S]*OneDrive/);
  });
});

describe("rule 1778: search", () => {
  it("Google: the words are one quoted, escaped string with a constant type filter and page size", async () => {
    const u = await owner("dr-gs");
    f.answers.GOOGLEDRIVE_FIND_FILE = ok({ files: [{ id: GID, name: "logo.png", mimeType: "image/png", size: "1200", modifiedTime: "2026-10-01T00:00:00Z" }] });
    const hits = await searchDrive(sc(u), "google_drive", "it's a \\ test");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].slug).toBe("GOOGLEDRIVE_FIND_FILE");
    expect(f.calls[0].args.pageSize).toBe(RESULTS_MAX);
    expect(f.calls[0].args.q).toMatch(/^name contains 'it\\'s a \\\\ test' and trashed = false and \(mimeType contains 'image\/'/);
    expect(hits).toEqual([{ id: GID, name: "logo.png", kind: "image", bytes: 1200, modified: "2026-10-01T00:00:00Z" }]);
  });

  it("Dropbox and OneDrive get their own shapes; folders, bad ids, unknown types and repeats are dropped; at most 25", async () => {
    const u = await owner("dr-ds");
    f.answers.DROPBOX_SEARCH_FILE_OR_FOLDER = ok({ matches: [
      { metadata: { metadata: { ".tag": "file", id: DID, name: "menu.csv", size: 10 } } },
      { metadata: { metadata: { ".tag": "folder", id: "id:Folder12345", name: "brand.png" } } },
      { metadata: { metadata: { ".tag": "file", id: "../../etc", name: "x.png" } } },
      { metadata: { metadata: { ".tag": "file", id: "id:Script1234", name: "run.exe" } } },
      { metadata: { metadata: { ".tag": "file", id: DID, name: "menu.csv" } } },
    ] });
    expect(await searchDrive(sc(u), "dropbox", "menu")).toEqual([{ id: DID, name: "menu.csv", kind: "text", bytes: 10 }]);
    expect(f.calls[0].args).toEqual({ query: "menu", options: { max_results: RESULTS_MAX, file_status: "active", filename_only: true } });

    f.answers.ONE_DRIVE_SEARCH_ITEMS = ok({ value: Array.from({ length: 40 }, (_, i) => ({ id: `01ABC${i}DEF!1`, name: `clip${i}.mp4` })) });
    const many = await searchDrive(sc(u), "onedrive", "clip");
    expect(many).toHaveLength(RESULTS_MAX);
    expect(many[0].kind).toBe("video");
    expect(f.calls[1].args).toEqual({ q: "clip", top: RESULTS_MAX });
  });

  it("not connected, a stale login or Composio's refusal never leak its text", async () => {
    const u = await owner("dr-nc", { connected: false });
    await expect(searchDrive(sc(u), "google_drive", "x")).rejects.toMatchObject({ code: "not_connected" });
    const v = await owner("dr-up");
    f.answers.GOOGLEDRIVE_FIND_FILE = { successful: false, error: "401: token expired for account abc@example.com" };
    await expect(searchDrive(sc(v), "google_drive", "x")).rejects.toMatchObject({ code: "not_connected" });
    f.answers.GOOGLEDRIVE_FIND_FILE = { successful: false, error: "500: internal detail" };
    const e = await searchDrive(sc(v), "google_drive", "x").catch((x) => x);
    expect(e).toBeInstanceOf(DriveFail);
    expect(e.code).toBe("upstream");
    expect(e.message).toBe("upstream");
    await expect(searchDrive(sc(v), "google_drive", "   ")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("rule 1779: what an import checks", () => {
  it("names: types by extension, control characters and slashes gone", () => {
    expect(kindOfName("Logo.PNG")).toBe("image");
    expect(kindOfName("a.mp4")).toBe("video");
    expect(kindOfName("a.mov")).toBeNull();
    expect(kindOfName("notes.md")).toBe("text");
    expect(kindOfName("x.svg")).toBeNull();
    expect(cleanName("../a\u0000/b\\c.png")).toBe("..-a-b-c.png");
    expect(() => textOf(Buffer.from([0xff, 0xfe, 0x00]))).toThrow("not_text");
    expect(textOf(Buffer.from("﻿hello"))).toBe("hello");
  });

  it("an image is downloaded from the temporary link through safeFetch over https only, and kept as our JPEG", async () => {
    const u = await owner("dr-img");
    f.answers.GOOGLEDRIVE_DOWNLOAD_FILE = ok({ file: { s3url: S3, mimetype: "image/png" } });
    safeFetch.mockResolvedValue(reply(await png()));
    const r = await importFromDrive(sc(u), "google_drive", GID, "logo.png");
    expect(f.calls[0]).toMatchObject({ slug: "GOOGLEDRIVE_DOWNLOAD_FILE", args: { fileId: GID } });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe(S3);
    expect(safeFetch.mock.calls[0][2]).toEqual({ httpsOnly: true });
    expect(r.kind).toBe("image");
    const entry = await mediaEntryOf(sc(u), (r as { url: string }).url);
    expect(entry).toMatchObject({ taskId: "", source: "google_drive", kind: "image" });
    expect((r as { url: string }).url).toMatch(/\.jpg$/);
  });

  it("bytes that are not what the name says are refused: an HTML page named .png, a PNG named .mp4", async () => {
    const u = await owner("dr-bad");
    f.answers.GOOGLEDRIVE_DOWNLOAD_FILE = ok({ s3url: S3 });
    safeFetch.mockResolvedValue(reply(HTML));
    await expect(importFromDrive(sc(u), "google_drive", GID, "logo.png")).rejects.toMatchObject({ code: "not_media" });
    safeFetch.mockResolvedValue(reply(await png()));
    await expect(importFromDrive(sc(u), "google_drive", GID, "clip.mp4")).rejects.toMatchObject({ code: "not_media" });
    expect(await listLibrary(sc(u))).toEqual([]);
  });

  it("Dropbox's inline base64 is measured before it is decoded; a text file becomes drive-… never a core file", async () => {
    const u = await owner("dr-txt");
    f.answers.DROPBOX_READ_FILE = ok({ content: { file_content_bytes: Buffer.from("# Our brand\nwarm and short").toString("base64") } });
    const r = await importFromDrive(sc(u), "dropbox", DID, "brand.md");
    expect(r).toEqual({ kind: "text", file: "drive-brand.md" });
    expect(f.calls[0].args).toEqual({ path: DID });
    expect((await readFile(sc(u), "drive-brand.md"))?.content).toContain("warm and short");
    expect(await readFile(sc(u), "brand.md")).toBeNull();

    f.answers.DROPBOX_READ_FILE = ok({ file_content_bytes: "A".repeat(170_000) });
    await expect(importFromDrive(sc(u), "dropbox", DID, "big.txt")).rejects.toMatchObject({ code: "too_large" });
    f.answers.DROPBOX_READ_FILE = ok({ file_content_bytes: Buffer.from([0x61, 0, 0x62]).toString("base64") });
    await expect(importFromDrive(sc(u), "dropbox", DID, "nul.txt")).rejects.toMatchObject({ code: "not_text" });
  });

  it("the id and name are checked before any call; an unsupported type never reaches the drive", async () => {
    const u = await owner("dr-id");
    await expect(importFromDrive(sc(u), "google_drive", "../../x", "a.png")).rejects.toMatchObject({ code: "bad_request" });
    await expect(importFromDrive(sc(u), "dropbox", "/Photos/a.png", "a.png")).rejects.toMatchObject({ code: "bad_request" });
    await expect(importFromDrive(sc(u), "onedrive", OID, "a.exe")).rejects.toMatchObject({ code: "unsupported" });
    expect(f.calls).toEqual([]);
  });

  it("a video over the source cap stops as too_large; a test fetcher sees the cap", async () => {
    const u = await owner("dr-big");
    f.answers.ONE_DRIVE_DOWNLOAD_FILE = ok({ s3url: S3 });
    const caps: number[] = [];
    await expect(importFromDrive(sc(u), "onedrive", OID, "clip.mp4", { fetchBody: async (_u, _k, cap) => { caps.push(cap); return Buffer.alloc(cap + 1); } })).rejects.toMatchObject({ code: "too_large" });
    expect(caps).toEqual([100 * 1024 * 1024]);
    expect(f.calls[0].args).toEqual({ item_id: OID, file_name: "clip.mp4" });
    const r = await importFromDrive(sc(u), "onedrive", OID, "clip.mp4", { fetchBody: async () => MP4 });
    expect(r.kind).toBe("video");
  });
});

describe("rules 1780-1781, 1784: the library", () => {
  it("lists only this scope's files with no task, newest first; delete removes only those", async () => {
    const u = await owner("dr-lib");
    const v = await owner("dr-lib2");
    const post = await writeToStore(MP4, "video", { scope: sc(u), taskId: "t1" });
    const mine = await writeToStore(Buffer.from(await sharp(await png()).jpeg().toBuffer()), "image", { scope: sc(u), taskId: "", source: "upload" });
    await writeToStore(MP4, "video", { scope: sc(v), taskId: "", source: "dropbox" });
    const items = await listLibrary(sc(u));
    expect(items.map((x) => x.url)).toEqual([mine.url]);
    expect(items[0]).toMatchObject({ kind: "image", source: "upload" });
    const nameOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    expect(await deleteLibraryFile(sc(u), nameOf(post.url))).toBe(false);
    expect(await deleteLibraryFile(sc(v), nameOf(mine.url))).toBe(false);
    expect(await deleteLibraryFile(sc(u), "../../etc/passwd")).toBe(false);
    expect(await deleteLibraryFile(sc(u), nameOf(mine.url))).toBe(true);
    expect(await listLibrary(sc(u))).toEqual([]);
    expect(await mediaEntryOf(sc(u), post.url)).not.toBeNull();
  });

  it("LIBRARY_MAX is a constant the import respects", () => {
    expect(LIBRARY_MAX).toBe(300);
    expect(readFileSync("src/lib/cloud-drives.ts", "utf8")).toMatch(/length >= LIBRARY_MAX\) throw new DriveFail\("library_full"\)/);
  });
});

describe("rule 1782: export only this workspace's own files", () => {
  it("another workspace's file, a foreign URL or an unknown name is refused before any call", async () => {
    const v = await owner("dr-ex-other");
    const theirs = await writeToStore(MP4, "video", { scope: sc(v), taskId: "t9" });
    const u = await owner("dr-ex");
    for (const url of [theirs.url, "https://evil.example/m/0123456789abcdef0123456789abcdef.jpg", "https://thakeen.com/m/0123456789abcdef0123456789abcdef.jpg"]) {
      await expect(exportToDrive(sc(u), "google_drive", url)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(staged).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("an image goes up with the plain upload, a video with the resumable one, each through a signed link; Dropbox and OneDrive with the fixed values", async () => {
    const u = await owner("dr-ex2");
    const img = await writeToStore(await sharp(await png()).jpeg().toBuffer(), "image", { scope: sc(u), taskId: "t1" });
    const vid = await writeToStore(MP4, "video", { scope: sc(u), taskId: "t2" });
    for (const s of ["GOOGLEDRIVE_UPLOAD_FILE", "GOOGLEDRIVE_RESUMABLE_UPLOAD", "DROPBOX_UPLOAD_FILE", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE"]) f.answers[s] = ok({ id: "new" });
    const a = await exportToDrive(sc(u), "google_drive", img.url);
    expect(a.name).toMatch(/^thakeen-[a-f0-9]{8}\.jpg$/);
    await exportToDrive(sc(u), "google_drive", vid.url);
    await exportToDrive(sc(u), "dropbox", img.url);
    await exportToDrive(sc(u), "onedrive", vid.url);
    expect(f.calls.map((c) => c.slug)).toEqual(["GOOGLEDRIVE_UPLOAD_FILE", "GOOGLEDRIVE_RESUMABLE_UPLOAD", "DROPBOX_UPLOAD_FILE", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE"]);
    expect(f.calls[0].args.file_to_upload).toMatchObject({ name: a.name, s3key: "s3/1" });
    expect(f.calls[2].args).toMatchObject({ path: `/Thakeen/${a.name}`, mode: "add", autorename: true });
    expect(f.calls[3].args).toMatchObject({ folder: "/Thakeen", conflict_behavior: "rename" });
    // The link Composio fetches is a short signed link to our own file, never the bare private URL.
    for (const s of staged) expect(s.file).toMatch(/^https:\/\/thakeen\.com\/m\/[a-f0-9]{32}\.(jpg|mp4)\?/);
  });
});

describe("rule 1783: the device upload", () => {
  it("an image is judged by its bytes, kept as a library JPEG; a fake image, a big body and an empty form are refused", async () => {
    const u = await owner("dr-up1", { connected: false });
    const good = await upload(new Blob([new Uint8Array(await png())], { type: "image/png" }));
    expect(good.status).toBe(200);
    expect(good.body.url).toMatch(/\/m\/[a-f0-9]{32}\.jpg$/);
    expect((await listLibrary(sc(u)))[0]).toMatchObject({ source: "upload", kind: "image" });
    expect((await upload(new Blob([new Uint8Array(HTML)], { type: "image/png" }))).status).toBe(415);
    expect((await upload(new Blob([new Uint8Array(MP4)], { type: "image/png" }), "x.png")).status).toBe(415);
    expect((await upload(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }))).body.error).toBe("too_large");
    expect((await upload(null)).status).toBe(400);
  });

  it("no store: 503, and nothing is kept", async () => {
    await owner("dr-up2", { connected: false });
    vi.stubEnv("MEDIA_DIR", "");
    const r = await upload(new Blob([new Uint8Array(await png())], { type: "image/png" }));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("no_store");
  });
});

describe("rule 1785: routes, roles, limits", () => {
  it("every route refuses a signed-out caller", async () => {
    signOut();
    expect((await list()).status).toBe(401);
    expect((await post({ action: "search", drive: "dropbox", q: "x" })).status).toBe(401);
    expect((await del("x")).status).toBe(401);
    expect((await upload(new Blob(["x"]))).status).toBe(401);
  });

  it("any member may import and export; a founder impersonating may not export", async () => {
    expect(MIN_ROLE["library.write"]).toBe("member");
    expect(MIN_ROLE["library.export"]).toBe("member");
    expect(IMPERSONATION_BLOCKED.has("library.export")).toBe(true);
    const o = await owner("dr-role");
    const m = await newMember(o, "member", "dr-mem");
    await signIn(m.email);
    f.answers.DROPBOX_SEARCH_FILE_OR_FOLDER = ok({ matches: [] });
    expect((await post({ action: "search", drive: "dropbox", q: "logo" })).body).toEqual({ ok: true, results: [] });
    vi.stubEnv("ADMIN_EMAILS", "founder-drives@test.example");
    await signIn(o.email, { imp: "founder-drives@test.example" });
    const r = await post({ action: "export", drive: "dropbox", url: "https://thakeen.com/m/0123456789abcdef0123456789abcdef.jpg" });
    expect(r.status).toBe(403);
    expect(staged).toEqual([]);
  });

  it("a drive that is not ready is unknown; a bad action or body is 400; Composio's text never reaches the caller", async () => {
    await owner("dr-rt");
    expect((await post({ action: "delete_all", drive: "dropbox" })).status).toBe(400);
    expect((await post({ action: "search", drive: "icloud", q: "x" })).body.error).toBe("unknown_drive");
    expect((await post({ action: "search", drive: "dropbox", q: "x".repeat(101) })).status).toBe(400);
    f.answers.DROPBOX_SEARCH_FILE_OR_FOLDER = { successful: false, error: "500: secret upstream detail" };
    const r = await post({ action: "search", drive: "dropbox", q: "x" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("secret");
    vi.stubEnv("COMPOSIO_AUTH_DROPBOX", "");
    expect((await post({ action: "search", drive: "dropbox", q: "x" })).status).toBe(404);
  });

  it("each action has its own hourly bucket per workspace (429 with Retry-After)", async () => {
    await owner("dr-rate");
    f.answers.ONE_DRIVE_SEARCH_ITEMS = ok({ value: [] });
    for (let i = 0; i < 60; i++) expect((await post({ action: "search", drive: "onedrive", q: "x" })).status).toBe(200);
    const r = await post({ action: "search", drive: "onedrive", q: "x" });
    expect(r.status).toBe(429);
    expect(Number(r.retry)).toBeGreaterThan(0);
    // Imports keep their own bucket: searching never used them up.
    f.answers.ONE_DRIVE_DOWNLOAD_FILE = ok({ s3url: S3 });
    safeFetch.mockResolvedValue(reply(MP4));
    expect((await post({ action: "import", drive: "onedrive", id: OID, name: "clip.mp4" })).status).toBe(200);
  });
});

describe("rule 1786: no button before the keys", () => {
  it("GET lists only ready drives, each with its own connected flag", async () => {
    const u = await owner("dr-get");
    vi.stubEnv("COMPOSIO_AUTH_ONEDRIVE", "");
    const r = await list();
    expect(r.body.drives).toEqual([{ id: "google_drive", connected: true }, { id: "dropbox", connected: true }]);
    expect(r.body.store).toBe(true);
    vi.stubEnv("COMPOSIO_API_KEY", "");
    expect((await list()).body.drives).toEqual([]);
    expect(sc(u)).toBeTruthy();
  });

  it("the Integrations card shows Connect for a drive only when it is available, and the catalog marks the drives as coming", () => {
    expect(readFileSync("src/components/app/IntegrationsPanel.tsx", "utf8")).toMatch(/DRIVES\.includes\(found\.id\)/);
    for (const id of DRIVES) {
      const i = INTEGRATIONS.find((x) => x.id === id)!;
      expect(i, id).toBeTruthy();
      expect(i.status, id).toBe("soon");
    }
  });
});

describe("rule 1787: iCloud Drive, plainly", () => {
  it("no iCloud connector; the catalog, the library copy and the upload route say the Files picker is the way", () => {
    expect(PROVIDERS.map((p) => p.id)).not.toContain("icloud");
    const i = INTEGRATIONS.find((x) => x.id === "icloud")!;
    expect(i.status).toBe("planned");
    expect(i.note).toMatch(/Apple offers no way for a web app to link iCloud Drive/);
    expect(appDict.en.library.icloud).toMatch(/Apple offers no way for a web app to link iCloud Drive/);
    expect(appDict.ar.library.icloud).toContain("iCloud Drive");
    expect(appDict.en.library.uploadHint).toMatch(/Files app, which includes iCloud Drive/);
    expect(readFileSync("src/app/api/media/upload/route.ts", "utf8")).toMatch(/Files picker, which includes iCloud Drive/);
    expect(readFileSync("src/components/app/LibraryPanel.tsx", "utf8")).toMatch(/accept=\{IMAGE_ACCEPT\}[\s\S]*accept=\{TEXT_ACCEPT\}/);
  });
});

describe("rule 1788: only the app's own routes reach a drive", () => {
  it("no chat, MCP or agent code imports cloud-drives", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
    const out = walk("src").filter((p) => /from\s+["']@\/lib\/cloud-drives["']/.test(readFileSync(p, "utf8"))).sort();
    expect(out).toEqual(["src/app/api/drives/route.ts", "src/app/api/media/upload/route.ts", "src/components/app/LibraryPanel.tsx"]);
  });
});
