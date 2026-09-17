"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppDict } from "@/lib/app-i18n";
import type { WFile } from "@/lib/files";

export default function FilesPanel({ t, files }: { t: AppDict; files: WFile[] }) {
  const r = useRouter();
  const f = t.files;
  const [open, setOpen] = useState<string | null>(files[0]?.name ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const cur = files.find((x) => x.name === open) ?? null;
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  async function importCatalog() {
    setImporting(true);
    setImportMsg(f.importing);
    const res = await fetch("/api/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!res.body) { setImporting(false); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        try {
          const j = JSON.parse(p.replace(/^data: /, ""));
          if (j.progress) setImportMsg(`${f.importing} ${j.progress}`);
          if (j.done) setImportMsg(j.count ? `${f.imported} ${j.count}` : f.importFail);
          if (j.error) setImportMsg(f.importFail);
        } catch {}
      }
    }
    setImporting(false);
    setOpen("products.md");
    r.refresh();
  }

  async function save(name: string, content: string) {
    await fetch("/api/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content }) });
    setEditing(false);
    r.refresh();
  }
  async function del(name: string) {
    if (!confirm(`${f.delete} ${name}?`)) return;
    await fetch(`/api/files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    setOpen(null);
    r.refresh();
  }

  return (
    <div>
      <h1 className="page-title">{f.title}</h1>
      <p className="mt-2 text-ink/70">{f.sub}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button disabled={importing} onClick={importCatalog} className="btn btn-primary btn-pill disabled:opacity-60">{f.importCatalog}</button>
        {importMsg && <span role="status" className="text-sm text-ink/60">{importMsg}</span>}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-[260px_1fr]">
        <aside className="rounded-xl border border-ink/10 bg-white p-3">
          {files.length === 0 && <p className="p-2 text-sm text-ink/60">{f.empty}</p>}
          <ul className="grid gap-1">
            {files.map((x) => (
              <li key={x.name}>
                <button onClick={() => { setOpen(x.name); setEditing(false); }} className={`w-full rounded-lg px-3 py-2 text-start text-sm ${open === x.name ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`} dir="ltr">
                  <span className="font-mono">{x.name}</span>
                  <span className={`block text-xs ${open === x.name ? "text-mist-dim" : "text-ink/50"}`}>{x.updatedAt.slice(0, 10)} · {f.by[x.by]}</span>
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); if (newName) save(newName.endsWith(".md") ? newName : newName + ".md", "# " + newName + "\n"); setNewName(""); }} className="mt-3 flex gap-1">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={f.newFile} dir="ltr" className="min-w-0 flex-1 rounded border border-ink/15 px-2 py-1 text-xs" />
            <button className="rounded bg-oasis px-2 text-xs text-mist">+</button>
          </form>
        </aside>
        <section className="card">
          {cur ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-mono text-sm text-oasis" dir="ltr">{cur.name}</h2>
                <div className="flex gap-2 text-sm">
                  {editing ? (
                    <>
                      <button onClick={() => save(cur.name, draft)} className="btn btn-primary btn-pill">{f.save}</button>
                      <button onClick={() => setEditing(false)} className="btn btn-secondary btn-pill">{f.cancel}</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setDraft(cur.content); setEditing(true); }} className="btn btn-secondary btn-pill">{f.edit}</button>
                      <button onClick={() => del(cur.name)} className="btn btn-danger btn-pill">{f.delete}</button>
                    </>
                  )}
                </div>
              </div>
              {editing ? (
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} dir="auto" className="mt-4 w-full rounded-lg border border-ink/15 p-3 font-body text-sm leading-relaxed" />
              ) : (
                <pre className="mt-4 whitespace-pre-wrap font-body text-sm leading-relaxed" dir="auto">{cur.content}</pre>
              )}
            </>
          ) : (
            <p className="text-sm text-ink/60">{f.empty}</p>
          )}
        </section>
      </div>
    </div>
  );
}
