import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { newUser } from "./helpers/session";
import { mediaEnv, resetMediaCounters } from "./helpers/media";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { MEDIA_KEYS, mediaPath } from "@/lib/media/store";
import { isLegacyBlob, legacyFields, moveBlobMedia } from "../scripts/media-blob-move";

/**
 * Rule 1763: the one-time move of old public Blob copies into the private disk store. Read-only unless asked to copy;
 * idempotent; each copy under the task's own stored scope; a task the owner changed meanwhile keeps the change; output
 * is counts only. Never run at build time (`package.json` scripts and next.config name it nowhere).
 */
const BLOB_IMG = `https://s1.public.blob.vercel-storage.com/media/${"a".repeat(32)}.jpg`;
const BLOB_CLIP = `https://s1.public.blob.vercel-storage.com/media/${"b".repeat(32)}.mp4`;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]);
const task = (over: Partial<Task>): Task => ({ id: `t${Math.random().toString(16).slice(2, 10)}`, type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar", ...over });
let jpeg: Buffer;

beforeEach(async () => {
  resetMediaCounters();
  mediaEnv({ store: true });
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).jpeg().toBuffer();
});
afterEach(() => vi.unstubAllEnvs());

describe("finding old Blob copies", () => {
  it("a Blob URL is legacy; a disk-store URL, a fal link and nothing are not", () => {
    expect(isLegacyBlob(BLOB_IMG)).toBe(true);
    for (const u of [`https://thakeen.com/m/${"a".repeat(32)}.jpg`, "https://v3.fal.media/files/x.jpg", undefined]) expect(isLegacyBlob(u), String(u)).toBe(false);
    expect(legacyFields(task({ imageUrl: BLOB_IMG, videoUrl: BLOB_CLIP }))).toEqual(["imageUrl", "videoUrl"]);
  });
});

describe("moveBlobMedia", () => {
  it("scan counts and changes nothing; copy moves each file under the task's own scope, once", async () => {
    const u = await newUser("blobmove");
    const t = task({ imageUrl: BLOB_IMG, imageProvider: "kie", videoUrl: BLOB_CLIP, videoProvider: "kie" });
    await saveTask(sc(u), t, true);
    const fetched: string[] = [];
    const fetchBody = async (url: string) => { fetched.push(url); return url.endsWith(".mp4") ? MP4 : jpeg; };

    const scan = await moveBlobMedia(false, { fetchBody });
    expect(scan.legacy.image).toBeGreaterThanOrEqual(1);
    expect(scan.legacy.video).toBeGreaterThanOrEqual(1);
    expect(fetched).toEqual([]);
    expect((await getTask(sc(u), t.id))?.imageUrl).toBe(BLOB_IMG);

    const first = await moveBlobMedia(true, { fetchBody });
    expect(first.failed).toEqual({});
    const moved = (await getTask(sc(u), t.id))!;
    for (const f of ["imageUrl", "videoUrl"] as const) {
      expect(moved[f]).toMatch(/^https:\/\/thakeen\.com\/m\/[a-f0-9]{32}\.(jpg|mp4)$/);
      const name = moved[f]!.slice(-36);
      expect(await db.get(MEDIA_KEYS.entry(sc(u), name))).toMatchObject({ taskId: t.id });
      expect((await fs.stat(mediaPath(name)!)).isFile()).toBe(true);
    }
    // A JPEG is kept byte for byte, not encoded a second time.
    expect(Buffer.compare(await fs.readFile(mediaPath(moved.imageUrl!.slice(-36))!), jpeg)).toBe(0);

    fetched.length = 0;
    const again = await moveBlobMedia(true, { fetchBody });
    expect(fetched.filter((x) => x === BLOB_IMG || x === BLOB_CLIP), "a second run finds this task done").toEqual([]);
    expect(again.failed).toEqual({});
  });

  it("a task the owner changed while the copy ran keeps the owner's change", async () => {
    const u = await newUser("blobmovechg");
    const t = task({ imageUrl: BLOB_IMG, imageProvider: "kie" });
    await saveTask(sc(u), t, true);
    const newer = "https://v3.fal.media/files/newer.jpg";
    const r = await moveBlobMedia(true, {
      fetchBody: async () => {
        await saveTask(sc(u), { ...t, imageUrl: newer, imageProvider: "fal" });
        return jpeg;
      },
    });
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect((await getTask(sc(u), t.id))?.imageUrl).toBe(newer);
  });

  it("a file that is not what it claims, or a failed download, is counted by code and the Blob URL stays", async () => {
    const u = await newUser("blobmovebad");
    const a = task({ imageUrl: BLOB_IMG, imageProvider: "kie" });
    const b = task({ videoUrl: BLOB_CLIP, videoProvider: "kie" });
    await Promise.all([saveTask(sc(u), a, true), saveTask(sc(u), b, true)]);
    const r = await moveBlobMedia(true, {
      fetchBody: async (url) => {
        if (url.endsWith(".mp4")) throw new (await import("@/lib/media/types")).StoreError("fetch_failed");
        return Buffer.from("<html>not an image</html>");
      },
    });
    expect(r.failed.not_media).toBeGreaterThanOrEqual(1);
    expect(r.failed.fetch_failed).toBeGreaterThanOrEqual(1);
    expect((await getTask(sc(u), a.id))?.imageUrl).toBe(BLOB_IMG);
    expect((await getTask(sc(u), b.id))?.videoUrl).toBe(BLOB_CLIP);
  });

  it("is never run at build time", async () => {
    const pkg = await fs.readFile("package.json", "utf8");
    const next = await fs.readFile("next.config.ts", "utf8");
    for (const text of [pkg, next]) expect(text).not.toContain("media-blob-move");
  });
});
