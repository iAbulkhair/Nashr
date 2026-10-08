"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import {
  NOTE_MS,
  chosenId,
  needsChinaConfirm,
  nextBrandPick,
  pickBodies,
  pickChanges,
  pickedChat,
  pickerOptions,
  readModelsView,
  sendPick,
  unitsText,
  type BrandPick,
  type ModelsView,
  type PickBody,
  type PickOutcome,
  type PickSurface,
  type PickedChat,
  type PickerOption,
  type Refusal,
} from "@/lib/model-picker";
import { useConfirm } from "./ConfirmDialog";
import { Icon } from "./Icons";

/**
 * The model picker (spec 2026-10-08-straitly-model-routing, plan Task 7): `ChatModelPicker` in the chat header (one
 * conversation's pick) and `BrandModelField` on the brand page (the active brand's default model for content). The list,
 * the tiers, the hosting and every number come from GET /api/models; the pick goes to PUT /api/models, which checks it
 * again in code. Automatic is first and sends null. A China-hosted entry asks the owner once, in the app's own dialog,
 * and the confirmation goes before the pick. A refused pick rolls back what the screen already showed (`nextMadePicks`
 * in the chat panel, `nextBrandPick` here: pure steps, tested without a browser).
 */

type Lang = "ar" | "en";

