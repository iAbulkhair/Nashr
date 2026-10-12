"use client";
import { useRef, useState } from "react";
import { appDict } from "@/lib/app-i18n";
import type { By } from "@/lib/actor";
import { isAgentId, type AgentId } from "@/lib/agents";
import { adminFetch } from "@/lib/admin-fetch";
import { dateFormat } from "@/lib/dates";
import { summarizeRevision, type HistoryRow, type SetDiff } from "@/lib/instructions-diff";
import { PLATFORM_CHARS, TEST_BRIEF_CHARS } from "@/lib/instructions-safety";
import type { Draft, Instruction, Layer, Revision } from "@/lib/instructions-store";
import { PLATFORM_TARGETS, ROW_CODES, errorText, fill, formAfterWrite, parseTestResult, restoreBlocked, sameDrafts, toDraft, type TestItem } from "@/lib/instructions-ui";
import type { ConsoleState, AdminTestOption, FeedView } from "@/lib/skills-admin";
import type { TaskType } from "@/lib/tasks";
import { render } from "@/lib/md";
import { useConfirm } from "../app/ConfirmDialog";
import InstructionEditor, { targetLabel, type RowErrors } from "../app/InstructionEditor";
import { useAdminEnded, EndedNotice } from "./shared";

type Lang = "ar" | "en";
type Busy = null | "save" | "activate" | "discard" | "restore" | "test" | "pause" | "open" | "refresh";
type Reply = { ok: boolean; status: number; j: Record<string, unknown> };

const URL = "/api/admin/skills";

