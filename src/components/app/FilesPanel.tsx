"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import type { WFile } from "@/lib/files";
import ReadOnlyNote from "./ReadOnlyNote";
import { readImportStream } from "./catalogImport";
import { useConfirm } from "./ConfirmDialog";
import Scribble from "@/components/Scribble";
import { useToast } from "@/components/ui/Toast";
import EmptyState from "@/components/ui/EmptyState";
import { emptyCopy } from "@/lib/empty-copy";

/**
 * `canImport` = `can(u, "catalog.import")`; `locked` = the core memory files this person may not write or delete
 * ("files.core.write" / "files.core.delete", admin and owner), computed on the server from CORE_FILES. Display only:
 * /api/catalog and /api/files refuse the same roles. Every call's answer is checked, so a refusal is never shown as
 * a success or as an import that never finishes.
 */
export default function FilesPanel({ t, files, canImport = true, locked = [] }: { t: AppDict; files: WFile[]; canImport?: boolean; locked?: string[] }) {
  const r = useRouter();
  const f = t.files;
  const toast = useToast();
  // The panel takes no lang prop, so it reads the language from the path as ShellError does (rule 2002).
  const lang = t.lang;
  const E = emptyCopy(lang, "files");
  const [open, setOpen] = useState<string | null>(files[0]?.name ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const cur = files.find((x) => x.name === open) ?? null;
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  // A 403 refusal (rule 2001) stays on the page for the person to act on; a plain failure is a toast.
  const [err, setErr] = useState("");
  const [ask, confirmDialog] = useConfirm();
  const isLocked = (name: string) => locked.includes(name);
  /** Shows a refused call: the role for a 403 stays inline, any other failure is a toast. */
  function fail(res: Response | null, generic: string) {
    if (res?.status === 403) setErr(t.team.errors.forbidden);
    else toast.danger(generic);
  }
  async function importCatalog() {
    setImporting(true);
    setErr("");
    setImportMsg(f.importing);
    try {
      const res = await fetch("/api/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
      // Only a 200 event stream is read as one. A refusal (403 JSON) or a plain-text error (400 no_site) has a body too,
      // but no event in it, so reading it as a stream left "Importing…" on screen for good.
      if (!res || !res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        setImportMsg("");
        fail(res, f.importFail); // rule 2001
        return;
      }
      // A dropped connection mid-stream, or a stream that ends without a result, is reported as a failed import.
      const end = await readImportStream(res.body, (p) => setImportMsg(`${f.importing} ${p}`));
      setImportMsg("");
      if (end.ok) toast.success(`${f.imported} ${end.count}`);
      else toast.danger(f.importFail);
      if (end.ok) {
        setOpen("products.md");
        r.refresh();
      }
    } finally {
      setImporting(false);
    }
  }

  async function save(name: string, content: string) {
    setErr("");
    const res = await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content }) }).catch(() => null);
    // A refused save keeps the editor open with the text in it.
    if (!res?.ok) { fail(res, t.team.errors.failed); return; }
    setEditing(false);
    r.refresh();
  }
  async function del(name: string) {
    if (!(await ask({ title: name, message: `${f.delete} ${name}?`, confirmLabel: f.delete, cancelLabel: t.dialog.back, destructive: true }))) return;
    setErr("");
    const res = await fetch(`/api/files?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) { fail(res, t.team.errors.failed); return; }
    setOpen(null);
    r.refresh();
  }

  return (
    <div>
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="filespanel-t1" />{f.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{f.sub}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canImport && <button disabled={importing} onClick={importCatalog} className="btn btn-primary btn-pill disabled:opacity-60">{f.importCatalog}</button>}
        {importMsg && <span role="status" className="text-sm text-foreground-muted">{importMsg}</span>}
      </div>
      {locked.length > 0 && <ReadOnlyNote text={t.readOnly.admin} />}
      {err && <p role="alert" className="mt-3 text-sm text-danger">{err}</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-[260px_1fr]">
        <aside className="rounded-xl border border-foreground/10 bg-surface p-3">
          {files.length === 0 && <EmptyState compact title={E.title} body={E.body} />}
          <ul className="grid gap-1">
            {files.map((x) => (
              <li key={x.name}>
                <button onClick={() => { setOpen(x.name); setEditing(false); }} className={`w-full rounded-lg px-3 py-2 text-start text-sm ${open === x.name ? "bg-inverse text-inverse-muted" : "hover:bg-background-muted"}`} dir="ltr">
                  <span className="font-mono">{x.name}</span>
                  <span className={`block text-xs ${open === x.name ? "text-inverse-muted/75" : "text-foreground-muted"}`}>{x.updatedAt.slice(0, 10)} · {f.by[x.by]}</span>
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); if (newName) save(newName.endsWith(".md") ? newName : newName + ".md", "# " + newName + "\n"); setNewName(""); }} className="mt-3 flex gap-1">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={f.newFile} dir="ltr" className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs" />
            <button className="rounded bg-inverse px-2 text-xs text-inverse-muted">+</button>
          </form>
        </aside>
        <section className="card">
          {cur ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-mono text-sm text-foreground" dir="ltr">{cur.name}</h2>
                <div className="flex gap-2 text-sm">
                  {editing ? (
                    <>
                      <button onClick={() => save(cur.name, draft)} className="btn btn-primary btn-pill">{f.save}</button>
                      <button onClick={() => setEditing(false)} className="btn btn-secondary btn-pill">{f.cancel}</button>
                    </>
                  ) : isLocked(cur.name) ? null : (
                    <>
                      <button onClick={() => { setDraft(cur.content); setEditing(true); setErr(""); }} className="btn btn-secondary btn-pill">{f.edit}</button>
                      <button onClick={() => del(cur.name)} className="btn btn-danger btn-pill">{f.delete}</button>
                    </>
                  )}
                </div>
              </div>
              {editing ? (
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} dir="auto" className="mt-4 w-full rounded-lg border border-border p-3 font-body text-sm leading-relaxed" />
              ) : (
                <pre className="mt-4 whitespace-pre-wrap font-body text-sm leading-relaxed" dir="auto">{cur.content}</pre>
              )}
            </>
          ) : (
            files.length === 0 ? null : <EmptyState compact title={E.title} body={E.body} />
          )}
        </section>
      </div>
      {confirmDialog}
    </div>
  );
}
