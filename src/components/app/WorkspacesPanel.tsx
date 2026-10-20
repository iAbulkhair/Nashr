"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { WorkspaceRow } from "@/lib/workspaces";
import { appHref } from "@/lib/ws-path";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import EmptyState from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import PageHeader from "@/components/ui/PageHeader";

type T = AppDict["workspaces"];

/**
 * The workspaces page's body (multi-workspace M2, spec section 16): the person's workspaces with their role, open one
 * (the switch route, then a full load of its link so the whole shell is rendered for it), and create one. The routes
 * check everything; the button state only mirrors them.
 */
export default function WorkspacesPanel({ t, lang, initial, canCreate }: { t: T; lang: "ar" | "en"; initial: WorkspaceRow[]; canCreate: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const message = (code: unknown) => (typeof code === "string" && code in t.errors ? t.errors[code as keyof T["errors"]] : t.errors.failed);

  async function go(url: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; href?: string; error?: string };
      if (j.ok && typeof j.href === "string" && j.href.startsWith(appHref(lang))) {
        window.location.assign(j.href);
        return;
      }
      setError(message(j.error));
    } catch {
      setError(t.errors.failed);
    }
    setBusy(null);
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <PageHeader lang={lang} title={t.title} sub={t.sub} seed="workspaces" />
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {initial.length === 0 ? (
        <EmptyState title={t.none} />
      ) : (
        <ul className="grid gap-2">
          {initial.map((w) => (
            <li key={w.handle} className="flex min-h-[var(--hit-min)] items-center justify-between gap-3 rounded-lg border border-border p-3">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-foreground">{w.name}</span>
                <span className="text-sm text-foreground-muted">{t.roles[w.role]}</span>
              </span>
              {w.current ? (
                <Badge tone="info">{t.current}</Badge>
              ) : (
                <Button variant="secondary" size="sm" loading={busy === w.handle} disabled={!!busy} onClick={() => go("/api/workspaces/switch", { handle: w.handle }, w.handle)}>
                  {t.open}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canCreate && (
        <form
          className="grid gap-3 rounded-lg border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void go("/api/workspaces", { name, lang }, "create");
          }}
        >
          <h2 className="font-display text-lg font-bold">{t.create}</h2>
          <Field label={t.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required dir="auto" />
          </Field>
          <p className="text-sm text-foreground-muted">{t.noTrial}</p>
          <div>
            <Button type="submit" loading={busy === "create"} loadingText={t.creating} disabled={!!busy || !name.trim()}>
              {t.submit}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
