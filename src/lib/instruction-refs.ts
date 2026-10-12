import { db } from "./db";
import { csvSafe } from "./admin-stats";
import { FileLimitError, listFileNames, safeName, writeFile } from "./files";
import { getConnection } from "./connectors/store";
import { composioEnabled, composioRead } from "./connectors/composio";
import { findKey, isComposio, listOf } from "./connectors/composio-shape";
import { refsKey } from "./instructions-store";

/**
 * Google Docs and Google Sheets as reference files for the agent instructions (rules 955-956, spec 2026-10-10 agent
 * skills portal 8.3). Read only: the two search tools and the two read tools of the catalog, nothing else
 * (composio-catalog.ts lists no write tool for either toolkit). What a read returns is untrusted text; it becomes an
 * ordinary workspace file `ref-<slug>.md` written as the owner's (`by: "user"`). Like every workspace file it can be read
 * back raw by the chat and MCP `read_file` tools as a tool result, and the agent instructions render it inside
 * <reference_files> as escaped data (agent-instructions.ts `asData`); it is never placed in a system prompt unfenced.
 *
 * The connected account is the one stored for the caller's own scope (`sc(u)`, passed in by the route). The query and
 * the document id are only ever tool arguments: no Redis key is built from either. The only key written here is
 * `skillrefs:{scope}` (a hash: file name -> where it came from, for Refresh), which `instructionKeys` hands to the wipe.
 */
export type RefKind = "doc" | "sheet";
export type RefHit = { id: string; title: string; kind: RefKind; modified?: string };
export type RefSource = { source: "gdocs" | "gsheets"; id: string; title: string; at: string };
/** Why a search or an import failed, as the routes answer it. `upstream` carries none of Composio's text. */
export type RefError = "not_connected" | "not_found" | "empty" | "files_full" | "upstream";
export class RefFail extends Error {
  constructor(readonly code: RefError) { super(code); this.name = "RefFail"; }
}

/** A Google file id: letters, digits, `_` and `-`. Checked before anything is sent, wherever the id came from. */
export const REF_ID = /^[A-Za-z0-9_-]{10,100}$/;
export const REF_QUERY_MAX = 100;
export const REF_TITLE_MAX = 120;
export const REF_MAX_CHARS = 20_000;
const MAX_RESULTS = 10;
const SHEET_RANGE = "A1:Z200";
const CELL_MAX = 500;
const SLUG_MAX = 40;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string, max: number) => s.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, max);

type Accounts = { docs?: string; sheets?: string };

/** The Docs and Sheets logins of this scope. Not connected, reconnect pending, or Composio off all read the same. */
async function accountsOf(scope: string): Promise<Accounts> {
  if (!composioEnabled("google_workspace")) throw new RefFail("not_connected");
  const c = await getConnection(scope, "google_workspace");
  if (!c || !isComposio(c) || c.needsReconnect) throw new RefFail("not_connected");
  const one = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const a = { docs: one(c.data.googledocs), sheets: one(c.data.googlesheets) };
  if (!a.docs && !a.sheets) throw new RefFail("not_connected");
  return a;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

function hitsOf(data: unknown, kind: RefKind): RefHit[] {
  const rows = [listOf(data, "id"), listOf(data, kind === "doc" ? "documentId" : "spreadsheetId")].find((r) => r.length) ?? [];
  const out: RefHit[] = [];
  for (const r of rows) {
    const id = text(r.id) || text(r.documentId) || text(r.spreadsheetId);
    if (!REF_ID.test(id)) continue;
    const title = clean(text(r.name) || text(r.title), REF_TITLE_MAX);
    const modified = clean(text(r.modifiedTime) || text(r.modified_time) || text(r.modifiedAt), 40);
    out.push({ id, title: title || (kind === "doc" ? "Untitled document" : "Untitled spreadsheet"), kind, ...(modified ? { modified } : {}) });
  }
  return out;
}

/** The workspace's own documents and sheets matching `query` (the newest ten of both). An empty query lists recent ones. */
export async function searchRefs(scope: string, query: string): Promise<RefHit[]> {
  const a = await accountsOf(scope);
  const q = clean(query, REF_QUERY_MAX);
  const args = { ...(q ? { query: q } : {}), max_results: MAX_RESULTS };
  const jobs: Promise<RefHit[]>[] = [];
  if (a.docs) jobs.push(composioRead(scope, "googledocs", "GOOGLEDOCS_SEARCH_DOCUMENTS", args, a.docs).then((d) => hitsOf(d, "doc")));
  if (a.sheets) jobs.push(composioRead(scope, "googlesheets", "GOOGLESHEETS_SEARCH_SPREADSHEETS", args, a.sheets).then((d) => hitsOf(d, "sheet")));
  const done = await Promise.allSettled(jobs);
  const ok = done.filter((d): d is PromiseFulfilledResult<RefHit[]> => d.status === "fulfilled");
  if (!ok.length) throw new RefFail("upstream");
  return ok.flatMap((d) => d.value).sort((x, y) => (y.modified ?? "").localeCompare(x.modified ?? "")).slice(0, MAX_RESULTS);
}

/** Whether a search or an import can run for this workspace now: Composio on, and a Docs or Sheets login stored. */
export async function refsAvailable(scope: string): Promise<boolean> {
  try {
    await accountsOf(scope);
    return true;
  } catch {
    return false;
  }
}

/** Where each imported file came from, by file name; entries that are not well formed are left out. */
export async function refRecords(scope: string): Promise<Record<string, RefSource>> {
  const raw = await db.hgetall<unknown>(refsKey(scope));
  const out: Record<string, RefSource> = {};
  for (const [name, v] of Object.entries(raw ?? {})) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if ((r.source !== "gdocs" && r.source !== "gsheets") || typeof r.id !== "string" || !REF_ID.test(r.id)) continue;
    out[name] = { source: r.source, id: r.id, title: typeof r.title === "string" ? r.title.slice(0, REF_TITLE_MAX) : "", at: typeof r.at === "string" ? r.at : "" };
  }
  return out;
}

