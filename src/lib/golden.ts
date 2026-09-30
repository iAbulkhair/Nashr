import { randomBytes } from "crypto";
import { db } from "./db";
import { generate, type Generated } from "./noor";
import { scoreItems, type Quality } from "./judge";
import { AGENTS, agentForTask, type AgentId } from "./agents";
import { TASK_COUNT, type Brand, type TaskType } from "./brand";
import { adminEmails } from "./auth";
import { notifyItem } from "./notifications";
import { getUsage } from "./usage";
import { CUSTOMER_FACING, brandRules, checkText } from "./brand-rules";
import { modelState } from "./model";
import { promptHashes, promptStamp, type PromptStamp } from "./prompt-stamp";

/**
 * Weekly golden set. A fixed list of cases (fictional brand + task type + owner
 * notes) runs through the real pipeline (generate → reviewer → judge) so agent
 * quality is comparable week over week, independent of what real users asked.
 * Every case also gets deterministic checks that do not depend on the judge.
 * Bump GOLDEN_VERSION when cases or brands change: deltas only compare runs of
 * the same version.
 */
export const GOLDEN_VERSION = 5; // v2: judge reads full bodies. v3: reduced counts, local currency. v4: reviewer and judge share content/skills/review.md. v5: judge sees owner notes + workspace data and caps auto-fails; reviewer is per agent
export const GOLDEN_EMAIL = "golden@nashr.internal";
const CONCURRENCY = 8;
/** Do not start new cases after this many ms; the route has maxDuration 300. */
const START_BUDGET_MS = 200_000;
const CASE_DROP = 10, AGENT_DROP = 6, LOW = 70;

const base = { website: "", competitors: "", channels: ["instagram", "snapchat", "tiktok", "whatsapp"], updatedAt: "2026-09-18T00:00:00.000Z" };
/** Fictional brands. No real company; do not reuse in marketing. */
export const GOLDEN_BRANDS: Record<string, Brand> = {
  roastery: { ...base, name: "محمصة ريف", industry: "متجر إلكتروني للقهوة المختصة", dialect: "saudi", languages: ["ar"], city: "الرياض", tone: "دافئ، قريب، خبير بدون تعالٍ", products: "حبوب قهوة مختصة محمّصة أسبوعياً (إثيوبي، كولومبي، يمني)، أدوات تحضير V60 وكيمكس، اشتراك شهري للحبوب. الأسعار غير مذكورة.", audience: "محبو القهوة المختصة في السعودية، 22-40 سنة، يحضّرون قهوتهم في البيت", offers: "شحن مجاني للطلبات فوق 200 ريال", banned: "أرخص، رخيص، الأفضل في المملكة", preferred: "محمّص طازج، من المحمصة لبابك", valueProp: "تحميص أسبوعي وتاريخ التحميص مكتوب على كل كيس" },
  clinic: { ...base, name: "عيادات لمسة", industry: "عيادات أسنان وجلدية", dialect: "emirati", languages: ["ar", "en"], city: "دبي", tone: "مطمئن، مهني، بسيط", products: "تنظيف وتبييض الأسنان، تقويم شفاف، استشارات جلدية، جلسات عناية بالبشرة. لا أسعار معلنة.", audience: "عائلات وموظفون في دبي، 25-50 سنة", offers: "", banned: "مضمون، علاج نهائي، بدون ألم 100%، guaranteed", preferred: "استشارة، تقييم مع الطبيب", channels: ["instagram", "whatsapp", "gbp"] },
  saas: { ...base, name: "Daftar", industry: "B2B SaaS, e-invoicing for small businesses", dialect: "english", languages: ["en"], city: "Riyadh", tone: "clear, practical, no hype", products: "ZATCA-compliant e-invoicing web app for SMBs: invoices, quotes, VAT reports, WhatsApp invoice delivery. Pricing not stated.", audience: "Owners and accountants of 3-30 person companies in Saudi Arabia", offers: "14-day free trial", banned: "revolutionary, game-changing, #1", preferred: "ZATCA-ready, in minutes", channels: ["linkedin", "x", "whatsapp", "email"] },
};

type Must = { name: string; re: string; flags?: string };
export type GoldenCase = { id: string; brand: keyof typeof GOLDEN_BRANDS; type: TaskType; count?: number; extra?: string; stats?: string; /** fail when a currency amount appears that is not in the brand file or notes */ noPrices?: boolean; maxChars?: number; must?: Must[] };