/** GET /api/models for this mount; `reload()` asks again (after a refusal that means the list changed). */
function useModels(lang: Lang) {
  const router = useRouter();
  const [view, setView] = useState<ModelsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/models", { cache: "no-store" })
      .then(async (r) => {
        if (!live) return;
        if (r.status === 401) { router.replace(`/${lang}/app/login`); return; }
        const v = readModelsView(await r.json().catch(() => null));
        if (!live) return;
        setView(v);
        setFailed(!v);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [tick, lang, router]);
  return { view, setView, failed, reload: () => setTick((n) => n + 1) };
}

/** One PUT /api/models: its status and its body as it came (`sendPick` reads the error, `pickedChat` the chat status). */
async function put(b: PickBody): Promise<{ status: number; body: unknown }> {
  const r = await fetch("/api/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** The sentence for a refusal. `signed_out` has none: the caller goes to the login page. */
function refusalText(why: Refusal, t: AppDict, surface: PickSurface): string {
  const m = t.models;
  switch (why) {
    case "busy": return m.busy;
    case "unavailable": return m.unavailable;
    case "not_found": return surface === "chat" ? m.notFound : m.noBrand;
    case "owner_only": return m.ownerOnly;
    case "forbidden": return t.readOnly.admin;
    case "slow_down": return m.slow;
    default: return m.failed;
  }
}

/** "{x} per message" with the multiplier kept left to right inside an Arabic sentence. */
function Multiplier({ template, x }: { template: string; x: string }) {
  const [before, after = ""] = template.split("{x}");
  return <>{before}<span dir="ltr" className="tnum font-semibold text-ink">{x}</span>{after}</>;
}

/** One option's text: the server's label, its tier, "Hosted in China" when it is, the multiplier and the chat units. */
function OptionBody({ o, t, lang, surface }: { o: PickerOption; t: AppDict; lang: Lang; surface: PickSurface }) {
  const m = t.models;
  const units = surface === "chat" ? unitsText(o.units, lang, m.units) : null;
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <bdi className="font-semibold text-ink">{o.label}</bdi>
        {o.tier && <span className="badge badge-primary">{m.tiers[o.tier]}</span>}
        {o.china && <span className="badge badge-accent">{m.china}</span>}
      </span>
      <span className="mt-0.5 block text-xs text-muted">
        {o.multiplier ? <Multiplier template={surface === "chat" ? m.perMessage : m.perBatch} x={o.multiplier} /> : m.autoHint}
      </span>
      {units && <span className="block text-xs text-muted">{units}</span>}
    </span>
  );
}

/**
 * The list itself, Automatic first, the chosen entry marked `aria-current`: a plain list of buttons, reached with Tab.
 * Presentational, so a test renders it without a browser.
 */
export function ModelOptionList({ t, lang, surface, options, selected, onPick }: { t: AppDict; lang: Lang; surface: PickSurface; options: readonly PickerOption[]; selected: string | null; onPick: (o: PickerOption) => void }) {
  return (
    <ul aria-label={t.models.choose} className="grid gap-0.5">
      {options.map((o) => {
        const sel = o.id === selected;
        return (
          <li key={o.id ?? "auto"}>
            <button type="button" aria-current={sel ? "true" : undefined} onClick={() => onPick(o)} className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-start text-sm hover:bg-lilac ${sel ? "bg-lilac/60" : ""}`}>
              <Icon name={sel ? "check" : "spark"} className={`mt-0.5 h-4 w-4 shrink-0 ${sel ? "text-ink" : "text-muted"}`} />
              <OptionBody o={o} t={t} lang={lang} surface={surface} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The chat header's picker for conversation `conv`. `stored` is the conversation's pick as the panel knows it
 * (`storedPick`: a pick made here, the page's record of the open conversation, the listed rows). `onPicked` reports each
 * step of a pick for the conversation it was made on (the panel applies `nextMadePicks`: the optimistic change, kept or
 * rolled back), `onChat` hands over the account's chat status the server answered for the new model (the allowance line
 * shows it as it came), `onGone` reloads the conversation list after a `not_found`. The default thread has no record, so
 * it explains how to choose instead of listing. The trigger discloses the popover: Escape closes it and gives focus back.
 */
export function ChatModelPicker({ t, lang, conv, stored, canConfirmChina, onPicked, onChat, onGone }: { t: AppDict; lang: Lang; conv: string; stored: string | undefined; canConfirmChina: boolean; onPicked: (conv: string, previous: string | null, model: string | null, outcome: PickOutcome) => void; onChat: (chat: PickedChat) => void; onGone: () => void }) {
  const router = useRouter();
  const { view, setView, failed, reload } = useModels(lang);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A refusal belongs to the conversation it was about: switching to another one hides it.
  const [noted, setNoted] = useState<{ conv: string; text: string } | null>(null);
  const setNote = (text: string) => setNoted(text ? { conv, text } : null);
  const note = noted?.conv === conv ? noted.text : "";
  const [ask, confirmDialog] = useConfirm();
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The conversation open now, read when a pick's answer arrives (the person may have started another one meanwhile).
  const openConv = useRef(conv);
  const popId = useId();
  const m = t.models;
  const options = view ? pickerOptions(view, "chat", lang, m.auto) : [];
  const selected = chosenId(stored, options);
  const current = options.find((x) => x.id === selected);

  useEffect(() => { openConv.current = conv; }, [conv]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [open]);

  // The refusal note covers the page under the header, so it goes by itself after NOTE_MS, and at once on Escape.
  useEffect(() => {
    if (!noted) return;
    const timer = setTimeout(() => setNoted(null), NOTE_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNoted(null); };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [noted]);

  async function choose(o: PickerOption) {
    setOpen(false);
    setNote("");
    // Against the stored value itself: over a stored id the list no longer offers, Automatic is a change (it sends null).
    if (!view || busy || !pickChanges(stored, o.id)) return;
    const confirmFirst = needsChinaConfirm(o, view.chinaConfirmed);
    if (confirmFirst) {
      if (!canConfirmChina) { setNote(m.ownerOnly); return; }
      if (!(await ask({ title: m.chinaTitle, message: m.chinaBody, confirmLabel: m.chinaOk, cancelLabel: t.dialog.back }))) return;
    }
    // The conversation and the pick it had, as they were when the person chose: a late answer changes that one only.
    const at = conv;
    const previous = typeof stored === "string" ? stored : null;
    onPicked(at, previous, o.id, "pending");
    setBusy(true);
    const { why, body } = await sendPick(pickBodies("conversation", at, o.id, confirmFirst), put);
    setBusy(false);
    onPicked(at, previous, o.id, why);
    if (!why) {
      if (confirmFirst) setView((v) => (v ? { ...v, chinaConfirmed: true } : v));
      // The server's chat status for the model this conversation now runs on, shown only while it is still the open one.
      if (openConv.current !== at) return;
      const chat = pickedChat(body);
      if (chat) onChat(chat);
      return;
    }
    if (why === "signed_out") { router.replace(`/${lang}/app/login`); return; }
    setNote(refusalText(why, t, "chat"));
    // The list changed (or the confirmation landed before the pick failed): ask for it again.
    if (why === "unavailable" || confirmFirst) reload();
    if (why === "not_found") onGone();
  }

  const shown = current?.label ?? m.auto;
  return (
    <span ref={box} className="relative">
      <button ref={trigger} type="button" onClick={() => { setNote(""); setOpen(!open); }} disabled={busy || (!view && !failed)} aria-expanded={open} aria-controls={open ? popId : undefined} aria-label={`${m.label}: ${shown}`} className="btn btn-secondary btn-xs max-w-48 disabled:opacity-60">
        <Icon name="spark" className="h-3.5 w-3.5 shrink-0" />
        <bdi className="clip">{shown}</bdi>
        <Icon name="chevron" className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div id={popId} className="absolute start-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-xl border-[1.5px] border-ink bg-white p-1.5">
          {failed ? (
            <p role="status" className="px-2 py-2 text-sm text-ink/80">{m.loadFailed}</p>
          ) : conv === "default" ? (
            <p className="px-2 py-2 text-sm text-ink/80">{m.defaultThread}</p>
          ) : (
            <ModelOptionList t={t} lang={lang} surface="chat" options={options} selected={selected} onPick={choose} />
          )}
        </div>
      )}
      {note && <span role="status" className="absolute start-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-ink px-3 py-2 text-xs text-lilac">{note}</span>}
      {confirmDialog}
    </span>
  );
}

/**
 * The brand page's "Default model for content": every choice with its generation multiplier, shown before saving, and
 * its own Save. `stored` is the brand file's `model`. Admin and owner only (`readOnly` for members; PUT /api/models
 * checks `brand.write` in code). Rendered outside the brand form, so its dialog is never inside a disabled fieldset.
 */
export function BrandModelField({ t, lang, stored, readOnly, canConfirmChina }: { t: AppDict; lang: Lang; stored: string | undefined; readOnly: boolean; canConfirmChina: boolean }) {
  const router = useRouter();
  const { view, setView, failed, reload } = useModels(lang);
  // The stored pick and the person's unsaved choice, changed only through `nextBrandPick` and the radio buttons.
  const [pick, setPick] = useState<BrandPick>({ saved: stored ?? null, choice: undefined });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ask, confirmDialog] = useConfirm();
  const titleId = useId();
  const m = t.models;
  const options = view ? pickerOptions(view, "generate", lang, m.auto) : [];
  const savedId = chosenId(pick.saved, options);
  const current = pick.choice === undefined ? savedId : pick.choice;
  // Against the stored value itself: a stored id the list no longer offers shows as Automatic, and saving that clears it.
  const canSave = pickChanges(pick.saved, current);
  const changed = pick.choice !== undefined && canSave;

  async function save() {
    const o = options.find((x) => x.id === current);
    if (!view || !o || busy || readOnly || !canSave) return;
    setMsg("");
    const confirmFirst = needsChinaConfirm(o, view.chinaConfirmed);
    if (confirmFirst) {
      if (!canConfirmChina) { setMsg(m.ownerOnly); return; }
      if (!(await ask({ title: m.chinaTitle, message: m.chinaBody, confirmLabel: m.chinaOk, cancelLabel: t.dialog.back }))) return;
    }
    const previous = pick.saved;
    setPick(nextBrandPick(previous, o.id, "pending"));
    setBusy(true);
    const { why } = await sendPick(pickBodies("brand", undefined, o.id, confirmFirst), put);
    setBusy(false);
    // Kept when it landed; on a refusal the saved value as it was, and the choice kept for another try (`nextBrandPick`).
    setPick(nextBrandPick(previous, o.id, why));
    if (!why) {
      if (confirmFirst) setView((v) => (v ? { ...v, chinaConfirmed: true } : v));
      setMsg(m.saved);
      return;
    }
    if (why === "signed_out") { router.replace(`/${lang}/app/login`); return; }
    setMsg(refusalText(why, t, "generate"));
    if (why === "unavailable" || confirmFirst) reload();
  }

  return (
    <section aria-labelledby={titleId} className="mt-8 rounded-xl border border-ink/15 bg-white p-4">
      <h2 id={titleId} className="flex items-center gap-2 font-display font-bold text-ink"><Icon name="spark" className="h-5 w-5" />{m.brandTitle}</h2>
      <p className="mt-1 text-xs text-muted">{m.brandSub}</p>
      {failed ? (
        <p role="status" className="mt-3 text-sm text-ink/80">{m.loadFailed}</p>
      ) : (
        <fieldset disabled={readOnly || busy || !view} className="mt-3 grid min-w-0 gap-1.5">
          <legend className="sr-only">{m.brandTitle}</legend>
          {options.map((o) => (
            <label key={o.id ?? "auto"} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm ${current === o.id ? "border-ink bg-lilac/40" : "border-ink/15"}`}>
              <input type="radio" name="brand-model" className="mt-1" checked={current === o.id} onChange={() => { setMsg(""); setPick((p) => ({ ...p, choice: o.id })); }} />
              <OptionBody o={o} t={t} lang={lang} surface="generate" />
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!readOnly && <button type="button" onClick={save} disabled={busy || !view || !canSave} className="btn btn-primary btn-sm">{m.save}</button>}
        {changed && !readOnly && <span className="text-xs text-muted">{m.unsaved}</span>}
        {msg && <p role="status" className="text-sm text-ink">{msg}</p>}
      </div>
      {confirmDialog}
    </section>
  );
}

