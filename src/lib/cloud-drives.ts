import { getConnection } from "./connectors/store";
import { composioEnabled, composioReady, composioRead, composioStageFile, composioWrite } from "./connectors/composio";
import { PROVIDER_TOOLKITS, type Toolkit } from "./connectors/composio-catalog";
import { findKey, isComposio } from "./connectors/composio-shape";
import { FileLimitError, safeName, writeFile } from "./files";
import { LIBRARY_MAX, SOURCE_CAP_BYTES, download, listLibrary, mediaEntryOf, sniff, toJpeg, writeToStore, type LibrarySource } from "./media/store";
import { storeConfigured } from "./media/config";
import { StoreError } from "./media/types";
import type { MediaKind } from "./media-catalog";

/**
 * The customer's cloud drives (rules 1775-1789): Google Drive, Dropbox and OneDrive, each its own Composio connection.
 * Three things only, each started by a person's click in the app, never by a model, a chat tool or an MCP tool:
 *
 * - search: the person's words become one search call with a constant result cap and a constant type filter;
 * - import: one file, chosen from that search, is downloaded and checked before anything keeps it. Images become one of
 *   our JPEGs and MP4 videos stay MP4, both in the private media store under the caller's scope as library files (rule
 *   1781); plain text, Markdown and CSV become a workspace file named `drive-…` (never a core memory file);
 * - export: one of this workspace's own files in the store goes to the drive as a new file, staged through a short
 *   signed link (rule 1755); an export never overwrites (composio-catalog.ts `fixed`).
 *
 * The connected account is the one stored for the caller's own scope (`sc(u)`, passed in by the route). The query, the
 * file id and the file name are only ever tool arguments: no Redis key is built from any of them.
 *
 * iCloud Drive is not here, on purpose: Apple offers no public API for a third-party web app to read or write a person's
 * iCloud Drive. The device upload (POST /api/media/upload, and the Files page's text upload) works from the iPhone and
 * iPad Files picker, which includes iCloud Drive (rule 1787).
 */
export const DRIVE_IDS = ["google_drive", "dropbox", "onedrive"] as const;
export type DriveId = (typeof DRIVE_IDS)[number];
export const isDrive = (s: unknown): s is DriveId => typeof s === "string" && (DRIVE_IDS as readonly string[]).includes(s);

export type FileKind = MediaKind | "text";
export type DriveHit = { id: string; name: string; kind: FileKind; bytes?: number; modified?: string };
export type DriveError =
  | "not_connected" | "bad_request" | "unsupported" | "too_large" | "not_media" | "not_text" | "empty"
  | "library_full" | "files_full" | "store_full" | "no_store" | "upstream";
export class DriveFail extends Error {
  constructor(readonly code: DriveError) { super(code); this.name = "DriveFail"; }
}

export const QUERY_MAX = 100;
export const NAME_MAX = 120;
/** Results asked for and kept, whatever the drive answers. */
export const RESULTS_MAX = 25;
/** A text file read into the workspace (rule 1779): writeFile keeps at most 40,000 characters, 3 bytes a character. */
export const TEXT_MAX_BYTES = 120_000;
const DOWNLOAD_MS: Record<FileKind, number> = { image: 30_000, video: 120_000, text: 15_000 };

const EXT: Record<string, FileKind> = { jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", mp4: "video", txt: "text", md: "text", csv: "text" };
const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();
/** What a file is from its name; null for anything we do not import. The bytes are checked again after the download. */
export const kindOfName = (name: string): FileKind | null => EXT[extOf(name)] ?? null;

/** Ids as each drive writes them; checked before anything is sent, wherever the id came from. */
const ID: Record<DriveId, RegExp> = {
  google_drive: /^[A-Za-z0-9_-]{10,200}$/,
  dropbox: /^id:[A-Za-z0-9_-]{6,120}$/,
  onedrive: /^[A-Za-z0-9!._-]{5,200}$/,
};

const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (s: string, max: number) => s.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);
/** A name as a tool argument and a label: no control characters, no path separators. */
export const cleanName = (s: unknown) => (typeof s === "string" ? clean(s, NAME_MAX).replace(/[\\/]/g, "-") : "");