const STATS = `WORKSPACE DATA (last 7 days vs prior 7)
- Items generated: 24 (prior 18)
- Approved: 17, rejected: 3, pending: 4
- Published: 9 (instagram 5, snapchat 2, x 2)
- Revenue, orders, ad spend, followers: not connected`;
const FEEDBACK = `آراء العملاء (منسوخة كما وصلت):
1. "الكيس وصل بعد 6 أيام، القهوة ممتازة بس التوصيل بطيء"
2. "ما عرفت أختار بين الإثيوبي والكولومبي، ما فيه شرح كافي"
3. "الاشتراك الشهري حلو لكن ما أقدر أغيّر نوع الحبوب"
4. "التوصيل تأخر أسبوع"
5. "أتمنى فيه أكياس أصغر للتجربة"
6. "تاريخ التحميص على الكيس شي يفرق معي، استمروا"
7. "حاولت أوقف الاشتراك مؤقتاً وما لقيت الخيار"`;

export const GOLDEN_CASES: GoldenCase[] = [
  { id: "noor-social-roastery", brand: "roastery", type: "social", count: 3, extra: "ركّزي على الاشتراك الشهري. لا تذكري أي سعر.", noPrices: true },
  { id: "noor-ads-clinic", brand: "clinic", type: "ads", count: 2, extra: "حملة لخدمة تبييض الأسنان. التزمي بقواعد الإعلانات الصحية." },
  { id: "noor-whatsapp-roastery", brand: "roastery", type: "whatsapp", count: 2, noPrices: true, maxChars: 700, must: [{ name: "placeholder {{1}}", re: "\\{\\{1\\}\\}" }] },
  { id: "noor-article-saas", brand: "saas", type: "article", extra: "Keyword: ZATCA phase 2 e-invoicing for small businesses.", noPrices: true, must: [{ name: "FAQ section", re: "FAQ|Frequently asked", flags: "i" }] },
  { id: "sami-script-saas", brand: "saas", type: "sales_script", count: 1, extra: "Leads are accountants at trading companies who still invoice in Excel." },
  { id: "sami-followup-clinic", brand: "clinic", type: "followup_seq", count: 3, extra: "مراجع أخذ عرض تقويم شفاف ولم يرد.", noPrices: true },
  { id: "razan-pricing-roastery", brand: "roastery", type: "pricing_review", extra: "أفكر في إطلاق اشتراك شهري بثلاث باقات. لا أعرف تكلفتي بدقة بعد.", must: [{ name: "VAT note", re: "ضريبة|VAT", flags: "i" }, { name: "placeholder for unknowns", re: "\\[رقم\\]|\\[number\\]", flags: "i" }] },
  { id: "razan-unit-saas", brand: "saas", type: "unit_economics", must: [{ name: "Markdown table", re: "\\|.+\\|" }, { name: "LTV:CAC", re: "LTV", flags: "i" }] },
  { id: "faris-gtm-saas", brand: "saas", type: "gtm_plan", extra: "Launching in Riyadh and Jeddah. One founder plus one marketer." },
  { id: "faris-experiments-roastery", brand: "roastery", type: "growth_experiments", count: 2, must: [{ name: "ICE score", re: "ICE", flags: "i" }] },
  { id: "dana-report-roastery", brand: "roastery", type: "weekly_report", stats: STATS, must: [{ name: "placeholder for missing data", re: "\\[رقم\\]|\\[number\\]", flags: "i" }] },
  { id: "dana-dashboard-saas", brand: "saas", type: "dashboard_spec", must: [{ name: "Markdown table", re: "\\|.+\\|" }] },
  { id: "majed-memo-clinic", brand: "clinic", type: "decision_memo", extra: "السؤال: هل نفتح فرعاً ثانياً في أبوظبي أم نستثمر في خدمة الاستشارات عن بُعد؟" },
  { id: "majed-ai-roastery", brand: "roastery", type: "decision_memo", extra: "السؤال: هل نستخدم الذكاء الاصطناعي للرد على عملاء واتساب وكتابة أوصاف المنتجات؟ الفريق 6 أشخاص ولا أحد تقني.", must: [{ name: "human review stated", re: "مراجع|اعتماد|موافق|يراجع|إشراف" }] },
  { id: "majed-portfolio-roastery", brand: "roastery", type: "strategy_review", extra: "عندنا ثلاثة خطوط: حبوب القهوة، أدوات التحضير، والاشتراك الشهري. لا أعرف أيها أركّز عليه. لا أرقام دقيقة عندي الآن.", must: [{ name: "placeholder for unknowns", re: "\\[رقم\\]|\\[number\\]", flags: "i" }] },
  { id: "majed-okrs-saas", brand: "saas", type: "okrs", extra: "Company of 9 people. Goal this quarter: first 100 paying customers." },
  { id: "layan-prd-saas", brand: "saas", type: "prd", extra: "Feature: send invoices and payment reminders over WhatsApp." },
  { id: "layan-feedback-roastery", brand: "roastery", type: "feedback_synthesis", extra: FEEDBACK },
];

