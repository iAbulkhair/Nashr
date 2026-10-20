"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type RegistrationResponseJSON } from "@simplewebauthn/browser";
import type { Lang } from "@/lib/i18n";
import type { AppDict } from "@/lib/app-i18n";
import { dateFormat } from "@/lib/dates";
import { PASSKEY_NAME_MAX } from "@/lib/passkey-limits";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import PasswordField from "../PasswordField";
import SettingsCard, { type CardStatus } from "./SettingsCard";

type Copy = AppDict["passkeys"];
type Item = { ref: string; name: string; createdAt: string; lastUsedAt?: string; synced: boolean; transports: string[] };
type Proof = "password" | "code" | "none";
type List = { items: Item[]; max: number; enabled: boolean; proof: Proof };
type Answer = { ok?: boolean; error?: string; items?: Item[]; max?: number; enabled?: boolean; proof?: Proof; options?: PublicKeyCredentialCreationOptionsJSON; item?: Item };

/** WebAuthn support never changes while the page is open, so nothing is ever signalled. */
const noChange = () => () => {};
const unknownOnServer = (): boolean | null => null;

/**
 * Whether the card is rendered (rule 2429): once the browser's WebAuthn support is known, true or false. `null` (always on
 * the server and during hydration) renders nothing, so server and browser HTML agree (pre-flight ruling 15). A browser
 * without WebAuthn still lists, renames and removes, so a lost device's passkey can be removed from any browser; only
 * adding needs support.
 */
export const showPasskeyCard = (supported: boolean | null): boolean => supported !== null;
/** Whether the add button is offered: the browser supports WebAuthn and the off switch is not set (rules 2426, 2429). */
export const showAddButton = (enabled: boolean, supported: boolean | null): boolean => enabled && supported === true;

/** A default passkey name from the user agent: the device family, else `fallback`. Never sent anywhere but the name. */
export function deviceLabel(ua: string, fallback: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return fallback;
}