const toolkitOf = (d: DriveId): Toolkit => PROVIDER_TOOLKITS[d][0];

/** The drive login of this scope. Not connected, reconnect pending, or Composio off all read the same. */
async function accountOf(scope: string, d: DriveId): Promise<string> {
  if (!composioEnabled(d)) throw new DriveFail("not_connected");
  const c = await getConnection(scope, d);
  const id = c && isComposio(c) && !c.needsReconnect ? c.data[toolkitOf(d)] : undefined;
  if (!id) throw new DriveFail("not_connected");
  return id;
}

/** Composio's text never leaves this file: a refused or failed call is `upstream`, or `not_connected` for a dead login. */
function upstream(e: unknown): DriveFail {
  if (e instanceof DriveFail) return e;
  const m = e instanceof Error ? e.message : "";
  return new DriveFail(/ 401:/.test(m) || m === "not_connected" ? "not_connected" : "upstream");
}

/** Google's query language: the person's words go inside one quoted string, with its quote and backslash escaped. */
const gq = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const GOOGLE_TYPES = "(mimeType contains 'image/' or mimeType = 'video/mp4' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/csv')";

/** Every object in the answer that looks like a file: an id and a name, at most six levels down, at most 200. */
function filesIn(data: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let level: unknown[] = [data];
  for (let depth = 0; depth < 6 && level.length && out.length < 200; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) { next.push(...v); continue; }
      const r = v as Record<string, unknown>;
      if (typeof r.id === "string" && typeof r.name === "string") out.push(r);
      else next.push(...Object.values(r));
    }
    level = next;
  }
  return out;
}

/** A row of a drive's answer as a hit we can import; null for a folder, an unsupported type or a malformed id. */
function hitOf(d: DriveId, r: Record<string, unknown>): DriveHit | null {
  const id = String(r.id);
  if (!ID[d].test(id)) return null;
  if (r.folder || r[".tag"] === "folder" || r.mimeType === "application/vnd.google-apps.folder") return null;
  const name = cleanName(r.name);
  const kind = name ? kindOfName(name) : null;
  if (!kind) return null;
  const size = Number(r.size);
  const modified = [r.modifiedTime, r.server_modified, r.lastModifiedDateTime].find((x) => typeof x === "string") as string | undefined;
  return { id, name, kind, ...(r.size != null && Number.isFinite(size) && size >= 0 ? { bytes: size } : {}), ...(modified ? { modified: clean(modified, 40) } : {}) };
}

/** Rule 1778: one search call; the person's words are an argument, the result count and the type filter are constants. */
export async function searchDrive(scope: string, d: DriveId, query: string): Promise<DriveHit[]> {
  const q = clean(String(query ?? ""), QUERY_MAX);
  if (!q) throw new DriveFail("bad_request");
  const account = await accountOf(scope, d);
  let data: unknown;
  try {
    if (d === "google_drive") data = await composioRead(scope, "googledrive", "GOOGLEDRIVE_FIND_FILE", { q: `name contains '${gq(q)}' and trashed = false and ${GOOGLE_TYPES}`, pageSize: RESULTS_MAX }, account);
    else if (d === "dropbox") data = await composioRead(scope, "dropbox", "DROPBOX_SEARCH_FILE_OR_FOLDER", { query: q, options: { max_results: RESULTS_MAX, file_status: "active", filename_only: true } }, account);
    else data = await composioRead(scope, "one_drive", "ONE_DRIVE_SEARCH_ITEMS", { q, top: RESULTS_MAX }, account);
  } catch (e) {
    throw upstream(e);
  }
  const seen = new Set<string>();
  const hits: DriveHit[] = [];
  for (const r of filesIn(data)) {
    const h = hitOf(d, r);
    if (h && !seen.has(h.id)) { seen.add(h.id); hits.push(h); }
    if (hits.length >= RESULTS_MAX) break;
  }
  return hits;
}