export type Check = { name: string; pass: boolean; detail?: string };
export type GoldenResult = {
  id: string; agent: AgentId; type: TaskType; brand: string; ok: boolean; error?: string;
  score: number | null; dims: Quality["dims"] | null; notes: string[]; checks: Check[];
  items: Generated[]; ms: number; delta: number | null;
  /**
   * startedAt of the run that actually measured this case, set when a single-agent rerun copied it forward. Without it
   * a copied row was indistinguishable from a fresh one: it carried today's run id and date, and its delta against
   * the run it was copied from was exactly 0 — so weeks-old results read as measured today and perfectly stable.
   */
  carried?: string;
  /** Which prompts produced this row (src/lib/prompt-stamp.ts). A carried row keeps the stamp of the run that measured it. */
  pb?: PromptStamp;
};
export type GoldenRun = {
  id: string; version: number; trigger: "cron" | "manual"; startedAt: string; finishedAt: string;
  status: "complete" | "partial"; overall: number | null; usd: number;
  /**
   * `checksRun` sits beside `failedChecks` because 0 failures means nothing without it: an agent whose cases all
   * errored or were skipped ran no checks and showed a green tick, identical to one whose every check passed.
   */
  /**
   * `promptChanged`: whether the prompts behind the agent's cases measured in this run differ from those behind the same
   * cases in the previous run, compared by each case's stamp (see `promptChangeOf`); null when there is nothing to compare.
   */
  agents: { agent: AgentId; cases: number; score: number | null; delta: number | null; checksRun: number; failedChecks: number; promptChanged: boolean | null }[];
  results: GoldenResult[]; regressions: string[];
  /**
   * The prompt versions this run started with (`promptHashes`): every agent playbook and review.md by file name, and
   * `code:<type>` for each case type. A resumed run keeps its first attempt's. A record for the console only: carried
   * rows and a resumed run's earlier rows were made with other prompts, so `promptChanged` compares each case's `pb`.
   * Absent on runs before 2026-09-29. GOLDEN_VERSION still decides which runs compare.
   */
  playbooks?: Record<string, string>;
};

const AR = /[\u0600-\u06FF]/g, LAT = /[A-Za-z]/g;
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,٬]/g, "");

