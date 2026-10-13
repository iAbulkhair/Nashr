"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import type { LibraryItem } from "@/lib/media/store";
import type { DriveHit } from "@/lib/cloud-drives";
import DriveExport, { driveError, loadDrives, type DriveRow } from "./DriveExport";
import { useConfirm } from "./ConfirmDialog";

/**
 * The workspace's media library (rules 1781-1787): upload from the device, import from a connected cloud drive, delete,
 * save to a drive. `canWrite` = `can(u, "library.write")`, display only: the routes refuse the same roles.
 *
 * The image input names only the types we keep and the text input only TXT, MD and CSV. On an iPhone or iPad either
 * input opens the Files picker, which includes iCloud Drive: that is how iCloud files reach Thakeen (rule 1787).
 */
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif";
const TEXT_ACCEPT = ".txt,.md,.csv,text/plain,text/markdown,text/csv";
const TEXT_MAX_BYTES = 120_000;

type Listing = { library?: LibraryItem[]; drives?: DriveRow[]; store?: boolean } | null;
const load = (): Promise<Listing> => fetch("/api/drives").then((r) => r.json() as Promise<Listing>).catch(() => null);

export default function LibraryPanel({ t, canWrite = true }: { t: AppDict; canWrite?: boolean }) {
  const l = t.library;
  const r = useRouter();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [drives, setDrives] = useState<DriveRow[]>([]);
  const [store, setStore] = useState(true);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState<Record<string, string>>({});
  const [hits, setHits] = useState<Record<string, DriveHit[] | null>>({});
  const image = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLInputElement>(null);
  const [ask, confirmDialog] = useConfirm();

  function apply(j: Listing) {
    setItems(j?.library ?? []);
    setDrives(j?.drives ?? []);
    setStore(j?.store !== false);
  }
  async function refresh() {
    apply(await load());
    void loadDrives(true);
  }
  useEffect(() => {
    let live = true;
    void load().then((j) => {
      if (!live) return;
      setItems(j?.library ?? []);
      setDrives(j?.drives ?? []);
      setStore(j?.store !== false);
    });
    return () => { live = false; };
  }, []);

  async function uploadImage(f: File | undefined) {
    if (!f) return;
    setBusy("upload");
    setMsg(l.uploading);
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/media/upload", { method: "POST", body: fd }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    setMsg(res?.ok && j?.ok ? l.uploaded : driveError(t, res?.status ?? 0, j?.error));
    setBusy("");
    if (res?.ok) void refresh();
  }

  /** A text file goes through the Files page's own route: it becomes an ordinary workspace file written by the owner. */
  async function uploadText(f: File | undefined) {
    if (!f) return;
    if (f.size > TEXT_MAX_BYTES) return setMsg(l.errors.too_large);
    setBusy("upload");
    const content = (await f.text().catch(() => "")).trim();
    if (!content) {
      setBusy("");
      return setMsg(l.errors.empty);
    }
    const name = `upload-${f.name.replace(/\.[^.]+$/, "")}.${/\.csv$/i.test(f.name) ? "csv" : "md"}`;
    const res = await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; file?: { name: string } } | null;
    setMsg(res?.ok && j?.ok ? `${l.uploadedText} ${j.file?.name ?? name}` : driveError(t, res?.status ?? 0, j?.error));
    setBusy("");
    if (res?.ok) r.refresh();
  }

  async function search(d: DriveRow["id"]) {
    const words = (q[d] ?? "").trim();
    if (!words) return;
    setBusy(`search:${d}`);
    setMsg("");
    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", drive: d, q: words }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; results?: DriveHit[] } | null;
    if (res?.ok && j?.ok) setHits((p) => ({ ...p, [d]: j.results ?? [] }));
    else setMsg(driveError(t, res?.status ?? 0, j?.error));
    setBusy("");
  }

  async function importOne(d: DriveRow["id"], h: DriveHit) {
    setBusy(`import:${h.id}`);
    setMsg(l.importing);
    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import", drive: d, id: h.id, name: h.name }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; imported?: { kind: string; file?: string } } | null;
    if (res?.ok && j?.ok) {
      setMsg(j.imported?.kind === "text" ? `${l.importedText} ${j.imported.file}` : l.importedMedia);
      if (j.imported?.kind === "text") r.refresh();
      else void refresh();
    } else setMsg(driveError(t, res?.status ?? 0, j?.error));
    setBusy("");
  }

  async function remove(name: string) {
    if (!(await ask({ title: l.delete, message: l.deleteAsk, confirmLabel: l.delete, cancelLabel: t.dialog.back, destructive: true }))) return;
    const res = await fetch(`/api/drives?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setItems((p) => p.filter((x) => x.name !== name));
    else setMsg(driveError(t, res?.status ?? 0, null));
  }

  return (
    <section className="mt-8 grid gap-4" aria-labelledby="library-title">
      {confirmDialog}
      <div>
        <h2 id="library-title" className="text-lg font-semibold">{l.title}</h2>
        <p className="text-sm text-foreground-muted">{l.sub}</p>
      </div>
      {canWrite && (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!!busy || !store} onClick={() => image.current?.click()} className="btn btn-primary btn-sm">{l.upload}</button>
            <button type="button" disabled={!!busy} onClick={() => text.current?.click()} className="btn btn-secondary btn-sm">{l.uploadText}</button>
            <input ref={image} type="file" accept={IMAGE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void uploadImage(e.target.files?.[0]); e.target.value = ""; }} />
            <input ref={text} type="file" accept={TEXT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void uploadText(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <p className="text-xs text-foreground-muted">{l.uploadHint}</p>
          <p className="text-xs text-foreground-muted">{l.icloud}</p>
          {!store && <p className="text-xs text-foreground-muted">{l.noStore}</p>}
        </div>
      )}
      {msg && <p role="status" className="text-sm">{msg}</p>}

      {canWrite && drives.map((d) => (
        <div key={d.id} className="grid gap-2 rounded-lg border border-border p-3">
          <p className="text-sm font-semibold">{l.searchIn} {l.drives[d.id]}</p>
          {d.connected ? (
            <>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(d.id); }}>
                <input value={q[d.id] ?? ""} onChange={(e) => setQ((p) => ({ ...p, [d.id]: e.target.value }))} maxLength={100} placeholder={l.searchPh} dir="auto" className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-sm" />
                <button type="submit" disabled={!!busy} className="btn btn-secondary btn-sm">{busy === `search:${d.id}` ? l.searching : l.search}</button>
              </form>
              {hits[d.id] && (hits[d.id]!.length ? (
                <ul className="grid gap-1 text-sm">
                  {hits[d.id]!.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate" dir="auto">{h.name}</span>
                      <button type="button" disabled={!!busy} onClick={() => importOne(d.id, h)} className="btn btn-secondary btn-xs">{busy === `import:${h.id}` ? l.importing : l.import}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-foreground-muted">{l.noResults}</p>)}
            </>
          ) : <p className="text-xs text-foreground-muted">{l.connectHint}</p>}
        </div>
      ))}

      {items.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((x) => (
            <li key={x.name} className="grid gap-1 text-xs">
              {x.kind === "image"
                ? (
                  // eslint-disable-next-line @next/next/no-img-element -- our own private /m/ route, served with the session
                  <img loading="lazy" decoding="async" src={x.url} alt="" className="aspect-square w-full rounded-lg object-cover" />
                )
                : <video controls playsInline preload="metadata" src={`${x.url}#t=0.1`} className="aspect-square w-full rounded-lg bg-foreground/5" />}
              <span className="flex flex-wrap items-center gap-2">
                <a href={`${x.url}?download=1`} className="underline">{t.inbox.download}</a>
                {canWrite && <button type="button" onClick={() => remove(x.name)} className="btn btn-secondary btn-xs">{l.delete}</button>}
              </span>
              <DriveExport t={t} url={x.url} />
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-foreground-muted">{l.empty}</p>}
    </section>
  );
}