async function call(method: "GET" | "POST", body?: unknown): Promise<{ status: number; j: Answer }> {
  const res = await fetch("/api/account/passkeys", { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
  return { status: res?.status ?? 0, j: ((await res?.json().catch(() => ({}))) ?? {}) as Answer };
}

/** What one add attempt came to. `stage` says which request refused, so the card keeps the form after a wrong proof. */
export type AddOutcome = { kind: "added" } | { kind: "cancelled" } | { kind: "refused"; stage: "options" | "verify"; status: number; error?: string };
type Post = (body: Record<string, unknown>) => Promise<{ status: number; j: Answer }>;
type Register = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) => Promise<RegistrationResponseJSON>;

/**
 * One add, flow A steps 1-3 back to back (rules 2407, 2429): `register-options` with the proof, the browser's ceremony,
 * then `register-verify` with the name the user already chose. The name is asked before this runs, so no user step sits
 * between the ceremony and verify: a credential the authenticator has just stored always reaches the server at once,
 * and cancelling before the ceremony leaves nothing on the device. A ceremony the browser refuses or the user cancels
 * sends no verify. `onVerify` runs between the ceremony and the verify request (the card's busy label), nothing else.
 */
export async function runAdd(proof: { password?: string; code?: string }, name: string, post: Post, register: Register, onVerify?: () => void): Promise<AddOutcome> {
  const o = await post({ action: "register-options", ...proof });
  if (!o.j.ok || !o.j.options) return { kind: "refused", stage: "options", status: o.status, error: o.j.error };
  let response: RegistrationResponseJSON;
  try {
    response = await register(o.j.options);
  } catch {
    return { kind: "cancelled" };
  }
  onVerify?.();
  const v = await post({ action: "register-verify", response, name });
  return v.j.ok ? { kind: "added" } : { kind: "refused", stage: "verify", status: v.status, error: v.j.error };
}

async function readList(): Promise<List | null> {
  const { j } = await call("GET");
  return j.ok && Array.isArray(j.items) ? { items: j.items, max: j.max ?? 10, enabled: !!j.enabled, proof: j.proof ?? "password" } : null;
}

/**
 * Settings, Security: the acting login's own passkeys (customer passkeys, flows A and B, rules 2410-2416, 2426, 2429).
 * The list shows each passkey's name, when it was added and last used, and a "synced" badge; never a credential id.
 * Adding asks for a name (prefilled with the device) and the password (or a code when two-step sign-in is on) first;
 * only then come the browser's passkey prompt and, straight after it, the save (`runAdd`). Renaming is inline and needs no proof; removing asks for the proof again. With the
 * off switch set, or in a browser without WebAuthn, the add button gives way to a short line of its own and the list,
 * rename and remove stay. Support is read only on the client; the server renders nothing.
 */
export default function PasskeySettings({ lang, T, enabled, forbidden }: { lang: Lang; T: Copy; enabled: boolean; forbidden: string }) {
  // Support is a browser fact: null on the server and during hydration (nothing rendered), then the client's answer.
  const supported = useSyncExternalStore(noChange, browserSupportsWebAuthn, unknownOnServer);
  const [data, setData] = useState<List | null>(null);
  const [unread, setUnread] = useState(false);
  const [step, setStep] = useState<"" | "proof">("");
  const [proof, setProof] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ ref: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<CardStatus>(null);

  const show = (v: List | null) => { setUnread(!v); if (v) setData(v); };
  const load = async () => show(await readList());
  useEffect(() => {
    if (supported !== null) void readList().then(show);
  }, [supported]);

  if (!showPasskeyCard(supported)) return null;

  const fill = (s: string, k: string, v: string) => s.replace(`{${k}}`, () => v);
  const when = (iso: string) => dateFormat(lang, { day: "numeric", month: "short", year: "numeric" }, "Asia/Riyadh").format(new Date(iso));
  const err = (s: number, e?: string) =>
    e === "reauth_unavailable" ? T.noProof : s === 403 ? forbidden : s === 429 ? T.slow : e === "wrong_password" ? T.wrong : e === "bad_code" ? T.badCode
    : e === "expired" ? T.expired : e === "credential_taken" ? T.taken : e === "invalid" ? T.invalid : e === "busy" ? T.busy : e === "not_found" ? T.notFound
    : e === "limit" ? fill(T.full, "max", String(data?.max ?? 10)) : e === "unavailable" ? T.off : T.failed;
  const proofBody = (typed: string) => (data?.proof === "code" ? { code: typed } : { password: typed });
  const reset = () => { setStep(""); setProof(""); setName(""); };
  /** Opens the add form: the name is asked here, before any ceremony, prefilled with the device family. */
  const begin = () => {
    setStatus(null); setRemoving(null);
    setName(deviceLabel(navigator.userAgent, T.defaultName).slice(0, PASSKEY_NAME_MAX));
    setStep("proof");
  };

  async function add() {
    setBusy("options"); setStatus(null);
    const typed = proofBody(proof);
    setProof("");
    const r = await runAdd(typed, name, (body) => call("POST", body), (optionsJSON) => startRegistration({ optionsJSON }), () => setBusy("verify"));
    setBusy("");
    // A refused proof keeps the form (and the name) for another try; anything after the ceremony ends the attempt.
    if (r.kind === "refused" && r.stage === "options") { setStatus({ tone: "error", text: err(r.status, r.error) }); return; }
    reset();
    if (r.kind === "cancelled") { setStatus({ tone: "error", text: T.cancelled }); return; }
    setStatus(r.kind === "added" ? { tone: "ok", text: T.addedOk } : { tone: "error", text: err(r.status, r.error) });
    await load();
  }
  async function rename() {
    if (!editing) return;
    setBusy(`rename-${editing.ref}`); setStatus(null);
    const { status: s, j } = await call("POST", { action: "rename", ref: editing.ref, name: editing.name });
    setBusy("");
    if (j.ok) setEditing(null);
    setStatus(j.ok ? { tone: "ok", text: T.renamedOk } : { tone: "error", text: err(s, j.error) });
    await load();
  }
  async function remove(ref: string) {
    setBusy(`remove-${ref}`); setStatus(null);
    const { status: s, j } = await call("POST", { action: "remove", ref, ...proofBody(proof) });
    setBusy(""); setProof("");
    if (j.ok) setRemoving(null);
    setStatus(j.ok ? { tone: "ok", text: T.removedOk } : { tone: "error", text: err(s, j.error) });
    await load();
  }

  if (!data) {
    return (
      <SettingsCard title={T.title} sub={T.sub}>
        {unread ? <p role="alert" className="text-sm text-danger">{T.failed}</p> : <PanelSkeleton label={T.loading} shape="line" />}
      </SettingsCard>
    );
  }

  const proofField = (id: string) =>
    data.proof === "none" ? (
      <p className="text-sm text-foreground-muted">{T.noProof}</p>
    ) : (
      <Field label={data.proof === "code" ? T.proofCode : T.proofPassword} required className="sm:max-w-sm">
        {data.proof === "code"
          ? <Input name={`${id}Code`} autoComplete="one-time-code" dir="ltr" maxLength={40} value={proof} onChange={(e) => setProof(e.target.value)} />
          : <PasswordField lang={lang} name={`${id}Password`} autoComplete="current-password" value={proof} onChange={(e) => setProof(e.target.value)} />}
      </Field>
    );
  const full = data.items.length >= data.max;

  return (
    <SettingsCard title={T.title} sub={T.sub} status={status}>
      {data.items.length === 0 ? (
        <p className="text-sm text-foreground-muted">{T.empty}</p>
      ) : (
        <ul aria-label={T.listLabel} className="grid gap-3">
          {data.items.map((p) => (
            <li key={p.ref} className="grid gap-2 rounded border border-border p-3">
              {editing?.ref === p.ref ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={T.nameLabel} required className="sm:max-w-xs">
                    <Input name="passkeyName" maxLength={PASSKEY_NAME_MAX} value={editing.name} onChange={(e) => setEditing({ ref: p.ref, name: e.target.value })} />
                  </Field>
                  <Button variant="primary" size="sm" loading={busy === `rename-${p.ref}`} loadingText={T.saving} aria-disabled={!editing.name.trim() || !!busy || undefined} onClick={() => { if (editing.name.trim() && !busy) void rename(); }}>{T.renameSave}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>{T.cancel}</Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid gap-0.5">
                    <span className="font-medium">
                      <bdi>{p.name}</bdi>
                      {p.synced && <span title={T.syncedHint} className="ms-2 rounded border border-border px-1.5 text-xs text-foreground-muted">{T.synced}</span>}
                    </span>
                    <span className="text-xs text-foreground-muted" suppressHydrationWarning>
                      {fill(T.addedOn, "date", when(p.createdAt))} · {p.lastUsedAt ? fill(T.usedOn, "date", when(p.lastUsedAt)) : T.neverUsed}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" aria-label={fill(T.renameNamed, "name", p.name)} onClick={() => { setRemoving(null); setEditing({ ref: p.ref, name: p.name }); }}>{T.rename}</Button>
                    <Button variant="ghost" size="sm" aria-label={fill(T.removeNamed, "name", p.name)} aria-expanded={removing === p.ref} onClick={() => { reset(); setEditing(null); setRemoving(removing === p.ref ? null : p.ref); }}>{T.remove}</Button>
                  </div>
                </div>
              )}
              {removing === p.ref && (
                <div className="grid gap-3">
                  {proofField("remove")}
                  <div className="flex flex-wrap gap-3">
                    {data.proof !== "none" && (
                      <Button variant="danger" size="sm" loading={busy === `remove-${p.ref}`} loadingText={T.removing} aria-disabled={!proof || !!busy || undefined} onClick={() => { if (proof && !busy) void remove(p.ref); }}>{T.removeConfirm}</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => { setRemoving(null); setProof(""); }}>{T.cancel}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!(data.enabled && enabled) ? (
        <p className="text-sm text-foreground-muted">{T.off}</p>
      ) : !showAddButton(true, supported) ? (
        <p className="text-sm text-foreground-muted">{T.unsupported}</p>
      ) : full ? (
        <p className="text-sm text-foreground-muted">{fill(T.full, "max", String(data.max))}</p>
      ) : step === "proof" ? (
        <div className="grid gap-3">
          {data.proof !== "none" && (
            <Field label={T.nameLabel} hint={T.nameHint} required className="sm:max-w-sm">
              <Input name="passkeyName" maxLength={PASSKEY_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          {proofField("add")}
          <div className="flex flex-wrap gap-3">
            {data.proof !== "none" && (
              <Button variant="primary" size="sm" loading={busy === "options" || busy === "verify"} loadingText={busy === "verify" ? T.saving : T.checking} aria-disabled={!proof || !name.trim() || !!busy || undefined} onClick={() => { if (proof && name.trim() && !busy) void add(); }}>{T.next}</Button>
            )}
            <Button variant="ghost" size="sm" onClick={reset}>{T.cancel}</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="secondary" size="sm" onClick={begin}>{T.add}</Button>
        </div>
      )}
    </SettingsCard>
  );
}