/** Deterministic checks: independent of the LLM judge, so a judge drift cannot hide a regression. */
export function hardChecks(c: GoldenCase, brand: Brand, items: Generated[]): Check[] {
  const want = c.count && c.count > 0 ? Math.min(c.count, TASK_COUNT[c.type]) : TASK_COUNT[c.type];
  const all = items.map((i) => i.body).join("\n");
  const out: Check[] = [{ name: "item count", pass: items.length === want, detail: `${items.length}/${want}` }];
  const short = items.filter((i) => i.body.trim().length < 80).length;
  out.push({ name: "no empty items", pass: short === 0, detail: short ? `${short} under 80 chars` : undefined });
  out.push({ name: "no dev mock", pass: !all.includes("[DEV MOCK]") && !all.includes("placeholder content") });

  const ar = (all.match(AR) ?? []).length, lat = (all.match(LAT) ?? []).length, ratio = ar / Math.max(1, ar + lat);
  const langs = brand.languages.join("+");
  const langOk = langs === "ar" ? ratio >= 0.6 : langs === "en" ? ratio <= 0.05 : ratio >= 0.2 && ratio <= 0.85;
  out.push({ name: `language ${langs}`, pass: langOk, detail: `arabic ${Math.round(ratio * 100)}%` });

  // Internal documents may quote banned words to warn against them; only customer-facing copy is checked.
  if (CUSTOMER_FACING.includes(c.type)) {
    // A compliance note may quote a banned word ("no words like \"مضمون\""); quoted text does not count. The match
    // itself is the production gate's (src/lib/brand-rules.ts), so the evals and the approve button agree on a banned-word
    // hit. The gate's placeholder rule is not scored here: an honest [رقم] for an unknown fact is what the golden set asks
    // for, and the owner fills it in before approving.
    const unquoted = all.replace(/"[^"\n]{1,40}"|«[^»\n]{1,40}»|“[^”\n]{1,40}”/g, " ");
    const hit = checkText(brandRules(brand), unquoted).map((v) => v.term);
    out.push({ name: "banned words absent", pass: hit.length === 0, detail: hit.join("، ") || undefined });
  }

  if (c.noPrices) {
    // Compare whole NUMBERS. `known` used to be the brand text itself and the test was `known.includes(n)` — a substring
    // search — so an invented price of 25 passed whenever "2025", "250" or a phone number appeared anywhere in the
    // brand file. The check meant to catch fabricated prices passed almost every one of them.
    const known = new Set([...digits(`${brand.products} ${brand.offers} ${c.extra ?? ""} ${c.stats ?? ""}`).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])));
    const found = [...digits(all).matchAll(/(\d+(?:\.\d+)?)\s*(?:ريال|ر\.س|درهم|SAR|AED|SR)|(?:SAR|AED|SR)\s*(\d+(?:\.\d+)?)/gi)].map((m) => m[1] ?? m[2]);
    const invented = [...new Set(found.filter((n) => !known.has(Number(n))))];
    out.push({ name: "no invented prices", pass: invented.length === 0, detail: invented.join(", ") || undefined });
  }
  if (c.maxChars) {
    const over = items.filter((i) => i.body.length > c.maxChars!).length;
    out.push({ name: `≤ ${c.maxChars} chars`, pass: over === 0, detail: over ? `${over} over` : undefined });
  }
  for (const m of c.must ?? []) out.push({ name: m.name, pass: new RegExp(m.re, m.flags).test(all) });
  return out;
}

const trim = (i: Generated) => ({ ...i, body: i.body.length > 3000 ? `${i.body.slice(0, 3000)}\n… [+${i.body.length - 3000} chars]` : i.body });

async function runCase(c: GoldenCase): Promise<GoldenResult> {
  const t0 = Date.now();
  const brand = GOLDEN_BRANDS[c.brand];
  const head = { id: c.id, agent: agentForTask(c.type).id, type: c.type, brand: brand.name, delta: null, pb: promptStamp(c.type, brand) };
  let items: Generated[] = [];
  let stage = "generate";
  try {
    items = await generate(c.type, brand, [], c.extra, { meter: GOLDEN_EMAIL, stats: c.stats, count: c.count });
    stage = "judge";
    const verdicts = await scoreItems(GOLDEN_EMAIL, brand, c.type, items, c.count, { notes: c.extra, stats: c.stats });
    // An unjudged item is left out of the mean rather than counted as 0, and the gap is written into the notes so a
    // run where the judge answered for half the items does not read as a clean score.
    const q = verdicts.filter((x): x is Quality => !!x);
    const missing = verdicts.length - q.length;
    const dims = q.length ? (Object.fromEntries((Object.keys(q[0].dims) as (keyof Quality["dims"])[]).map((k) => [k, Math.round(mean(q.map((x) => x.dims[k])) ?? 0)])) as Quality["dims"]) : null;
    const notes = [...(missing ? [`judge returned no verdict for ${missing} of ${verdicts.length} item(s)`] : []), ...q.map((x) => x.notes).filter(Boolean)];
    return { ...head, ok: true, score: mean(q.map((x) => x.score)), dims, notes, checks: hardChecks(c, brand, items), items: items.map(trim), ms: Date.now() - t0 };
  } catch (e) {
    // Keep the output and the deterministic checks when only the judge failed.
    return { ...head, ok: false, error: `${stage}: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`, score: null, dims: null, notes: [], checks: items.length ? hardChecks(c, brand, items) : [], items: items.map(trim), ms: Date.now() - t0 };
  }
}

