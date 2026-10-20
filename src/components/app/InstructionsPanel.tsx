"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import type { By } from "@/lib/actor";
import { AGENT_IDS, isAgentId, type AgentId } from "@/lib/agents";
import type { RefSource } from "@/lib/instruction-refs";
import { summarizeRevision, type SetDiff, type HistoryRow } from "@/lib/instructions-diff";
import { INSTRUCTION_CHARS, TEST_BRIEF_CHARS, type InstructionLimits } from "@/lib/instructions-safety";
import type { Draft, Instruction, Layer, Revision, Target } from "@/lib/instructions-store";
import type { TestOption } from "@/lib/instructions-test";
import { sameContent } from "@/lib/instructions-diff";
import { ROW_CODES, errorText, fill, formAfterWrite, newNonce, parseTestResult, restoreBlocked, sameDrafts, toDraft, type TestItem } from "@/lib/instructions-ui";
import type { TaskType } from "@/lib/tasks";
import { render } from "@/lib/md";
import { dateFormat } from "@/lib/dates";
import ReadOnlyNote from "./ReadOnlyNote";
import { useConfirm } from "./ConfirmDialog";
import InstructionEditor, { targetLabel, type RowErrors } from "./InstructionEditor";
import Scribble from "@/components/Scribble";
import { useToast } from "@/components/ui/Toast";
import EmptyState from "@/components/ui/EmptyState";
import { useAppHref } from "@/components/app/WorkspaceContext";

/** The eight agents and the group for images and videos: what a customer may point an instruction at. */
const CUSTOMER_TARGETS: Target[] = [...AGENT_IDS, "media"];
type Item = TestItem;
type Busy = null | "save" | "activate" | "discard" | "restore" | "test" | "search" | "import";
type Reply = { ok: boolean; status: number; j: Record<string, unknown> };

/** Model text, as plain text or through the safe renderer: the same `render` the approval inbox shows a draft's body with (it escapes HTML). */
function Body({ md }: { md: string }) {
  return <div className="prose-nashr prose-compact mt-2 text-sm text-foreground" dir="auto" dangerouslySetInnerHTML={{ __html: render(md) }} />;
}

/**
 * The result of a test: the item written with the active instructions next to the one written with the draft. The
 * channel and the title are plain React text and the body goes through `render`, so a model's (or an imported file's)
 * markup never reaches the page as markup. Nothing here is saved or sent to the inbox.
 */
export function TestOutput({ t, before, after, spent }: { t: AppDict; before: Item; after: Item; spent: number }) {
  const I = t.instructions;
  const col = (label: string, it: Item) => (
    <section className="min-w-0 rounded-xl border-[1.5px] border-border p-3">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="mt-1 text-xs text-foreground-muted"><bdi>{it.channel}</bdi></p>
      <p className="mt-1 font-medium" dir="auto">{it.title}</p>
      <Body md={it.body} />
    </section>
  );
  return (
    <div className="mt-4">
      <div className="grid gap-3 md:grid-cols-2">{col(I.before, before)}{col(I.after, after)}</div>
      <p className="tnum mt-2 text-xs text-foreground-muted">{fill(I.spent, { n: spent })}</p>
    </div>
  );
}

/** One instruction as the comparison shows it: its text as plain text, and what else differs (agents, switched off). */
function ItemLine({ t, i }: { t: AppDict; i: Instruction }) {
  const I = t.instructions;
  const meta = [i.agents === "all" ? "" : fill(I.itemFor, { agents: i.agents.map((a) => targetLabel(t, a)).join(", ") }), i.on ? "" : I.itemOff].filter(Boolean).join(" · ");
  return (
    <p className="text-sm">
      <bdi>{i.text}</bdi>
      {meta && <span className="text-xs text-foreground-muted"> · {meta}</span>}
    </p>
  );
}

/**
 * The customer's page for agent instructions (agent skills portal, spec 8.1, rule 957). Everything on it is rendered by the
 * server from props: the live set (`layer.active`), the draft being edited (`layer.draft`), the newest versions as
 * counts (`history`), the plan's limits and how many switched-on items the plan leaves out (`skipped`), the workspace
 * files, the imported reference files and what each test costs (`testOptions`, from the same function the route charges
 * by). The browser asks the server only when someone acts: save, activate, discard, compare, restore, search, import,
 * test. The platform's own instructions are never in these props.
 *
 * `base` is the layer's edit counter as the page was loaded; every save sends the latest one it was given, and a
 * `stale` answer (another tab, or an accepted chat suggestion, got in first) tells the owner to reload instead of
 * overwriting. `readOnly` (everyone below admin) disables every control and shows the note; the routes refuse these
 * roles in code too. `canTest` is `instructions.test`. `googleOn` is whether an import can run now (Composio is on and a
 * Google login is stored) on a plan with reference files. `paused` is the founder's switch: while on, no workspace set
 * is applied anywhere.
 */