/** The console's own words. The editor, the errors and the agent names come from the shared dictionary (`appDict`). */
const S = {
  ar: {
    title: "مهارات الوكلاء",
    sub: "تعليمات المنصة التي تُضاف إلى كل وكيل عند كل تشغيل، وما غيّره العملاء في مساحاتهم، ومفتاح إيقاف تعليمات العملاء.",
    pauseTitle: "تعليمات العملاء",
    pausedNow: "تعليمات العملاء متوقفة الآن: لا تُطبَّق أي تعليمات مساحة عمل في أي مكان، وتعليمات المنصة تعمل كما هي.",
    runningNow: "تعليمات العملاء تعمل. يمكنك إيقافها كلها بضغطة واحدة إن لزم.",
    pause: "إيقاف تعليمات العملاء",
    resume: "استئناف تعليمات العملاء",
    pauseConfirmTitle: "إيقاف تعليمات العملاء؟",
    pauseConfirm: "لن تُطبَّق تعليمات أي مساحة عمل على أي وكيل حتى تستأنفها. تعليمات المنصة لا تتغير. ما كتبه العملاء يبقى محفوظًا.",
    resumeConfirmTitle: "استئناف تعليمات العملاء؟",
    resumeConfirm: "تعود تعليمات مساحات العمل إلى كل وكيل فورًا.",
    editorTitle: "تعليمات المنصة",
    editorSub: "تُدمج في كل وكيل لكل العملاء. علامة «لا يمكن تجاوزها» تمنع أي تعليمة عميل من مخالفة النص.",
    reviewerNote: "«المراجع» و«الحَكَم» يقرآن تعليمات المنصة فقط ولا يقرآن تعليمات العملاء.",
    activeNow: "النسخة الحية: {v} · {n} تعليمة مفعّلة",
    noneActive: "لا توجد نسخة حية بعد.",
    draftBanner: "لديك مسودة محفوظة تختلف عن النسخة الحية {v}. لا تُطبَّق قبل التفعيل.",
    testTitle: "جرّب هذه التعليمة",
    testSub: "تكتب عنصرًا واحدًا مرتين من الطلب نفسه على علامة «Sample Café» التجريبية: مرة بالنسخة الحية ومرة بمسودتك المحفوظة. لا يُخصم أي رصيد من أحد، ولا يصل شيء إلى صندوق الموافقات، وله حد ساعي مشترك.",
    testNone: "لا توجد أنواع للتجربة الآن.",
    testConfirmTitle: "تشغيل التجربة؟",
    testConfirm: "يُكتب عنصران على العلامة التجريبية. لا رصيد يُخصم، ويُحسب من حد التجارب في الساعة.",
    testConfirmLabel: "تشغيل",
    testButton: "جرّب المسودة",
    testing: "جارٍ التجربة…",
    testSample: "العلامة التجريبية: {name}",
    testNoCharge: "لم يُخصم أي رصيد.",
    historyTitle: "سجل النسخ",
    historySub: "كل تفعيل واستعادة محفوظ. قارن نسخة بالنسخة الحية أو أعدها.",
    feedTitle: "تغييرات مساحات العمل",
    feedSub: "من فعّل أو استعاد أو قبل اقتراحًا، ومتى، وكم تعليمة مفعّلة. النص لا يظهر هنا؛ افتح «عرض» لقراءة النسخة الحية للقراءة فقط.",
    feedEmpty: "لم يغيّر أي عميل تعليماته بعد.",
    feedActions: { activate: "فعّل", restore: "استعاد", apply: "قبل اقتراحًا" },
    feedBrand: "علامة",
    refresh: "تحديث",
    refreshing: "جارٍ التحديث…",
    open: "عرض",
    opening: "جارٍ الفتح…",
    close: "إغلاق",
    workspaceTitle: "النسخة الحية لمساحة {who} (قراءة فقط)",
    workspaceEmpty: "لا توجد تعليمات مفعّلة فيها.",
    byFounder: "المؤسس",
    byOther: "جهة أخرى",
    unsavedEdits: "حفظ تعديلاتك أولًا.",
  },
  en: {
    title: "Agent skills",
    sub: "The platform instructions merged into every agent on every run, what customers changed in their workspaces, and the switch that pauses customer instructions.",
    pauseTitle: "Customer instructions",
    pausedNow: "Customer instructions are paused: no workspace instructions are applied anywhere, and the platform instructions work as they are.",
    runningNow: "Customer instructions are running. You can pause all of them with one click if you need to.",
    pause: "Pause customer instructions",
    resume: "Resume customer instructions",
    pauseConfirmTitle: "Pause customer instructions?",
    pauseConfirm: "No workspace's instructions are applied to any agent until you resume. The platform instructions do not change. What customers wrote stays saved.",
    resumeConfirmTitle: "Resume customer instructions?",
    resumeConfirm: "Workspace instructions go back into every agent right away.",
    editorTitle: "Platform instructions",
    editorSub: "Merged into every agent for every customer. A row marked \"customers cannot override\" stops a customer instruction from contradicting it.",
    reviewerNote: "The reviewer and the judge read the platform instructions only, never a customer's.",
    activeNow: "Live version {v} · {n} instructions on",
    noneActive: "No live version yet.",
    draftBanner: "You have a saved draft that differs from live version {v}. It is not applied until you activate it.",
    testTitle: "Test this instruction",
    testSub: "Writes one item twice from the same brief on the built-in Sample Café brand: once with the live instructions and once with your saved draft. No one's credits are charged, nothing goes to an approval inbox, and the tests share an hourly limit.",
    testNone: "No types to test right now.",
    testConfirmTitle: "Run the test?",
    testConfirm: "Two items are written for the sample brand. No credits are charged; it counts toward the hourly test limit.",
    testConfirmLabel: "Run",
    testButton: "Test the draft",
    testing: "Testing…",
    testSample: "Sample brand: {name}",
    testNoCharge: "No credits were charged.",
    historyTitle: "Version history",
    historySub: "Every activation and restore is kept. Compare a version with the live one, or put it back.",
    feedTitle: "Workspace changes",
    feedSub: "Who activated, restored or accepted a suggestion, when, and how many instructions are on. No text is shown here; open View to read the live version, read only.",
    feedEmpty: "No customer has changed their instructions yet.",
    feedActions: { activate: "activated", restore: "restored", apply: "accepted a suggestion" },
    feedBrand: "brand",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    open: "View",
    opening: "Opening…",
    close: "Close",
    workspaceTitle: "Live version of {who} (read only)",
    workspaceEmpty: "It has no instructions on.",
    byFounder: "Founder",
    byOther: "Other",
    unsavedEdits: "Save your edits first.",
  },
} as const;

/** Model or customer text through the safe renderer (it escapes HTML): the same `render` the approval inbox shows a draft with. */
function Body({ md }: { md: string }) {
  return <div className="prose-nashr prose-compact mt-2 text-sm text-foreground" dir="auto" dangerouslySetInnerHTML={{ __html: render(md) }} />;
}

/** One instruction as a comparison or a workspace view shows it: plain text, and what else differs. */
function ItemLine({ t, i }: { t: ReturnType<typeof dictOf>; i: Instruction }) {
  const I = t.instructions;
  const meta = [i.agents === "all" ? "" : fill(I.itemFor, { agents: i.agents.map((a) => targetLabel(t, a)).join(", ") }), i.on ? "" : I.itemOff, i.lock ? I.locked : ""].filter(Boolean).join(" · ");
  return (
    <p className="text-sm">
      <bdi>{i.text}</bdi>
      {meta && <span className="text-xs text-foreground-muted"> · {meta}</span>}
    </p>
  );
}
const dictOf = (lang: Lang) => appDict[lang];