export async function listGoldenRuns(limit = 12): Promise<GoldenRun[]> {
  const ids = await db.lrange("golden:runs", 0, limit - 1);
  const runs = await Promise.all(ids.map((id) => db.get<GoldenRun>(`golden:run:${id}`)));
  return runs.filter((r): r is GoldenRun => !!r);
}

/**
 * Whether the prompts behind an agent's cases changed since the previous run: for each case measured in this run, its
 * stamp (`pb`: the playbook, review.md, the code prompts of its type and its brand's industry playbook) against the stamp
 * of the same case in the previous run. Row by row, never the runs' `playbooks`: a run's rows are not all made with the
 * prompts it started with. A single-agent rerun carries the other agents' rows forward from an older run, so the
 * previous run can hold rows made with older prompts than its own; a resumed run keeps the rows its first attempt
 * measured. Each row's stamp moved with it, so the comparison is exact. Only rows measured in this run count (a carried
 * row was not). null when there is nothing to compare: no measured row has a stamped row in the previous run (runs
 * before 2026-09-29), or every row of the agent was carried.
 */
function promptChangeOf(mine: GoldenResult[], prev: GoldenRun | undefined): boolean | null {
  const was = new Map((prev?.results ?? []).flatMap((r) => (r.pb ? [[r.id, r.pb] as const] : [])));
  const pairs = mine.flatMap((r) => (!r.carried && r.pb && was.has(r.id) ? [[r.pb, was.get(r.id)!] as const] : []));
  if (!pairs.length) return null;
  // The industry part is left out of a brand-less stamp, so it is compared only when both rows have one.
  return pairs.some(([now, then]) => now.skills !== then.skills || now.review !== then.review || now.code !== then.code || (!!now.industry && !!then.industry && now.industry !== then.industry));
}

/** Exported for tests: it decides what counts as a regression, and that decision is what the founder is alerted on. */
export function summarize(run: GoldenRun, prev: GoldenRun | undefined) {
  const before = new Map((prev?.results ?? []).filter((r) => r.score !== null).map((r) => [r.id, r.score!]));
  // A carried row was not measured in this run, so it has no delta: comparing it with the run it was copied from gave 0.
  for (const r of run.results) r.delta = !r.carried && r.score !== null && before.has(r.id) ? Math.round((r.score - before.get(r.id)!) * 10) / 10 : null;
  const compared = new Map<AgentId, number>();
  run.overall = mean(run.results.filter((r) => r.score !== null).map((r) => r.score!));
  run.agents = AGENTS.map((a) => {
    const mine = run.results.filter((r) => r.agent === a.id);
    const score = mean(mine.filter((r) => r.score !== null).map((r) => r.score!));
    // Agent delta compares the same cases only, so a partial run does not fake a drop.
    const both = mine.filter((r) => !r.carried && r.score !== null && before.has(r.id));
    compared.set(a.id, both.length);
    const delta = both.length ? Math.round(((mean(both.map((r) => r.score!)) ?? 0) - (mean(both.map((r) => before.get(r.id)!)) ?? 0)) * 10) / 10 : null;
    return { agent: a.id, cases: mine.length, score, delta, checksRun: mine.reduce((s, r) => s + r.checks.length, 0), failedChecks: mine.reduce((s, r) => s + r.checks.filter((c) => !c.pass).length, 0), promptChanged: promptChangeOf(mine, prev) };
  }).filter((a) => a.cases > 0);
  // A drop that came with a prompt change says so, so the founder looks at the prompt first. Carried rows are not tagged.
  const changed = new Set(run.agents.filter((a) => a.promptChanged === true).map((a) => a.agent));
  const tag = (agent: AgentId, carried?: string) => (!carried && changed.has(agent) ? " (prompt changed)" : "");
  const reg: string[] = [];
  // An agent-level regression needs at least two compared cases. With one, the agent delta IS that case's delta, and
  // the per-case rule below already judges it at CASE_DROP. Using the lower AGENT_DROP bar for it turned a single case
  // moving 6-9 points — which the case rule deliberately ignores — into a founder alert naming the whole agent.
  for (const a of run.agents) if (a.delta !== null && (compared.get(a.agent) ?? 0) >= 2 && a.delta <= -AGENT_DROP) reg.push(`${a.agent}: ${a.delta} vs previous run${tag(a.agent)}`);
  for (const r of run.results) {
    const t = tag(r.agent, r.carried);
    if (!r.ok) reg.push(`${r.id}: error ${r.error}${t}`);
    else if (r.score !== null && r.score < LOW) reg.push(`${r.id}: score ${r.score}${t}`);
    else if (r.delta !== null && r.delta <= -CASE_DROP) reg.push(`${r.id}: ${r.delta} vs previous run${t}`);
    for (const c of r.checks) if (!c.pass) reg.push(`${r.id}: check "${c.name}" failed${c.detail ? ` (${c.detail})` : ""}${t}`);
  }
  run.regressions = reg;
}