const capOf = (kind: FileKind) => (kind === "text" ? TEXT_MAX_BYTES : SOURCE_CAP_BYTES[kind]);

/**
 * The file's bytes from a download tool's answer: a temporary `s3url` fetched through safeFetch over https on every hop
 * and capped while it streams (store.ts `download`), or inline base64 (Dropbox's `file_content_bytes`) measured before
 * it is decoded. Nothing else in the answer is fetched or kept.
 */
async function bytesOf(data: unknown, kind: FileKind, deps: ImportDeps): Promise<Buffer> {
  const cap = capOf(kind);
  const url = findKey(data, ["s3url", "s3Url"], (v) => typeof v === "string" && v.startsWith("https://"), 6) as string | undefined;
  if (url) {
    try {
      return await (deps.fetchBody ?? ((u, k, c) => download(u, k === "text" ? "image" : k, DOWNLOAD_MS[k], c)))(url, kind, cap);
    } catch (e) {
      throw new DriveFail(e instanceof StoreError && e.code === "too_large" ? "too_large" : "upstream");
    }
  }
  const b64 = findKey(data, ["file_content_bytes"], (v) => typeof v === "string" && !!v, 6) as string | undefined;
  if (!b64) throw new DriveFail("upstream");
  if (Math.floor((b64.length * 3) / 4) > cap + 2) throw new DriveFail("too_large");
  return Buffer.from(b64, "base64");
}

/** UTF-8 text with no NUL byte, without its BOM; anything else is `not_text`. */
export function textOf(raw: Buffer): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new DriveFail("not_text");
  }
  if (s.includes("\u0000")) throw new DriveFail("not_text");
  return s.replace(/^﻿/, "");
}

export type ImportDeps = { fetchBody?: (url: string, kind: FileKind, cap: number) => Promise<Buffer> };
export type Imported = { kind: "image" | "video"; url: string; name: string } | { kind: "text"; file: string };

/** Keep checked media bytes as one library file of this scope (rules 1779-1781). Shared by the drive import and the device upload. */
export async function keepInLibrary(scope: string, raw: Buffer, kind: MediaKind, source: LibrarySource): Promise<{ url: string; name: string }> {
  if (!storeConfigured()) throw new DriveFail("no_store");
  const format = sniff(raw);
  if (kind === "image" ? !format || format === "mp4" : format !== "mp4") throw new DriveFail("not_media");
  if ((await listLibrary(scope)).length >= LIBRARY_MAX) throw new DriveFail("library_full");
  try {
    // An image is re-encoded whatever it was: one upright JPEG, its metadata (location, camera) left behind.
    const body = kind === "image" ? await toJpeg(raw) : raw;
    const stored = await writeToStore(body, kind, { scope, taskId: "", source });
    return { url: stored.url, name: stored.url.slice(stored.url.lastIndexOf("/") + 1) };
  } catch (e) {
    const code = e instanceof StoreError ? e.code : "";
    throw new DriveFail(code === "too_large" ? "too_large" : code === "full" ? "store_full" : code === "no_store" ? "no_store" : code === "convert_failed" ? "not_media" : "upstream");
  }
}

