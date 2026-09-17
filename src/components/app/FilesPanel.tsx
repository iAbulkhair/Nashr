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
      <h1 className="font-display text-3xl font-bold text-oasis">{f.title}</h1>
      <p className="mt-2 text-ink/70">{f.sub}</p>
      <div className="mt-6 grid gap-4 md:grid-cols-[260px_1fr]">
        <aside className="rounded-xl border border-ink/10 bg-white p-3">
          {files.length === 0 && <p className="p-2 text-sm text-ink/60">{f.empty}</p>}
          <ul className="grid gap-1">
            {files.map((x) => (
              <li key={x.name}>
                <button onClick={() => { setOpen(x.name); setEditing(false); }} className={`w-full rounded-lg px-3 py-2 text-start text-sm ${open === x.name ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`} dir="ltr">
                  <span className="font-mono">{x.name}</span>
                  <span className={`block text-[10px] ${open === x.name ? "text-mist-dim" : "text-ink/50"}`}>{x.updatedAt.slice(0, 10)} · {f.by[x.by]}</span>
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); if (newName) save(newName.endsWith(".md") ? newName : newName + ".md", "# " + newName + "\n"); setNewName(""); }} className="mt-3 flex gap-1">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={f.newFile} dir="ltr" className="min-w-0 flex-1 rounded border border-ink/15 px-2 py-1 text-xs" />
            <button className="rounded bg-oasis px-2 text-xs text-mist">+</button>
          </form>
        </aside>
        <section className="rounded-xl border border-ink/10 bg-white p-5">
          {cur ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-mono text-sm text-oasis" dir="ltr">{cur.name}</h2>
                <div className="flex gap-2 text-sm">
                  {editing ? (
                    <>
                      <button onClick={() => save(cur.name, draft)} className="rounded-full bg-oasis px-4 py-1.5 font-semibold text-mist">{f.save}</button>
                      <button onClick={() => setEditing(false)} className="rounded-full border border-ink/20 px-4 py-1.5">{f.cancel}</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setDraft(cur.content); setEditing(true); }} className="rounded-full border border-ink/20 px-4 py-1.5">{f.edit}</button>
                      <button onClick={() => del(cur.name)} className="rounded-full border border-sadu/40 px-4 py-1.5 text-sadu">{f.delete}</button>
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