/**
 * Run the set. `agent` reruns one agent's cases and carries the rest over from the latest run; `resume` reruns only the
 * cases that errored or never started in the latest run and merges them in.
 * Returns null when another run holds the lock, no model key is set or Claude is paused (src/lib/model.ts).
 */
export async function runGolden(trigger: "cron" | "manual", opts: { agent?: AgentId; resume?: boolean } = {}): Promise<GoldenRun | null> {
  if (modelState() !== "on") return null;
  if (!(await db.lock("golden:lock", 300))) return null;
  try {
    const t0 = Date.now();
    // The prompt versions this run starts with, kept on the run for the console (`summarize` compares each case's stamp).
    const playbooks = promptHashes(GOLDEN_CASES.map((c) => c.type));
    const history = await listGoldenRuns(6);
    const last = history[0];
    const resuming = !!(opts.resume && last && last.version === GOLDEN_VERSION && last.status === "partial");
    // Single-agent run: carry the other agents' results over from the latest run so the panel stays complete.
    const carried = !resuming && opts.agent && last && last.version === GOLDEN_VERSION ? last.results.filter((r) => r.agent !== opts.agent).map((r) => ({ ...r, carried: r.carried ?? last.startedAt })) : [];
    const done = resuming ? last.results.filter((r) => r.ok) : carried;
    const queue = GOLDEN_CASES.filter((c) => (!opts.agent || agentForTask(c.type).id === opts.agent) && !done.some((r) => r.id === c.id));
    const usdBefore = (await getUsage(GOLDEN_EMAIL)).usd;

    const results: GoldenResult[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        const c = queue[next++];
        if (Date.now() - t0 > START_BUDGET_MS) {
          results.push({ id: c.id, agent: agentForTask(c.type).id, type: c.type, brand: GOLDEN_BRANDS[c.brand].name, ok: false, error: "skipped_time_budget", score: null, dims: null, notes: [], checks: [], items: [], ms: 0, delta: null, pb: promptStamp(c.type, GOLDEN_BRANDS[c.brand]) });
          continue;
        }
        results.push(await runCase(c));
      }
    }));

    const order = new Map(GOLDEN_CASES.map((c, i) => [c.id, i]));
    const merged = [...done, ...results].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const run: GoldenRun = {
      id: resuming ? last.id : `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`,
      version: GOLDEN_VERSION, trigger: resuming ? last.trigger : trigger, startedAt: resuming ? last.startedAt : new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
      status: merged.every((r) => r.ok) && merged.length === GOLDEN_CASES.length ? "complete" : "partial", overall: null,
      usd: Math.round(((resuming ? last.usd : 0) + (await getUsage(GOLDEN_EMAIL)).usd - usdBefore) * 100) / 100,
      // A resumed run started with its first attempt's prompts; today's may differ (a deploy in between).
      agents: [], results: merged, regressions: [], playbooks: resuming ? last.playbooks : playbooks,
    };
    // Compare with the latest earlier run of the same version.
    summarize(run, history.find((h) => h.id !== run.id && h.version === GOLDEN_VERSION));
    await db.set(`golden:run:${run.id}`, run);
    if (!resuming) await db.lpush("golden:runs", run.id);

    if (run.regressions.length) {
      const title = `المجموعة الذهبية: ${run.regressions.length} تنبيه، المتوسط ${run.overall ?? "—"}`;
      for (const e of adminEmails()) await notifyItem(e, "ar", { kind: "quality", agent: "dana", title, body: run.regressions.slice(0, 3).join(" · "), href: "/ar/app/admin" }, `golden:${run.id}:${run.regressions.length}`, 7);
    }
    return run;
  } finally {
    await db.unlock("golden:lock");
  }
}