/** Rules 1779-1780: import one file the person picked. The id and the name are checked here, wherever they came from. */
export async function importFromDrive(scope: string, d: DriveId, id: string, rawName: string, deps: ImportDeps = {}): Promise<Imported> {
  const name = cleanName(rawName);
  if (!ID[d].test(String(id ?? "")) || !name) throw new DriveFail("bad_request");
  const kind = kindOfName(name);
  if (!kind) throw new DriveFail("unsupported");
  if (kind !== "text" && !storeConfigured()) throw new DriveFail("no_store");
  const account = await accountOf(scope, d);
  let data: unknown;
  try {
    if (d === "google_drive") data = await composioRead(scope, "googledrive", "GOOGLEDRIVE_DOWNLOAD_FILE", { fileId: id }, account);
    else if (d === "dropbox") data = await composioRead(scope, "dropbox", "DROPBOX_READ_FILE", { path: id }, account);
    else data = await composioRead(scope, "one_drive", "ONE_DRIVE_DOWNLOAD_FILE", { item_id: id, file_name: name }, account);
  } catch (e) {
    throw upstream(e);
  }
  const raw = await bytesOf(data, kind, deps);
  if (!raw.length) throw new DriveFail("empty");
  if (raw.length > capOf(kind)) throw new DriveFail("too_large");
  if (kind === "text") {
    const content = textOf(raw).trim();
    if (!content) throw new DriveFail("empty");
    // Always `drive-…`: an import never lands on a core memory file (brand.md, products.md…), which a member may not write.
    const base = name.replace(/\.[^.]+$/, "");
    try {
      const f = await writeFile(scope, safeName(`drive-${base}.${extOf(name) === "csv" ? "csv" : "md"}`), content, "user");
      return { kind: "text", file: f.name };
    } catch (e) {
      throw new DriveFail(e instanceof FileLimitError ? "files_full" : "upstream");
    }
  }
  return { kind, ...(await keepInLibrary(scope, raw, kind, d)) };
}

/**
 * Rule 1782: send one of this workspace's own files to its drive as a new file. Only a file whose index entry is in the
 * caller's scope (a post's image or clip, or a library file) can leave, and only as a short signed link staged with
 * Composio; the drive keeps it private, and Dropbox and OneDrive add it beside any file of the same name.
 */
export async function exportToDrive(scope: string, d: DriveId, url: string): Promise<{ name: string }> {
  const entry = await mediaEntryOf(scope, url);
  if (!entry) throw new DriveFail("bad_request");
  const account = await accountOf(scope, d);
  const fileName = `thakeen-${entry.name.slice(0, 8)}.${entry.kind === "image" ? "jpg" : "mp4"}`;
  try {
    if (d === "google_drive") {
      const slug = entry.kind === "image" ? "GOOGLEDRIVE_UPLOAD_FILE" : "GOOGLEDRIVE_RESUMABLE_UPLOAD";
      const staged = await composioStageFile(scope, "googledrive", slug, url);
      await composioWrite(scope, "googledrive", slug, { file_to_upload: { ...staged, name: fileName } }, account);
    } else if (d === "dropbox") {
      const staged = await composioStageFile(scope, "dropbox", "DROPBOX_UPLOAD_FILE", url);
      await composioWrite(scope, "dropbox", "DROPBOX_UPLOAD_FILE", { path: `/Thakeen/${fileName}`, content: { ...staged, name: fileName }, mode: "add", autorename: true }, account);
    } else {
      const staged = await composioStageFile(scope, "one_drive", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", url);
      await composioWrite(scope, "one_drive", "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", { file: { ...staged, name: fileName }, folder: "/Thakeen", conflict_behavior: "rename" }, account);
    }
  } catch (e) {
    throw upstream(e);
  }
  return { name: fileName };
}

/** A drive can be used now: Composio is on for it and its auth config is set (rule 1786). The route asks only this. */
export const driveReady = (d: DriveId) => composioReady(d);

/** Which drives this scope may use now (the provider is on and every auth config is set) and which are connected. */
export async function drivesOf(scope: string, ready: (d: DriveId) => boolean): Promise<{ id: DriveId; connected: boolean }[]> {
  const on = DRIVE_IDS.filter(ready);
  const conns = await Promise.all(on.map((d) => getConnection(scope, d)));
  return on.map((id, i) => {
    const c = conns[i];
    return { id, connected: !!c && isComposio(c) && !c.needsReconnect && !!c.data[toolkitOf(id)] };
  });
}
