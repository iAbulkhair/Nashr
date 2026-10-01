/**
 * Compare TypeSafe Jev (src/lib/jev.ts) with the Sonnet quality judge (src/lib/judge.ts) on the golden set.
 * Evaluation only: nothing in the app changes. Only golden runs are read, so only fictional brands (GOLDEN_BRANDS)
 * and the items generated for them are sent to TypeSafe. Customer content is never read.
 *
 *   npm run jev:compare -- [--env .env.local] [--runs 1] [--run <id>] [--limit <cases>] [--rejudge] [--out <file>]
 *
 * Stored mode (default) spends nothing on Claude: Jev scores the items of the latest stored golden run(s) and is
 * compared with the verdicts saved in them. Those keep a per-case average and each item's note, which carries the
 * `[code]` of an automatic fail, so the automatic fail compares per item and the scores per case. Stored bodies were
 * cut at 3000 chars, which Sonnet had read in full; for trimmed cases completeness, format and the overall score are
 * left out, and a missed automatic fail on a trimmed item is listed but not counted.
 *
 * --rejudge also re-runs the Sonnet judge on the same stored items, so both judges read the same text and every
 * comparison is per item. It calls Claude, so it refuses while Claude is paused (src/lib/model.ts), and its calls are
 * metered to golden@nashr.internal like the weekly run.
 *
 * Needs TYPESAFE_API_KEY and the Redis variables (docs/system/variables.md), from the environment or the --env file.
 * No value is ever printed. Writes a JSON report (no item bodies) to --out or the system temp folder.
 * Exit code: 0 PASS, 2 FAIL or INCONCLUSIVE, 1 error.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemRow, CaseRow, Report, LangReport, Agreement, Dims } from "../src/lib/jev-compare";
import type { Quality } from "../src/lib/judge";

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg: string): never => { console.error(`jev-compare: ${msg}`); process.exit(1); };

const mean1 = (xs: number[]) => Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10;
const avg = (qs: Quality[]): { score: number; dims: Dims } | null => qs.length ? {
  score: mean1(qs.map((q) => q.score)),
  dims: Object.fromEntries((Object.keys(qs[0].dims) as (keyof Dims)[]).map((k) => [k, Math.round(mean1(qs.map((q) => q.dims[k])))])) as Dims,
} : null;
const pct = (a: Agreement | null) => (a && a.rate !== null ? `${Math.round(a.rate * 100)}% /${a.n}` : "—");
const quantile = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);

async function main() {
  const envFile = opt("env") ?? ".env.local";
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  else if (opt("env")) die(`env file not found: ${envFile}`);
  if (!process.env.TYPESAFE_API_KEY) die("TYPESAFE_API_KEY is not set (environment or --env file)");
  const rejudge = has("rejudge");
  const runsWanted = Math.max(1, Number(opt("runs") ?? 1) || 1);
  const limit = Number(opt("limit") ?? 0) || Infinity;

  // Imported after the env is loaded: db.ts picks Redis or the memory store when it is first imported.
  const { db, usingPersistentStore } = await import("../src/lib/db");
  const { GOLDEN_BRANDS, GOLDEN_CASES, GOLDEN_EMAIL, GOLDEN_VERSION, listGoldenRuns } = await import("../src/lib/golden");
  const { scoreItems } = await import("../src/lib/judge");
  const { modelState } = await import("../src/lib/model");
  const { getUsage } = await import("../src/lib/usage");
  const { pmap } = await import("../src/lib/parallel");
  const { jevScoreItems, JEV_USD_PER_INPUT_TOKEN } = await import("../src/lib/jev");
  const { brandLang, compare, storedAutofails } = await import("../src/lib/jev-compare");
  type GoldenRun = Awaited<ReturnType<typeof listGoldenRuns>>[number];

  if (!usingPersistentStore) die("no Redis credentials: golden runs are stored in Redis (KV_REST_API_URL / KV_REST_API_TOKEN)");
  if (rejudge && modelState() !== "on") die(`--rejudge calls the Sonnet judge, and Claude is ${modelState()} (src/lib/model.ts). Run without --rejudge, or turn Claude on first.`);

  let runs: GoldenRun[];
  const runId = opt("run");
  if (runId) {
    const r = await db.get<GoldenRun>(`golden:run:${runId}`);
    runs = r ? [r] : die(`golden run not found: ${runId}`);
  } else {
    const history = await listGoldenRuns(12);
    if (!history.length) die("no golden runs stored yet");
    runs = history.filter((r) => r.version === history[0].version).slice(0, runsWanted);
  }
  for (const r of runs) if (r.version !== GOLDEN_VERSION) console.warn(`note: run ${r.id} is golden v${r.version}, the code is v${GOLDEN_VERSION}${r.version < 5 ? " (no automatic-fail triggers before v5: that comparison is skipped)" : ""}`);

  const caseById = new Map(GOLDEN_CASES.map((c) => [c.id, c]));
  const work = runs.flatMap((run) => run.results.filter((r) => r.ok && r.items.length && caseById.has(r.id)).slice(0, limit).map((r) => ({ run, r })));
  if (!work.length) die("the selected runs have no judged cases");
  const judgeBefore = rejudge ? (await getUsage(GOLDEN_EMAIL)).byKind.judge : undefined;

  const items: ItemRow[] = [], cases: CaseRow[] = [], errors: string[] = [], jevMs: number[] = [];
  let jevTokens = 0;
  const t0 = Date.now();
  await pmap(work, async ({ run, r }) => {
    const c = caseById.get(r.id)!;
    const brand = GOLDEN_BRANDS[c.brand];
    const lang = brandLang(brand);
    const ctx = { notes: c.extra, stats: c.stats };
    const trimmed = r.items.map((i) => /\n… \[\+\d+ chars\]$/.test(i.body));
    try {
      const [jev, sonnet] = await Promise.all([
        jevScoreItems(brand, c.type, r.items, c.count, ctx, { concurrency: 3 }),
        rejudge ? scoreItems(GOLDEN_EMAIL, brand, c.type, r.items, c.count, ctx) : Promise.resolve(null),
      ]);
      const stored = storedAutofails(r.notes, r.items.length, run.version);
      r.items.forEach((_, i) => {
        jevTokens += jev[i].usage.input_tokens;
        jevMs.push(jev[i].ms);
        items.push({
          runId: run.id, caseId: r.id, lang, index: i, trimmed: trimmed[i],
          jev: jev[i].quality, jevAutofailConfidence: jev[i].autofailConfidence,
          sonnet: sonnet?.[i] ?? null,
          sonnetAutofail: sonnet ? (sonnet[i] ? sonnet[i]!.autofail ?? null : undefined) : stored ? stored[i] : undefined,
        });
      });
      const jq = jev.map((v) => v.quality).filter((q): q is Quality => !!q);
      cases.push({
        runId: run.id, caseId: r.id, lang, partial: !rejudge && trimmed.some(Boolean),
        sonnet: sonnet ? avg(sonnet.filter((q): q is Quality => !!q)) : r.score !== null && r.dims ? { score: r.score, dims: r.dims } : null,
        jev: avg(jq),
      });
      process.stdout.write(".");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      errors.push(`${run.id}/${r.id}: ${m}`);
      process.stdout.write("x");
      if (m === "jev_http_401") die("TypeSafe rejected the API key (401)");
    }
  }, 3);
  process.stdout.write("\n\n");

  const report = compare(items, cases, rejudge ? "rejudge" : "stored");
  const judgeAfter = (await getUsage(GOLDEN_EMAIL)).byKind.judge;
  const jevUsd = jevTokens * JEV_USD_PER_INPUT_TOKEN;
  const itemsPerCase = items.length / Math.max(1, cases.length);
  const sonnet = rejudge
    ? { calls: (judgeAfter?.calls ?? 0) - (judgeBefore?.calls ?? 0), usd: (judgeAfter?.usd ?? 0) - (judgeBefore?.usd ?? 0), basis: "measured in this run" }
    : { calls: judgeAfter?.calls ?? 0, usd: judgeAfter?.usd ?? 0, basis: "golden set's judge calls this month" };
  const sonnetPerItem = sonnet.calls ? sonnet.usd / sonnet.calls / itemsPerCase : null;
  const jevPerItem = jevUsd / Math.max(1, items.length);

  print(report, runs, items, cases, errors);
  console.log(`\nCost and speed`);
  console.log(`  Jev     $${jevUsd.toFixed(5)} for ${items.length} items, $${jevPerItem.toFixed(6)} per item (input list price only); median ${quantile(jevMs, 0.5)} ms, p95 ${quantile(jevMs, 0.95)} ms per item`);
  console.log(`  Sonnet  ${sonnetPerItem === null ? "no judge calls to average" : `≈ $${sonnetPerItem.toFixed(5)} per item (${sonnet.basis}: ${sonnet.calls} calls, $${sonnet.usd.toFixed(4)})`}`);
  if (sonnetPerItem) console.log(`  Ratio   Jev costs ${((jevPerItem / sonnetPerItem) * 100).toFixed(2)}% of Sonnet per item`);
  console.log(`  Wall    ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const out = opt("out") ?? join(tmpdir(), `jev-compare-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), runs: runs.map((r) => ({ id: r.id, version: r.version, startedAt: r.startedAt })), report, items, cases, errors, cost: { jevUsd, jevInputTokens: jevTokens, sonnet } }, null, 2));
  console.log(`\nReport: ${out}`);
  process.exit(report.verdict === "PASS" ? 0 : 2);
}

function print(report: Report, runs: { id: string; version: number }[], items: ItemRow[], cases: CaseRow[], errors: string[]) {
  const langs = Object.keys(report.byLang) as (keyof Report["byLang"])[];
  const cols: [string, LangReport][] = [["all", report.all], ...langs.map((l) => [l!, report.byLang[l]!] as [string, LangReport])];
  const row = (label: string, f: (r: LangReport) => string) => console.log(`  ${label.padEnd(26)}${cols.map(([, r]) => f(r).padStart(12)).join("")}`);
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

  console.log(`Jev vs Sonnet judge: ${report.mode} mode, run${runs.length > 1 ? "s" : ""} ${runs.map((r) => `${r.id} (v${r.version})`).join(", ")}`);
  console.log(`Items ${items.length}, Jev unjudged ${items.filter((i) => !i.jev).length}, cases ${cases.length}${cases.some((c) => c.partial) ? `, ${cases.filter((c) => c.partial).length} with trimmed bodies` : ""}, errors ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  error ${e}`);
  console.log("");
  console.log(`  ${"".padEnd(26)}${cols.map(([l]) => l.padStart(12)).join("")}`);
  row("items", (r) => String(r.items));
  row("auto-fail yes/no agree", (r) => pct(r.autofailFlag));
  row("auto-fail same code", (r) => pct(r.autofailExact));
  if (report.mode === "rejudge") {
    row("item band agree", (r) => pct(r.itemBand));
    row("item honesty band agree", (r) => pct(r.itemHonestyBand));
    for (const k of ["score", "completeness", "brand", "honesty", "language", "format"]) row(`item |diff| ${k}`, (r) => num(r.itemMae?.[k]));
  }
  row("case band agree", (r) => pct(r.caseBand));
  row("case honesty band agree", (r) => pct(r.caseHonestyBand));
  for (const k of ["score", "completeness", "brand", "honesty", "language", "format"]) row(`case |diff| ${k}`, (r) => num(r.caseMae[k]));

  const list = (title: string, ms: Report["missed"]) => {
    if (!ms.length) return;
    console.log(`\n${title}`);
    for (const m of ms) console.log(`  ${m.caseId} #${m.index + 1}: Sonnet ${m.sonnet ?? "none"}, Jev ${m.jev ?? "none"}${m.trimmed ? " (trimmed item)" : ""}${runs.length > 1 ? `  [${m.runId}]` : ""}`);
  };
  list("Missed automatic fails (Sonnet flagged, Jev passed):", report.missed);
  list("Extra automatic fails (Jev flagged, Sonnet passed):", report.extra);

  console.log(`\nGates`);
  for (const g of report.gates) console.log(`  [${g.pass === true ? "PASS" : g.pass === false ? "FAIL" : " -- "}] ${g.name}: ${g.detail}`);
  console.log(`\nVerdict: ${report.verdict}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