/**
 * The founder's skills console (agent skills portal, spec 8.2; rules 958-959). The state comes from the server render
 * (`consoleState`, the same function GET answers with); the browser asks only when the founder acts, always through
 * `adminFetch` and only this one endpoint. `base` is the layer's edit counter as the page was loaded, and the form always
 * follows the layer an answer carries (`formAfterWrite`), so a save from a second tab never overwrites newer text:
 * `stale` offers a reload instead. Restore waits while the form has unsaved edits (`restoreBlocked`).
 */
export default function SkillsAdminPanel({ lang, keySession, initial, testOptions }: { lang: Lang; keySession: boolean; initial: ConsoleState; testOptions: AdminTestOption[] }) {
  const t = dictOf(lang);
  const I = t.instructions;
  const G = t.governance;
  const A = S[lang];
  const ended = useAdminEnded();
  const [ask, confirmDialog] = useConfirm();
  const [layer, setLayer] = useState<Layer>(initial.layer);
  const [base, setBase] = useState(initial.base);
  const [rows, setRows] = useState<Draft[]>(() => (initial.layer.draft ?? initial.layer.active).items.map(toDraft));
  const [history, setHistory] = useState<HistoryRow[]>(initial.history);
  const [paused, setPaused] = useState(initial.paused);
  const [feed, setFeed] = useState<FeedView[]>(initial.feed);
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [stale, setStale] = useState(false);
  const [histMsg, setHistMsg] = useState("");
  const [histErr, setHistErr] = useState("");
  const [cmp, setCmp] = useState<{ id: string; loading: boolean; diff?: SetDiff } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [pauseErr, setPauseErr] = useState("");
  const [feedErr, setFeedErr] = useState("");
  const [view, setView] = useState<{ scope: string; items: Instruction[] } | null>(null);
  // The newest Compare / View request: a slower, earlier answer is ignored.
  const cmpToken = useRef(0);
  const viewToken = useRef(0);
  const [agent, setAgent] = useState<AgentId | "">(testOptions[0]?.agent ?? "");
  const [type, setType] = useState<TaskType | "">(testOptions[0]?.type ?? "");
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<{ before: TestItem; after: TestItem; sample: string } | null>(null);
  const [testErr, setTestErr] = useState("");

  const saved = (layer.draft ?? layer.active).items.map(toDraft);
  const dirty = !sameDrafts(rows, saved);
  const hasDraft = layer.draft !== null;
  const draftDiffers = hasDraft && !sameDrafts(layer.draft!.items.map(toDraft), layer.active.items.map(toDraft));
  const activeOn = layer.active.items.filter((i) => i.on).length;
  const when = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const who = (b: By) => (b.kind === "member" ? `${G.byMember}${b.email ? ` · ${b.email}` : ""}` : b.kind === "founder" ? G.byFounder : b.kind === "token" ? G.byToken : b.kind === "system" ? G.bySystem : G.byOwner);
  const locked = busy !== null || restoring !== null;

  /** One request: the answer's status and JSON, or status 0 when the network failed. Never throws. `adminFetch` announces a 401 so the console shows the ended notice. */
  async function call(method: "GET" | "POST" | "PUT", body?: unknown, query = ""): Promise<Reply> {
    try {
      const res = await adminFetch(`${URL}${query}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok && j.ok === true, status: res.status, j };
    } catch {
      return { ok: false, status: 0, j: {} };
    }
  }
  const reason = (r: Reply) => errorText(t, r.j.error ?? (r.status === 401 ? "unauthorized" : undefined), { max: PLATFORM_CHARS });
  const clear = () => { setMsg(""); setErr(""); setRowErrors({}); setStale(false); setHistMsg(""); setHistErr(""); };

  /** What the server stored is what the page shows: the form follows the layer an answer carries, never local rows next to a newer base. */
  function adopt(next: Layer) {
    setLayer(next);
    const f = formAfterWrite(next);
    setRows(f.rows);
    setBase(f.base);
  }
  function fail(r: Reply, into: "page" | "history" = "page") {
    const code = r.j.error;
    if (into === "history") { setHistErr(reason(r)); return; }
    if (typeof code === "string" && ROW_CODES.has(code) && typeof r.j.index === "number") { setRowErrors({ [r.j.index]: reason(r) }); return; }
    if (code === "stale") setStale(true);
    setErr(reason(r));
  }

  async function save(): Promise<boolean> {
    clear();
    setBusy("save");
    try {
      const r = await call("PUT", { items: rows, base });
      if (!r.ok) { fail(r); return false; }
      adopt(r.j.layer as Layer);
      setMsg(I.saved);
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
      const r = await call("POST", { action: "activate" });
      if (!r.ok) { fail(r); return; }
      adopt(r.j.layer as Layer);
      setHistory((h) => [summarizeRevision(r.j.revision as Revision), ...h].slice(0, 20));
      setMsg(I.activated);
    } finally {
      setBusy(null);
    }
  }
  async function discard() {
    clear();
    if (!(await ask({ title: I.discardTitle, message: I.discardConfirm, confirmLabel: I.discard, cancelLabel: t.dialog.back, destructive: true }))) return;
    setBusy("discard");
    try {
      const r = await call("POST", { action: "discard" });
      if (!r.ok) { fail(r); return; }
      adopt(r.j.layer as Layer);
      setMsg(I.discarded);
    } finally {
      setBusy(null);
    }
  }

  async function compare(id: string) {
    setHistErr("");
    const mine = ++cmpToken.current;
    if (cmp?.id === id) { setCmp(null); return; }
    setCmp({ id, loading: true });
    const r = await call("GET", undefined, `?compare=${encodeURIComponent(id)}`);
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
      const r = await call("POST", { action: "restore", revisionId: row.id });
      if (!r.ok) { fail(r, "history"); return; }
      adopt(r.j.layer as Layer);
      setHistory((h) => [summarizeRevision(r.j.revision as Revision), ...h].slice(0, 20));
      setCmp(null);
      setHistMsg(I.restored);
    } finally {
      setRestoring(null);
    }
  }

  async function togglePause() {
    setPauseErr("");
    const next = !paused;
    if (!(await ask({ title: next ? A.pauseConfirmTitle : A.resumeConfirmTitle, message: next ? A.pauseConfirm : A.resumeConfirm, confirmLabel: next ? A.pause : A.resume, cancelLabel: t.dialog.back, destructive: next }))) return;
    setBusy("pause");
    try {
      const r = await call("POST", { action: "pause", on: next });
      if (!r.ok) { setPauseErr(reason(r)); return; }
      setPaused(r.j.paused === true);
    } finally {
      setBusy(null);
    }
  }

  /** Reads the feed again (and the pause switch, which another founder tab may have changed). The editor, its form and its base are left as they are: only the server's feed is replaced. */
  async function refreshFeed() {
    setFeedErr("");
    setBusy("refresh");
    try {
      const r = await call("GET");
      if (!r.ok || !Array.isArray(r.j.feed)) { setFeedErr(reason(r)); return; }
      const next = r.j.feed as FeedView[];
      setFeed(next);
      if (typeof r.j.paused === "boolean") setPaused(r.j.paused);
      // A workspace that left the feed cannot stay open.
      setView((v) => (v && next.some((f) => f.scope === v.scope) ? v : null));
    } finally {
      setBusy(null);
    }
  }

  /** Opens a workspace the feed names, read only. The scope sent is the feed row's own; the server checks it against its feed. */
  async function openWorkspace(row: FeedView) {
    setFeedErr("");
    const mine = ++viewToken.current;
    if (view?.scope === row.scope) { setView(null); return; }
    setBusy("open");
    try {
      const r = await call("GET", undefined, `?workspace=${encodeURIComponent(row.scope)}`);
      if (viewToken.current !== mine) return;
      const l = r.j.layer as Layer | undefined;
      if (!r.ok || !l) { setFeedErr(reason(r)); return; }
      setView({ scope: row.scope, items: l.active.items });
    } finally {
      setBusy(null);
    }
  }

  const option = testOptions.find((o) => o.agent === agent && o.type === type);
  const agentsOffered = [...new Set(testOptions.map((o) => o.agent))];
  async function runTest() {
    // A second click while a test runs does nothing: `busy` is set before the first await and every control is disabled by it.
    if (!option || busy !== null) return;
    setTestErr("");
    if (!(await ask({ title: A.testConfirmTitle, message: A.testConfirm, confirmLabel: A.testConfirmLabel, cancelLabel: t.dialog.back }))) return;
    setBusy("test");
    setResult(null);
    try {
      const r = await call("POST", { action: "test", agent: option.agent, type: option.type, brief: brief.trim() });
      const done = r.ok ? parseTestResult({ ...r.j, spent: typeof r.j.spent === "number" ? r.j.spent : 0 }) : null;
      if (!done) { setTestErr(errorText(t, r.j.error ?? (r.status === 401 ? "unauthorized" : undefined), { max: TEST_BRIEF_CHARS })); return; }
      setResult({ before: done.before, after: done.after, sample: typeof r.j.sample === "string" ? r.j.sample : "" });
    } finally {
      setBusy(null);
    }
  }
  const testHint = !hasDraft ? I.testNeedsDraft : dirty ? I.testNeedsSaved : "";
  const col = (label: string, it: TestItem) => (
    <section className="min-w-0 rounded-xl border-[1.5px] border-border p-3">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="mt-1 text-xs text-foreground-muted"><bdi>{it.channel}</bdi></p>
      <p className="mt-1 font-medium" dir="auto">{it.title}</p>
      <Body md={it.body} />
    </section>
  );

  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title">{A.title}</h1>
      <p className="mt-2 text-foreground-muted">{A.sub}</p>

      <section className="card mt-6" aria-labelledby="sk-pause">
        <h2 id="sk-pause" className="font-display font-medium">{A.pauseTitle}</h2>
        <p role="status" className={`mt-2 rounded-lg border px-3 py-2 text-sm ${paused ? "border-danger/40 bg-danger/10" : "border-border"}`}>{paused ? A.pausedNow : A.runningNow}</p>
        <div className="mt-3">
          <button type="button" onClick={() => void togglePause()} disabled={locked} className={`btn btn-sm ${paused ? "btn-primary" : "btn-danger"}`}>{paused ? A.resume : A.pause}</button>
        </div>
        {pauseErr && <p role="alert" className="mt-2 text-sm text-danger">{pauseErr}</p>}
      </section>

      <section className="card mt-4" aria-labelledby="sk-edit">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sk-edit" className="font-display font-medium">{A.editorTitle}</h2>
          <p className="text-sm text-foreground-muted">{layer.active.v > 0 ? fill(A.activeNow, { v: layer.active.v, n: activeOn }) : A.noneActive}</p>
        </div>
        <p className="mt-1 text-sm text-foreground-muted">{A.editorSub}</p>
        <p className="mt-1 text-xs text-foreground-muted">{A.reviewerNote}</p>
        {draftDiffers && !dirty && <p role="status" className="mt-2 rounded-lg border border-lemon/40 bg-lemon/10 px-3 py-2 text-sm">{fill(A.draftBanner, { v: layer.active.v })}</p>}
        <div className="mt-4 min-w-0">
          <InstructionEditor t={t} items={rows} onChange={(r) => { setRows(r); setRowErrors({}); }} maxChars={PLATFORM_CHARS} targets={[...PLATFORM_TARGETS]} perAgent refsOn={false} files={[]} allowLock readOnly={false} errors={rowErrors} />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={locked || !dirty} className="btn btn-secondary btn-sm">{busy === "save" ? I.saving : I.saveDraft}</button>
            <button type="button" onClick={() => void activate()} disabled={locked || (!dirty && !hasDraft)} className="btn btn-primary btn-sm">{busy === "activate" ? I.activating : I.activate}</button>
            <button type="button" onClick={() => void discard()} disabled={locked || !hasDraft} className="btn btn-danger btn-sm">{busy === "discard" ? I.discarding : I.discard}</button>
            {dirty && <span className="text-sm text-foreground-muted">{I.unsaved}</span>}
          </div>
          {msg && <p role="status" className="mt-2 text-sm text-foreground">{msg}</p>}
          {err && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {err}
              {stale && <> <button type="button" onClick={() => window.location.reload()} className="underline">{I.reload}</button></>}
            </p>
          )}
        </div>
      </section>

      <section className="card mt-4" aria-labelledby="sk-test">
        <h2 id="sk-test" className="font-display font-medium">{A.testTitle}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{A.testSub}</p>
        {testOptions.length === 0 ? (
          <p className="mt-3 text-sm text-foreground-muted">{A.testNone}</p>
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
              <button type="button" onClick={() => void runTest()} disabled={locked || !option || !!testHint} className="btn btn-primary btn-sm">{busy === "test" ? A.testing : A.testButton}</button>
              {testHint && <span className="text-sm text-foreground-muted">{testHint}</span>}
            </div>
          </div>
        )}
        {testErr && <p role="alert" className="mt-2 text-sm text-danger">{testErr}</p>}
        {result && (
          <div className="mt-4">
            <div className="grid gap-3 md:grid-cols-2">{col(I.before, result.before)}{col(I.after, result.after)}</div>
            <p className="mt-2 text-xs text-foreground-muted">{result.sample && <bdi>{fill(A.testSample, { name: result.sample })}</bdi>} {A.testNoCharge}</p>
          </div>
        )}
      </section>

      <section className="card mt-4" aria-labelledby="sk-history">
        <h2 id="sk-history" className="font-display font-medium">{A.historyTitle}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{A.historySub}</p>
        {restoreBlocked(dirty) && <p className="mt-2 text-sm text-foreground-muted">{I.restoreNeedsSaved}</p>}
        {histMsg && <p role="status" className="mt-2 text-sm text-foreground">{histMsg}</p>}
        {histErr && <p role="alert" className="mt-2 text-sm text-danger">{histErr}</p>}
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-foreground-muted">{I.historyEmpty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-foreground/10">
            {history.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <strong id={`sk-rev-${r.id}`}>{fill(I.version, { v: r.v })}</strong>
                    <span className="text-foreground-muted"> · </span>
                    <time dateTime={r.at} suppressHydrationWarning>{when.format(new Date(r.at))} UTC</time>
                    <span className="text-foreground-muted"> · </span>
                    <span dir="auto">{who(r.by)}</span>
                    {r.rollbackOf && <span className="ms-2 badge">{I.restoreBadge}</span>}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void compare(r.id)} disabled={locked && !cmp} aria-describedby={`sk-rev-${r.id}`} aria-expanded={cmp?.id === r.id} className="btn btn-secondary btn-xs">{cmp?.id === r.id ? (cmp.loading ? I.comparing : I.hideCompare) : I.compare}</button>
                    <button type="button" onClick={() => void restore(r)} disabled={locked || restoreBlocked(dirty)} aria-describedby={`sk-rev-${r.id}`} className="btn btn-secondary btn-xs">{restoring === r.id ? I.restoring : I.restore}</button>
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

      <section className="card mt-4" aria-labelledby="sk-feed">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sk-feed" className="font-display font-medium">{A.feedTitle}</h2>
          <button type="button" onClick={() => void refreshFeed()} disabled={locked} className="btn btn-secondary btn-xs">{busy === "refresh" ? A.refreshing : A.refresh}</button>
        </div>
        <p className="mt-1 text-sm text-foreground-muted">{A.feedSub}</p>
        {feedErr && <p role="alert" className="mt-2 text-sm text-danger">{feedErr}</p>}
        {feed.length === 0 ? (
          <p className="mt-3 text-sm text-foreground-muted">{A.feedEmpty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-foreground/10">
            {feed.map((r) => (
              <li key={`${r.scope}:${r.at}:${r.action}:${r.v}`} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-sm">
                    <bdi>{r.email}</bdi>
                    {r.brand && <span className="text-xs text-foreground-muted"> · {A.feedBrand} <bdi>{r.brand}</bdi></span>}
                    <span className="text-foreground-muted"> · </span>
                    {A.feedActions[r.action]}
                    <span className="text-foreground-muted"> · </span>
                    <span className="tnum">{fill(I.version, { v: r.v })}</span>
                    <span className="text-foreground-muted"> · </span>
                    <span className="tnum">{fill(I.on, { n: r.count })}</span>
                    <span className="text-foreground-muted"> · </span>
                    <time dateTime={r.at} suppressHydrationWarning>{when.format(new Date(r.at))} UTC</time>
                  </p>
                  <button type="button" onClick={() => void openWorkspace(r)} disabled={locked} aria-expanded={view?.scope === r.scope} className="btn btn-secondary btn-xs">{view?.scope === r.scope ? A.close : busy === "open" ? A.opening : A.open}</button>
                </div>
                {view?.scope === r.scope && (
                  <div className="mt-2 rounded-lg border border-border p-3">
                    <h3 className="text-sm font-semibold">{fill(A.workspaceTitle, { who: r.email + (r.brand ? ` · ${r.brand}` : "") })}</h3>
                    {view.items.length === 0 ? <p className="mt-1 text-sm text-foreground-muted">{A.workspaceEmpty}</p> : <div className="mt-1 grid gap-1">{view.items.map((i) => <ItemLine key={i.id} t={t} i={i} />)}</div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* Outside any disabled group: a disabled fieldset would disable the dialog's buttons with it. */}
      {confirmDialog}
    </div>
  );
}