/**
 * Lowercase Latin or Arabic letters and digits of `s`, joined by `-`, at most 40 characters. Marks (Arabic harakat,
 * decomposed accents) and the tatweel are dropped first, so they do not split a word: "مُحَمَّد" is `محمد`.
 */
export function refSlug(s: string): string {
  const words = s.normalize("NFKC").replace(/[\p{M}\u0640]/gu, "").toLowerCase().match(/[\p{Script=Latin}\p{Script=Arabic}\p{N}]+/gu) ?? [];
  return words.join("-").slice(0, SLUG_MAX).replace(/-+$/, "");
}

/** The text of a Doc, cut at 20,000 characters. */
function docText(data: unknown): string {
  const t = typeof data === "string" ? data : findKey(data, ["plaintext", "plain_text", "text", "content", "document_text", "body"], (v) => typeof v === "string");
  return (typeof t === "string" ? t : "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trim().slice(0, REF_MAX_CHARS);
}

/** A Sheet's values as CSV: every cell through csvSafe, whole rows only, at most 20,000 characters. */
function sheetCsv(data: unknown): string {
  const values = findKey(data, ["values"], Array.isArray);
  if (!Array.isArray(values)) return "";
  const cell = (c: unknown) => {
    const s = typeof c === "string" || typeof c === "number" || typeof c === "boolean" ? String(c) : "";
    return `"${csvSafe(s.replace(CONTROL, "").slice(0, CELL_MAX)).replace(/"/g, '""')}"`;
  };
  const lines: string[] = [];
  let size = 0;
  for (const row of values) {
    if (!Array.isArray(row) || !row.some((c) => c !== null && c !== undefined && c !== "")) continue;
    const line = row.slice(0, 26).map(cell).join(",");
    if (size + line.length + 1 > REF_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

const NOT_FOUND = /not.?found|\b404\b|does not exist|no such/i;

/**
 * Import one Doc or Sheet as a workspace file and remember where it came from. The same source id always lands in its
 * own file (a Refresh), whatever the title is now. A Refresh is an explicit overwrite of the imported file: edits the
 * owner made to it are replaced by the source's text, as the owner asked by pressing it; a different source whose title makes the same slug gets `-2`, `-3`;
 * a different source never takes a name already in use. A Refresh overwrites whatever file is at the recorded name,
 * including one the owner wrote there after deleting the imported file (the record is dropped only when a Refresh finds the name free).
 */
export async function importRef(scope: string, src: { kind: RefKind; id: string; title?: string }): Promise<{ ok: true; name: string; title: string } | { ok: false; error: RefError }> {
  try {
    if (!REF_ID.test(src.id)) throw new RefFail("not_found");
    const a = await accountsOf(scope);
    const account = src.kind === "doc" ? a.docs : a.sheets;
    if (!account) throw new RefFail("not_connected");
    let body: string;
    try {
      body = src.kind === "doc"
        ? docText(await composioRead(scope, "googledocs", "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", { document_id: src.id, include_tables: true }, account))
        : sheetCsv(await composioRead(scope, "googlesheets", "GOOGLESHEETS_VALUES_GET", { spreadsheet_id: src.id, range: SHEET_RANGE }, account));
    } catch (e) {
      throw new RefFail(e instanceof Error && NOT_FOUND.test(e.message) ? "not_found" : "upstream");
    }
    if (!body.trim()) throw new RefFail("empty");

    const source = src.kind === "doc" ? "gdocs" : "gsheets";
    const [records, names] = await Promise.all([refRecords(scope), listFileNames(scope)]);
    const taken = new Set(names);
    let own = Object.entries(records).find(([, r]) => r.source === source && r.id === src.id)?.[0];
    // The record of this source points at a file that is gone (the owner deleted it): the record is dropped and the
    // import is a new one, named again below. It never writes into a name the owner may have taken since.
    if (own && !taken.has(own)) {
      await db.hdel(refsKey(scope), own);
      delete records[own];
      own = undefined;
    }
    const title = clean(src.title ?? "", REF_TITLE_MAX);
    let name = own;
    if (!name) {
      const fallback = src.kind === "doc" ? "doc" : "sheet";
      const slug = refSlug(title || (src.kind === "doc" ? body.split("\n").find((l) => l.trim()) ?? "" : "")) || fallback;
      for (let n = 1; n <= 500 && !name; n++) {
        const candidate = safeName(n === 1 ? `ref-${slug}.md` : `ref-${slug}-${n}.md`);
        if (!taken.has(candidate)) name = candidate;
      }
      if (!name) throw new RefFail("files_full");
    }
    try {
      await writeFile(scope, name, body, "user");
    } catch (e) {
      if (e instanceof FileLimitError) throw new RefFail("files_full");
      throw e;
    }
    const shown = title || records[name]?.title || name;
    await db.hset(refsKey(scope), name, { source, id: src.id, title: shown, at: new Date().toISOString() } satisfies RefSource);
    return { ok: true, name, title: shown };
  } catch (e) {
    if (e instanceof RefFail) return { ok: false, error: e.code };
    return { ok: false, error: "upstream" };
  }
}
