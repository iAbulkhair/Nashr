// Moves the old public Vercel Blob copies of generated images and videos into the private disk store (rule 1763,
// docs/system/flows.md "Media storage"). Run by hand ONCE, after the release that adds the disk store is live, on the
// machine whose disk holds MEDIA_DIR (the Hostinger app), never at build time and not as part of `npm run check`.
//
// Usage:  npx --no-install jiti scripts/media-blob-move.ts            (scan: read-only, prints counts)
//         npx --no-install jiti scripts/media-blob-move.ts --copy     (copy, then point each task at its new copy)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN and MEDIA_DIR already in the environment (set privately, never
// typed on a command line that is saved). jiti is the copy already in node_modules (see scripts/check-models.ts).
//
// Idempotent: a task is moved only while its field still holds the Blob URL it had when the copy started, under the
// task's own lock (`updateTask`), so a second run finds nothing left, and a task the owner changed meanwhile keeps the
// owner's change. Each copy is written under the scope the task is stored in (never one taken from input) and goes
// through the same checks as a provider result: safeFetch, https on every hop, the size cap, the magic bytes, the quota.
// A copy that cannot be made is counted by its error code and left as it is: the Blob URL keeps working (rule 679).
// If a run stops between the write and the task update, the file stays indexed under that scope and is deleted with the
// account; the next run makes a fresh copy.
//
// Output is counts only: no email, scope, task id, URL or file name is printed.
// Exit codes: 0 done (scan, or copy with no failure); 1 copy finished with at least one failure; 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { listBrands, scopeFor } from "../src/lib/brands";
import { updateTask, type Task } from "../src/lib/brand";
import { isOurMediaUrl, ourMediaName, type MediaKind } from "../src/lib/media-catalog";
import { download, sniff, toJpeg, writeToStore } from "../src/lib/media/store";
import { storeConfigured } from "../src/lib/media/config";
import { StoreError } from "../src/lib/media/types";

const FIELDS = { imageUrl: "image", videoUrl: "video" } as const satisfies Record<string, MediaKind>;
type Field = keyof typeof FIELDS;
const DOWNLOAD_MS: Record<MediaKind, number> = { image: 30_000, video: 120_000 };

/** An old Blob copy: ours (isOurMediaUrl) but not on the disk store. */
export const isLegacyBlob = (url: string | undefined) => isOurMediaUrl(url) && !ourMediaName(url);

/** The fields of one task that still point at a Blob copy. */
export function legacyFields(t: Task): Field[] {
  return (Object.keys(FIELDS) as Field[]).filter((f) => isLegacyBlob(t[f]));
}

export type MoveReport = { scopes: number; tasks: number; legacy: { image: number; video: number }; moved: number; changed: number; failed: Record<string, number> };

type Deps = { fetchBody?: (url: string, kind: MediaKind) => Promise<Buffer> };

/** Copy one Blob file into the store under `scope`, and point the task at it if it still holds that URL. */
async function moveOne(scope: string, taskId: string, field: Field, from: string, deps: Deps, r: MoveReport) {
  const kind = FIELDS[field];
  try {
    const raw = await (deps.fetchBody ?? ((u, k) => download(u, k, DOWNLOAD_MS[k])))(from, kind);
    const format = sniff(raw);
    if (kind === "image" ? !format || format === "mp4" : format !== "mp4") throw new StoreError("not_media");
    // Our Blob images were written by toJpeg already: keep their bytes rather than encode them a second time.
    const body = kind === "image" && format !== "jpeg" ? await toJpeg(raw) : raw;
    const stored = await writeToStore(body, kind, { scope, taskId });
    let moved = false;
    await updateTask(scope, taskId, (t) => {
      if (t[field] !== from) return null;
      moved = true;
      return { ...t, [field]: stored.url };
    });
    if (moved) r.moved++;
    else r.changed++;
  } catch (e) {
    const code = e instanceof StoreError ? e.code : "other";
    r.failed[code] = (r.failed[code] ?? 0) + 1;
  }
}

/** Scan every workspace of every account; with `copy`, move what it finds. Never throws for one task's failure. */
export async function moveBlobMedia(copy: boolean, deps: Deps = {}): Promise<MoveReport> {
  const r: MoveReport = { scopes: 0, tasks: 0, legacy: { image: 0, video: 0 }, moved: 0, changed: 0, failed: {} };
  const emails = await db.smembers("users:all");
  const scopes = (await pmap(emails, async (e) => (await listBrands(e)).map((b) => scopeFor(e, b.id)))).flat();
  r.scopes = scopes.length;
  const perScope = await pmap(scopes, async (s) => {
    const ids = await db.lrange(`tasks:${s}`, 0, -1);
    return (await mgetChunked<Task>(ids.map((id) => `task:${s}:${id}`))).filter((t): t is Task => !!t);
  });
  const work: { scope: string; taskId: string; field: Field; from: string }[] = [];
  for (const [i, s] of scopes.entries()) {
    const tasks = perScope[i];
    r.tasks += tasks.length;
    for (const t of tasks) for (const f of legacyFields(t)) {
      r.legacy[FIELDS[f]]++;
      work.push({ scope: s, taskId: t.id, field: f, from: t[f]! });
    }
  }
  if (copy) await pmap(work, (w) => moveOne(w.scope, w.taskId, w.field, w.from, deps, r), 4);
  return r;
}

async function main(): Promise<void> {
  const copy = process.argv.includes("--copy");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  if (copy && !storeConfigured()) {
    console.error("MEDIA_DIR must be set to an absolute folder outside the app (docs/system/variables.md).");
    process.exitCode = 2;
    return;
  }
  const r = await moveBlobMedia(copy);
  console.log(`Workspaces ${r.scopes}, tasks ${r.tasks}; on Vercel Blob: ${r.legacy.image} images, ${r.legacy.video} videos.`);
  if (copy) {
    const failed = Object.entries(r.failed).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
    console.log(`Moved ${r.moved}; changed by the owner meanwhile ${r.changed}; failed: ${failed}.`);
    process.exitCode = Object.keys(r.failed).length ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
