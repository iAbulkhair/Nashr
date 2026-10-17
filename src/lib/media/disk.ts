/**
 * The disk backend of the media store (rules 1750-1763), the only `StorageAdapter` (src/lib/media/storage.ts, rule
 * 2058): a private folder outside the app (`MEDIA_DIR`, `domains/{domain}/media` on Hostinger), sharded by the name's
 * first two hex digits. Files are owner-only (0600 in 0700 folders). Every name is checked against MEDIA_NAME before it
 * becomes a path, so no `/`, `..`, `%`, NUL or uppercase ever reaches the filesystem.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { MEDIA_NAME } from "../media-catalog";
import { mediaDir, mediaOrigin } from "./config";
import type { StorageAdapter, StorageProbe } from "./storage";

/** The file on disk for a name that passed MEDIA_NAME, sharded by its first two hex digits. Null for anything else. */
export function mediaPath(name: string, dir = mediaDir()): string | null {
  if (!dir || !MEDIA_NAME.test(name)) return null;
  return path.join(dir, name.slice(0, 2), name);
}

/** Rule 1750: the folder exists with owner-only access, created on first use. */
async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
}

/** Free space under the store, or Infinity when the platform cannot say (statfs on shared hosting may show the whole disk). */
async function freeBytesIn(dir: string): Promise<number> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

const SENTINEL = ".sentinel";

export const diskStorage: StorageAdapter = {
  name: "disk",
  configured: () => mediaDir() !== null,

  /**
   * Write order (rule 1752): the bytes to `.tmp/{name}.part` (created with `wx`, flushed), then a hard link to the final
   * name, which fails rather than overwrite. The part file is removed whether the link worked or not.
   */
  async put(name, body) {
    const dir = mediaDir();
    const final = dir ? mediaPath(name, dir) : null;
    if (!dir || !final) throw new Error("storage_put_refused");
    const tmpDir = path.join(dir, ".tmp");
    const tmp = path.join(tmpDir, `${name}.part`);
    try {
      await Promise.all([ensureDir(tmpDir), ensureDir(path.dirname(final))]);
      const fh = await fs.open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.link(tmp, final);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  },

  async get(name) {
    const file = mediaPath(name);
    if (!file) return null;
    try {
      return await fs.readFile(file);
    } catch {
      return null;
    }
  },

  stream(name, range) {
    const file = mediaPath(name);
    if (!file) throw new Error("storage_stream_refused");
    return createReadStream(file, range ? { start: range.start, end: range.end } : {});
  },

  async head(name) {
    const file = mediaPath(name);
    if (!file) return null;
    try {
      const s = await fs.stat(file);
      if (!s.isFile()) return null;
      return { size: s.size, mtime: s.mtime, contentType: name.endsWith(".mp4") ? "video/mp4" : "image/jpeg" };
    } catch {
      return null;
    }
  },

  async delete(name) {
    const file = mediaPath(name);
    if (!file) return "missing";
    try {
      await fs.unlink(file);
      return "deleted";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw e;
    }
  },

  url: (name) => `${mediaOrigin()}/m/${name}`,

  async freeBytes() {
    const dir = mediaDir();
    return dir ? freeBytesIn(dir) : Infinity;
  },

  /**
   * Rule 1762: write a tiny file, read it back, delete it, and keep a sentinel that names every build that found the
   * store. If a build wipes the folder the sentinel goes with it, and the count starts again at 0. Never throws.
   */
  async probe(): Promise<StorageProbe> {
    const out: StorageProbe = { status: "ok", survivedBuilds: null, freeBytes: null };
    const dir = mediaDir();
    if (!dir) return { ...out, status: "error:no_store" };
    const check = path.join(dir, ".tmp", `check-${randomBytes(8).toString("hex")}.part`);
    try {
      await ensureDir(path.dirname(check));
      await fs.writeFile(check, "ok", { flag: "wx", mode: 0o600 });
    } catch {
      return { ...out, status: "error:write_failed" };
    }
    let read = "";
    try {
      read = await fs.readFile(check, "utf8");
    } catch {}
    try {
      await fs.unlink(check);
    } catch {
      return { ...out, status: "error:del_failed" };
    }
    if (read !== "ok") return { ...out, status: "error:read_failed" };
    const free = await freeBytesIn(dir);
    out.freeBytes = Number.isFinite(free) ? free : null;
    const build = process.env.BUILD_COMMIT || "unknown";
    try {
      const seen = await fs.readFile(path.join(dir, SENTINEL), "utf8").then((t) => (JSON.parse(t) as { builds?: unknown }).builds).catch(() => null);
      const builds = Array.isArray(seen) ? seen.filter((b): b is string => typeof b === "string") : [];
      if (!builds.includes(build)) builds.push(build);
      await fs.writeFile(path.join(dir, SENTINEL), JSON.stringify({ builds: builds.slice(-100) }), { mode: 0o600 });
      out.survivedBuilds = Math.max(0, builds.length - 1);
    } catch {
      out.survivedBuilds = null;
    }
    return out;
  },
};