export default function InstructionsPanel({ t, lang, layer: initialLayer, base: initialBase, history: initialHistory, limits, skipped: initialSkipped, files: initialFiles, refs: initialRefs, readOnly = false, canTest = false, googleOn = false, paused = false, testOptions = [] }: { t: AppDict; lang: "ar" | "en"; layer: Layer; base: number; history: HistoryRow[]; limits: InstructionLimits; skipped: number; files: string[]; refs: Record<string, RefSource>; readOnly?: boolean; canTest?: boolean; googleOn?: boolean; paused?: boolean; testOptions?: TestOption[] }) {
  const href = useAppHref(lang);
  const I = t.instructions;
  const G = t.governance;
  const router = useRouter();
  const toast = useToast();
  const [ask, confirmDialog] = useConfirm();
  const [layer, setLayer] = useState<Layer>(initialLayer);
  const [base, setBase] = useState(initialBase);
  const [rows, setRows] = useState<Draft[]>(() => (initialLayer.draft ?? initialLayer.active).items.map(toDraft));
  const [history, setHistory] = useState<HistoryRow[]>(initialHistory);
  const [skipped, setSkipped] = useState(initialSkipped);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [refs, setRefs] = useState<Record<string, RefSource>>(initialRefs);
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState("");
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [stale, setStale] = useState(false);
  const [histErr, setHistErr] = useState("");
  const [cmp, setCmp] = useState<{ id: string; loading: boolean; diff?: SetDiff } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  // The newest Compare request: a slower, earlier answer is ignored.
  const cmpToken = useRef(0);
  // Import
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string; kind: "doc" | "sheet"; modified?: string }[] | null>(null);
  const [impErr, setImpErr] = useState("");
  const [impCode, setImpCode] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  // Test
  const [agent, setAgent] = useState<AgentId | "">(testOptions[0]?.agent ?? "");
  const [type, setType] = useState<TaskType | "">(testOptions[0]?.type ?? "");
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<{ before: Item; after: Item; spent: number } | null>(null);
  const [testErr, setTestErr] = useState("");

  const saved = (layer.draft ?? layer.active).items.map(toDraft);
  const dirty = !sameDrafts(rows, saved);
  const hasDraft = layer.draft !== null;
  const draftDiffers = hasDraft && !sameDrafts(layer.draft!.items.map(toDraft), layer.active.items.map(toDraft));
  const activeOn = layer.active.items.filter((i) => i.on).length;
  const when = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const who = (b: By) => (b.kind === "member" ? `${G.byMember}${b.email ? ` · ${b.email}` : ""}` : b.kind === "founder" ? G.byFounder : b.kind === "token" ? G.byToken : b.kind === "system" ? G.bySystem : G.byOwner);
  const locked = busy !== null || restoring !== null;
  const refTitles = Object.fromEntries(Object.entries(refs).filter(([, r]) => r.title).map(([n, r]) => [n, r.title]));

  /** One request: the answer's status and JSON, or status 0 when the network failed. Never throws. */
  async function call(url: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<Reply> {
    try {
      const res = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok && j.ok === true, status: res.status, j };
    } catch {
      return { ok: false, status: 0, j: {} };
    }
  }
  /** The reason in the owner's words: the server's code, or for a bare 401 a sign-in message. */
  const reason = (r: Reply) => errorText(t, r.j.error ?? (r.status === 401 ? "unauthorized" : undefined), { max: limits.chars });
  const clear = () => { setErr(""); setRowErrors({}); setStale(false); setHistErr(""); };
  /** No answer or a server fault (rule 2001): a toast; a refusal with a reason (limit, role, text) stays beside its form. */
  const soft = (r: Reply) => r.status === 0 || r.status >= 500;

  /** What the server stored is what the page shows: the form always follows the layer an answer carries (see `formAfterWrite`), never local rows next to a newer base. */
  function adopt(next: Layer) {
    setLayer(next);
    const f = formAfterWrite(next);
    setRows(f.rows);
    setBase(f.base);
  }
  /** The count of switched-on items the plan leaves out comes with the answer of activate and restore (the live set is what changes it). */
  const takeSkipped = (r: Reply) => { if (typeof r.j.skipped === "number") setSkipped(r.j.skipped); };
  /** A refused request: a refused text goes under its row, a changed-elsewhere answer offers the reload, the rest is a line. */
  function fail(r: Reply, into: "page" | "history" = "page") {
    const code = r.j.error;
    if (soft(r)) { toast.danger(reason(r)); return; }
    if (into === "history") { setHistErr(reason(r)); return; }
    if (typeof code === "string" && ROW_CODES.has(code) && typeof r.j.index === "number") { setRowErrors({ [r.j.index]: reason(r) }); return; }
    if (code === "stale") setStale(true);
    setErr(reason(r));
  }

  async function save(): Promise<boolean> {
    clear();
    setBusy("save");
    try {
      const r = await call("/api/instructions", "PUT", { items: rows, base });
      if (!r.ok) { fail(r); return false; }
      adopt(r.j.layer as Layer);
      toast.success(I.saved); // rule 2001
      return true;
    } finally {
      setBusy(null);
    }
  }
  /** Saves first when the form has edits the server has not seen, so Activate puts live what is on the screen. */
  async function activate() {
    if (dirty && !(await save())) return;
    clear();
    setBusy("activate");
    try {
      const r = await call("/api/instructions/activate", "POST", {});
      if (!r.ok) { fail(r); return; }
      adopt(r.j.layer as Layer);
      setHistory((h) => [summarizeRevision(r.j.revision as Revision), ...h].slice(0, 20));
      toast.success(I.activated);
      takeSkipped(r);
    } finally {
      setBusy(null);
    }
  }
  async function discard() {
    clear();
    if (!(await ask({ title: I.discardTitle, message: I.discardConfirm, confirmLabel: I.discard, cancelLabel: t.dialog.back, destructive: true }))) return;
    setBusy("discard");
    try {
      const r = await call("/api/instructions/discard", "POST", {});
      if (!r.ok) { fail(r); return; }
      adopt(r.j.layer as Layer);
      toast.success(I.discarded);
    } finally {
      setBusy(null);
    }
  }

  async function compare(id: string) {
    setHistErr("");
    const mine = ++cmpToken.current;
    if (cmp?.id === id) { setCmp(null); return; }
    setCmp({ id, loading: true });
    const r = await call(`/api/instructions/history?compare=${encodeURIComponent(id)}`, "GET");
    if (cmpToken.current !== mine) return;
    if (!r.ok || !r.j.diff) { setCmp(null); fail(r, "history"); return; }
    setCmp({ id, loading: false, diff: r.j.diff as SetDiff });
  }
  async function restore(row: HistoryRow) {
    if (restoreBlocked(dirty)) return;
    clear();
    if (!(await ask({ title: fill(I.restoreTitle, { v: row.v }), message: fill(I.restoreConfirm, { v: row.v }), confirmLabel: I.restore, cancelLabel: t.dialog.back, destructive: true }))) return;
    setRestoring(row.id);
    try {
      const r = await call("/api/instructions/restore", "POST", { revisionId: row.id });
      if (!r.ok) { fail(r, "history"); return; }
      // Restore is blocked while the form has unsaved edits, so the form can follow the stored draft the server kept.
      adopt(r.j.layer as Layer);
      setHistory((h) => [summarizeRevision(r.j.revision as Revision), ...h].slice(0, 20));
      setCmp(null);
      toast.success(I.restored);
      takeSkipped(r);
    } finally {
      setRestoring(null);
    }
  }

  async function search() {
    setImpErr(""); setImpCode("");
    setBusy("search");
    try {
      const r = await call("/api/instructions/refs/search", "POST", { q: q.trim() });
      if (!r.ok) { if (soft(r)) toast.danger(reason(r)); else { setImpErr(reason(r)); setImpCode(String(r.j.error ?? "")); } return; }
      setHits(Array.isArray(r.j.results) ? (r.j.results as NonNullable<typeof hits>) : []);
    } finally {
      setBusy(null);
    }
  }
  /** Import a search result, or Refresh an earlier import with the source it was stored with. */
  async function importRef(kind: "doc" | "sheet", id: string, title: string, key: string) {
    setImpErr(""); setImpCode("");
    setImporting(key);
    setBusy("import");
    try {
      const r = await call("/api/instructions/refs/import", "POST", { kind, id, title });
      if (!r.ok || typeof r.j.name !== "string") { if (soft(r) || r.ok) toast.danger(reason(r)); else { setImpErr(reason(r)); setImpCode(String(r.j.error ?? "")); } return; }
      const name = r.j.name;
      const shownTitle = typeof r.j.title === "string" ? r.j.title : title;
      setFiles((f) => (f.includes(name) ? f : [...f, name].sort()));
      setRefs((m) => ({ ...m, [name]: { source: kind === "doc" ? "gdocs" : "gsheets", id, title: shownTitle, at: new Date().toISOString() } }));
      toast.success(fill(I.importDone, { name }));
    } finally {
      setImporting(null);
      setBusy(null);
    }
  }

  const option = testOptions.find((o) => o.agent === agent && o.type === type);
  const agentsOffered = [...new Set(testOptions.map((o) => o.agent))];
  async function runTest() {
    if (!option) return;
    setTestErr("");
    if (!(await ask({ title: I.testConfirmTitle, message: fill(I.testConfirm, { n: option.price }), confirmLabel: I.testConfirmLabel, cancelLabel: t.dialog.back }))) return;
    setBusy("test");
    setResult(null);
    try {
      // A new nonce for each confirmed click: the server charges once per nonce, so a double click or a replay costs nothing more.
      const r = await call("/api/instructions/test", "POST", { agent: option.agent, type: option.type, brief: brief.trim(), confirm: true, nonce: newNonce() });
      const done = r.ok ? parseTestResult(r.j) : null;
      if (!done) {
        const why = errorText(t, r.j.error ?? (r.status === 401 ? "unauthorized" : undefined), { max: TEST_BRIEF_CHARS });
        if (soft(r) || r.ok) toast.danger(why); else setTestErr(why);
        return;
      }
      setResult(done);
      // The balance in the sidebar comes from the server render.
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  const testHint = paused ? I.testPaused : !hasDraft ? I.testNeedsDraft : dirty ? I.testNeedsSaved : sameContent(layer.active, layer.draft!) ? I.testNoChange : "";

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="instructionspanel-t1" />{I.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{I.sub}</p>
      <p className="mt-2 text-sm text-foreground-muted">{I.safetyNote}</p>
      <p className="mt-1 text-sm text-foreground-muted">{I.notCovered}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.admin} />}
      {paused && <p role="note" className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">{I.paused}</p>}

      <section className="card mt-6" aria-labelledby="ins-edit">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ins-edit" className="font-display font-medium">{I.editorTitle}</h2>
          <p className="text-sm text-foreground-muted">{layer.active.v > 0 ? fill(I.activeNow, { v: layer.active.v, n: activeOn }) : I.noneActive}</p>
        </div>
        <p className="mt-1 text-xs text-foreground-muted">{fill(I.limitHint, { max: limits.max })}</p>
        {!limits.refs && <p className="mt-1 text-xs text-foreground-muted">{I.refsPlan}</p>}
        {skipped > 0 && <p role="status" className="mt-2 rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm">{fill(I.skipped, { n: skipped, max: limits.max })}</p>}
        {draftDiffers && !dirty && <p role="status" className="mt-2 rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm">{fill(I.draftBanner, { v: layer.active.v })}</p>}
        <fieldset disabled={readOnly} className="mt-4 min-w-0">
          <InstructionEditor t={t} items={rows} onChange={(r) => { setRows(r); setRowErrors({}); }} maxChars={INSTRUCTION_CHARS} targets={CUSTOMER_TARGETS} perAgent={limits.perAgent} refsOn={limits.refs} files={files} allowLock={false} readOnly={readOnly} errors={rowErrors} refTitles={refTitles} />
          {!readOnly && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void save()} disabled={locked || !dirty} className="btn btn-secondary btn-sm">{busy === "save" ? I.saving : I.saveDraft}</button>
              <button type="button" onClick={() => void activate()} disabled={locked || (!dirty && !hasDraft)} className="btn btn-primary btn-sm">{busy === "activate" ? I.activating : I.activate}</button>
              <button type="button" onClick={() => void discard()} disabled={locked || !hasDraft} className="btn btn-danger btn-sm">{busy === "discard" ? I.discarding : I.discard}</button>
              {dirty && <span className="text-sm text-foreground-muted">{I.unsaved}</span>}
            </div>
          )}
          {err && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {err}
              {stale && <> <button type="button" onClick={() => window.location.reload()} className="underline">{I.reload}</button></>}
            </p>
          )}
        </fieldset>
      </section>

      {/* Import and test are write actions (admin and owner): a read-only role does not see them. */}
      {googleOn && limits.refs && !readOnly && (
        <section className="card mt-4" aria-labelledby="ins-import">
          <h2 id="ins-import" className="font-display font-medium">{I.importTitle}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{I.importSub}</p>
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <input className="input min-w-0 flex-1" dir="auto" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} aria-label={I.importQuery} placeholder={I.importQuery} />
            <button type="submit" disabled={locked} className="btn btn-secondary btn-sm">{busy === "search" ? I.importSearching : I.importSearch}</button>
          </form>
          {impErr && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {impErr}
              {impCode === "not_connected" && <> <Link href={href("/integrations")} className="underline">{t.nav.integrations}</Link></>}
            </p>
          )}
          {hits && (
            hits.length === 0 ? <EmptyState compact className="mt-3" title={I.importNone} /> : (
              <ul className="mt-3 divide-y divide-foreground/10">
                {hits.map((h) => (
                  <li key={`${h.kind}:${h.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <p className="min-w-0 text-sm"><bdi>{h.title}</bdi> <span className="badge badge-primary">{h.kind === "doc" ? I.kindDoc : I.kindSheet}</span>{h.modified && !Number.isNaN(Date.parse(h.modified)) && <span className="text-xs text-foreground-muted"> · {when.format(new Date(h.modified))}</span>}</p>
                    <button type="button" onClick={() => void importRef(h.kind, h.id, h.title, `${h.kind}:${h.id}`)} disabled={locked} className="btn btn-secondary btn-xs">{importing === `${h.kind}:${h.id}` ? I.importing : I.importDo}</button>
                  </li>
                ))}
              </ul>
            )
          )}
          {Object.keys(refs).length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">{I.importedList}</h3>
              <ul className="mt-1 divide-y divide-foreground/10">
                {Object.entries(refs).sort(([, a], [, b]) => b.at.localeCompare(a.at)).map(([name, r]) => (
                  <li key={name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <p className="min-w-0 text-sm"><bdi>{r.title || name}</bdi> <span className="badge badge-primary">{r.source === "gdocs" ? I.kindDoc : I.kindSheet}</span> <span className="text-xs text-foreground-muted" dir="ltr">{name}</span>{!files.includes(name) && <span className="text-xs text-danger"> · {I.importMissing}</span>}</p>
                    <button type="button" onClick={() => void importRef(r.source === "gdocs" ? "doc" : "sheet", r.id, r.title, name)} disabled={locked} className="btn btn-secondary btn-xs">{importing === name ? I.importing : I.importRefresh}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {canTest && !readOnly && (
        <section className="card mt-4" aria-labelledby="ins-test">
          <h2 id="ins-test" className="font-display font-medium">{I.testTitle}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{I.testSub}</p>
          {testOptions.length === 0 ? (
            <p className="mt-3 text-sm text-foreground-muted">{I.testNone}</p>
          ) : (
            <div className="mt-3 grid gap-3">
              <div className="flex flex-wrap gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-foreground-muted">{I.testAgent}</span>
                  <select value={agent} onChange={(e) => { const a = e.target.value; if (isAgentId(a)) { setAgent(a); setType(testOptions.find((o) => o.agent === a)?.type ?? ""); } }} className="rounded border border-border bg-surface px-2 py-1">
                    {agentsOffered.map((a) => <option key={a} value={a}>{t.agents[a].name}</option>)}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-foreground-muted">{I.testType}</span>
                  <select value={type} onChange={(e) => { const v = testOptions.find((o) => o.agent === agent && o.type === e.target.value); if (v) setType(v.type); }} className="rounded border border-border bg-surface px-2 py-1">
                    {testOptions.filter((o) => o.agent === agent).map((o) => <option key={o.type} value={o.type}>{t.generate.types[o.type].t}</option>)}
                  </select>
                </label>
              </div>
              <label className="grid gap-1 text-sm">
                <span className="text-foreground-muted">{I.testBrief}</span>
                <textarea className="input" rows={2} dir="auto" maxLength={TEST_BRIEF_CHARS} value={brief} placeholder={I.testBriefHint} onChange={(e) => setBrief(e.target.value)} />
                <span className="tnum text-xs text-foreground-muted" dir="ltr">{fill(I.counter, { n: brief.length, max: TEST_BRIEF_CHARS })}</span>
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => void runTest()} disabled={locked || !option || !!testHint} className="btn btn-primary btn-sm">{busy === "test" ? I.testing : fill(I.testButton, { n: option?.price ?? 0 })}</button>
                {testHint && <span className="text-sm text-foreground-muted">{testHint}</span>}
              </div>
            </div>
          )}
          {testErr && <p role="alert" className="mt-2 text-sm text-danger">{testErr}</p>}
          {result && <TestOutput t={t} before={result.before} after={result.after} spent={result.spent} />}
        </section>
      )}

      {/* Outside the fieldset: every role reads the history; only admin and owner get Restore (the route checks it too). */}
      <section className="card mt-4" aria-labelledby="ins-history">
        <h2 id="ins-history" className="font-display font-medium">{I.history}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{I.historySub}</p>
        {!readOnly && restoreBlocked(dirty) && <p className="mt-2 text-sm text-foreground-muted">{I.restoreNeedsSaved}</p>}
        {histErr && <p role="alert" className="mt-2 text-sm text-danger">{histErr}</p>}
        {history.length === 0 ? (
          <EmptyState compact className="mt-3" title={I.historyEmpty} />
        ) : (
          <ul className="mt-3 divide-y divide-foreground/10">
            {history.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <strong id={`ins-rev-${r.id}`}>{fill(I.version, { v: r.v })}</strong>
                    <span className="text-foreground-muted"> · </span>
                    <time dateTime={r.at} suppressHydrationWarning>{when.format(new Date(r.at))} UTC</time>
                    <span className="text-foreground-muted"> · </span>
                    <span dir="auto">{who(r.by)}</span>
                    {r.rollbackOf && <span className="ms-2 badge">{I.restoreBadge}</span>}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void compare(r.id)} disabled={locked && !cmp} aria-describedby={`ins-rev-${r.id}`} aria-expanded={cmp?.id === r.id} className="btn btn-secondary btn-xs">{cmp?.id === r.id ? (cmp.loading ? I.comparing : I.hideCompare) : I.compare}</button>
                    {!readOnly && <button type="button" onClick={() => void restore(r)} disabled={locked || restoreBlocked(dirty)} aria-describedby={`ins-rev-${r.id}`} className="btn btn-secondary btn-xs">{restoring === r.id ? I.restoring : I.restore}</button>}
                  </div>
                </div>
                <p className="mt-1 text-xs text-foreground-muted"><span className="tnum">{fill(I.on, { n: r.count })}</span> · {fill(I.changes, { a: r.added, r: r.removed, c: r.changed })}</p>
                {cmp?.id === r.id && cmp.diff && (
                  <div className="mt-2 rounded-lg border border-border p-3">
                    <h3 className="text-sm font-semibold">{I.compareTitle}</h3>
                    {cmp.diff.added.length + cmp.diff.removed.length + cmp.diff.changed.length === 0 ? (
                      <p className="mt-1 text-sm text-foreground-muted">{I.noDiff}</p>
                    ) : (
                      <div className="mt-1 grid gap-2">
                        {cmp.diff.added.length > 0 && <div><p className="text-xs font-semibold text-foreground-muted">{I.diffAdded}</p>{cmp.diff.added.map((i) => <ItemLine key={i.id} t={t} i={i} />)}</div>}
                        {cmp.diff.removed.length > 0 && <div><p className="text-xs font-semibold text-foreground-muted">{I.diffRemoved}</p>{cmp.diff.removed.map((i) => <ItemLine key={i.id} t={t} i={i} />)}</div>}
                        {cmp.diff.changed.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-foreground-muted">{I.diffChanged}</p>
                            {cmp.diff.changed.map((c) => (
                              <div key={c.after.id} className="mt-1 grid gap-1 md:grid-cols-2">
                                <div><p className="text-xs text-foreground-muted">{I.then}</p><ItemLine t={t} i={c.before} /></div>
                                <div><p className="text-xs text-foreground-muted">{I.now}</p><ItemLine t={t} i={c.after} /></div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* Outside the fieldset too: a disabled fieldset would disable the dialog's buttons with it. */}
      {confirmDialog}
    </div>
  );
}
