"use client";
import { useState, useSyncExternalStore } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { WaitingInvite } from "@/lib/team";
import type { WorkspaceRow } from "@/lib/workspaces";
import { dateFormat } from "@/lib/dates";
import { appHref } from "@/lib/ws-path";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import EmptyState from "@/components/ui/EmptyState";
import { Field, Input } from "@/components/ui/Field";
import PageHeader from "@/components/ui/PageHeader";

type T = AppDict["workspaces"];

/** The page's URL fragment, read as an external store: "" on the server, so the offer card renders only in the browser. */
const onHash = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
const XFER = /^#xfer=(w_[a-z2-7]{16})\.([a-f0-9]{64})$/;

/**
 * The workspaces page's body (multi-workspace M2, spec section 16): the person's workspaces with their role, open one
 * (the switch route, then a full load of its link so the whole shell is rendered for it), and create one. The routes
 * check everything; the button state only mirrors them.
 */
export default function WorkspacesPanel({ t, lang, initial, invites = [], canCreate }: { t: T; lang: "ar" | "en"; initial: WorkspaceRow[]; invites?: WaitingInvite[]; canCreate: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const message = (code: unknown) => (typeof code === "string" && code in t.errors ? t.errors[code as keyof T["errors"]] : t.errors.failed);
  // Multi-workspace M3 (rule 2751): an ownership offer arrives as `#xfer={handle}.{token}` in the mailed link. The fragment
  // never reaches a server log; it is read here, sent once in a POST body on Accept, and cleared on "Not now".
  const hash = useSyncExternalStore(onHash, () => window.location.hash, () => "");
  const [dismissed, setDismissed] = useState(false);
  const found = dismissed ? null : XFER.exec(hash);
  const xfer = found ? { handle: found[1], token: found[2] } : null;
  function later() {
    setDismissed(true);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

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
      setError(key === "xfer" && j.error === "rate_limited" ? t.xferRate : message(j.error));
    } catch {
      setError(t.errors.failed);
    }
    setBusy(null);
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <PageHeader lang={lang} title={t.title} sub={t.sub} seed="workspaces" />
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {xfer && (
        <section className="grid gap-3 rounded-lg border border-border p-4" aria-labelledby="ws-xfer" data-xfer>
          <h2 id="ws-xfer" className="font-display text-lg font-bold">{t.xferTitle}</h2>
          <p className="text-sm text-foreground-muted">{t.xferText}</p>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy === "xfer"} disabled={!!busy} onClick={() => go("/api/workspaces/transfer", { handle: xfer.handle, token: xfer.token }, "xfer")}>
              {t.xferAccept}
            </Button>
            <Button variant="secondary" disabled={!!busy} onClick={later}>
              {t.xferLater}
            </Button>
          </div>
        </section>
      )}
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
      {invites.length > 0 && (
        <section className="grid gap-2 rounded-lg border border-border p-4" aria-labelledby="ws-invites">
          <h2 id="ws-invites" className="font-display text-lg font-bold">{t.invites.replace("{n}", String(invites.length))}</h2>
          <ul className="grid gap-2">
            {invites.map((i, k) => (
              <li key={k} className="text-sm">
                <span className="block text-foreground" dir="auto">{t.inviteRow.replace("{inviter}", i.inviter).replace("{workspace}", i.workspace).replace("{role}", t.roles[i.role])}</span>
                <span className="text-foreground-muted">{t.inviteUntil.replace("{date}", dateFormat(lang, { dateStyle: "medium" }).format(new Date(i.expiresAt)))}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-foreground-muted">{t.invitesHint}</p>
        </section>
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
