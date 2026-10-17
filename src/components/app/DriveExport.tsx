"use client";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { useToast } from "@/components/ui/Toast";

export type DriveRow = { id: "google_drive" | "dropbox" | "onedrive"; connected: boolean };

/** One read of GET /api/drives per page load, shared by every button on the page. */
let drivesOnce: Promise<DriveRow[]> | null = null;
export function loadDrives(fresh = false): Promise<DriveRow[]> {
  if (!drivesOnce || fresh) {
    drivesOnce = fetch("/api/drives")
      .then((r) => (r.ok ? r.json() : { drives: [] }))
      .then((j: { drives?: DriveRow[] }) => j.drives ?? [])
      .catch(() => []);
  }
  return drivesOnce;
}

/** The message for a refused call: the role for a 403, the route's own code when we have words for it. */
export function driveError(t: AppDict, status: number, code: unknown): string {
  const e = t.library.errors as Record<string, string>;
  if (status === 403) return e.forbidden;
  return typeof code === "string" && e[code] ? e[code] : e.generic;
}

/**
 * "Save to Google Drive / Dropbox / OneDrive" for one of the workspace's own files (rule 1782). Shows nothing until a
 * drive is connected: the drive list only names drives whose keys are set (rule 1786). The server checks the file
 * belongs to this workspace and the role; this is display only.
 */
export default function DriveExport({ t, url }: { t: AppDict; url: string }) {
  const l = t.library;
  const [drives, setDrives] = useState<DriveRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void loadDrives().then((d) => { if (live) setDrives(d.filter((x) => x.connected)); });
    return () => { live = false; };
  }, []);
  if (!drives.length) return null;
  async function save(id: DriveRow["id"]) {
    setBusy(id);
    setMsg("");
    const res = await fetch("/api/drives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", drive: id, url }) }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    // Rule 2001: saved and a plain failure are toasts; a role refusal (403) stays beside the buttons as an alert.
    if (res?.ok && j?.ok) toast.success(`${l.saved} ${l.drives[id]}`);
    else if (res?.status === 403) setMsg(driveError(t, 403, j?.error));
    else toast.danger(driveError(t, res?.status ?? 0, j?.error));
    setBusy(null);
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {drives.map((d) => (
        <button key={d.id} type="button" disabled={!!busy} onClick={() => save(d.id)} className="btn btn-secondary btn-xs">
          {busy === d.id ? l.saving : `${l.saveTo} ${l.drives[d.id]}`}
        </button>
      ))}
      {msg && <span role="alert">{msg}</span>}
    </span>
  );
}
