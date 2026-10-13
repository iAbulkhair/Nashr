import { NextResponse } from "next/server";
import { adminActor, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { agentForTask, isAgentId } from "@/lib/agents";
import { NO_LAYERS, type Layers } from "@/lib/agent-instructions";
import { diffSets, summarizeRevision } from "@/lib/instructions-diff";
import { publicLayer, publicRevision, refused } from "@/lib/instructions-http";
import { TEST_BRIEF_CHARS } from "@/lib/instructions-safety";
import { PLATFORM, activate, discardDraft, editBase, getLayer, listFeed, listHistory, restore, saveDraft, setPaused, isPaused, type Draft, type InstructionSet } from "@/lib/instructions-store";
import { testQuote } from "@/lib/instructions-test";
import { ADMIN_SKILL_TEST_BUCKET, ADMIN_TEST_LABEL, consoleState, founderBy, logSkills, snap } from "@/lib/skills-admin";
import { ModelPaused, modelState } from "@/lib/model";
import { generate } from "@/lib/noor";
import { allow, ADMIN_SKILL_TESTS_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";
import { SAMPLE_BRAND } from "@/lib/sample-brand";
import { isDraftType } from "@/lib/tasks";
import { deadlineFor } from "@/lib/media/keys";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * The founder's agent skills console (agent skills portal, spec 8.2 and 10; rules 958-959). Every method authenticates
 * first with one `adminActor(req)` call (the console key session or a founder signed in as themselves; 401 otherwise, so a customer
 * session never reaches it). The layer written here is always `PLATFORM`, a constant: no scope, email or key comes from the
 * body. Who wrote it comes from the session (`adminActor`), and every write pushes `admin:log`.
 *
 * GET -> `{ ok, layer, base, chars, history, feed, paused }`: the platform layer (live set and draft), its edit counter
 * (`base`, the same `editBase` the customer page sends), the newest versions as counts, the founder feed of workspace
 * changes and the pause switch.
 * GET `?compare=<revisionId>` -> `{ ok, diff }`: that version against the live set, the id matched against the platform's own history.
 * GET `?workspace=<scope>` -> `{ ok, workspace, layer }`: that workspace's LIVE set, read only (no draft, no `by.imp`), only
 * when the scope string is one the server's own feed holds; anything else is 404. The key is built from the feed row's scope,
 * never from the query.
 *
 * PUT `{ items, base }` -> `{ ok, layer }`: save the platform draft (targets: the eight agents, `media`, `reviewer`, `judge`; the
 * `lock` flag; 2000 characters). `base` is required: the layer's edit counter as the page was loaded (400 `bad_base` without it); a different one is 409 `stale`.
 *
 * POST `{ action }` -> `activate | discard | restore { revisionId } | pause { on: boolean } | test { agent, type, brief? }`. `test` is
 * "Test this instruction" on the built-in sample brand: the same two `generate` calls as the customer's test (live set and
 * draft), but it takes no credits, is metered under `ADMIN_TEST_LABEL`, and is limited to `ADMIN_SKILL_TESTS_PER_HOUR` an hour on
 * one bucket for the whole console.
 */
export async function GET(req: Request) {
  // One check per request (`adminActor` throttles header-key guesses, so asking twice would count each guess twice).
  if ((await adminActor(req)) === null) return NextResponse.json({ ok: false }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const ws = q.get("workspace");
  if (ws !== null) {
    // Only a workspace the founder's feed names. The scope used below is the feed row's own string.
    const row = (await listFeed()).find((r) => r.scope === ws);
    if (!row) return bad("not_found", 404);
    const layer = await getLayer(row.scope);
    return NextResponse.json({ ok: true, workspace: row.scope, layer: { ...publicLayer(layer), draft: null } });
  }
  const compare = q.get("compare");
  if (compare !== null) {
    const rev = (await listHistory(PLATFORM)).find((r) => r.id === compare);
    if (!rev) return bad("not_found", 404);
    return NextResponse.json({ ok: true, diff: diffSets(rev.after, (await getLayer(PLATFORM)).active) });
  }
  return NextResponse.json({ ok: true, ...(await consoleState()) });
}

export async function PUT(req: Request) {
  const who = await adminActor(req);
  if (who === null) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => null)) as { items?: unknown; base?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.items)) return bad("bad_items");
  // The console page always has the edit counter it loaded, and there is no older page for this route, so a save without one is refused instead of skipping the stale check.
  if (!(typeof b.base === "number" && Number.isInteger(b.base) && b.base >= 0)) return bad("bad_base");
  const before = snap(await getLayer(PLATFORM));
  const r = await saveDraft(PLATFORM, b.items as Draft[], founderBy(who), { platform: true, base: b.base });
  if (!r.ok) return refused(r);
  await logSkills(who, "save", before, snap(r.layer), viaOf(req));
  return NextResponse.json({ ok: true, layer: publicLayer(r.layer), base: editBase(r.layer) });
}

export async function POST(req: Request) {
  const who = await adminActor(req);
  if (who === null) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("bad_body");
  const by = founderBy(who);
  switch (b.action) {
    case "activate": {
      const before = snap(await getLayer(PLATFORM));
      const r = await activate(PLATFORM, by, { platform: true });
      if (!r.ok) return refused(r);
      await logSkills(who, "activate", before, snap(r.layer), viaOf(req));
      return NextResponse.json({ ok: true, layer: publicLayer(r.layer), base: editBase(r.layer), revision: summarizeRevision(publicRevision(r.revision)) });
    }
    case "discard": {
      const before = snap(await getLayer(PLATFORM));
      const r = await discardDraft(PLATFORM, by);
      if (!r.ok) return refused(r);
      await logSkills(who, "discard", before, snap(r.layer), viaOf(req));
      return NextResponse.json({ ok: true, layer: publicLayer(r.layer), base: editBase(r.layer) });
    }
    case "restore": {
      const before = snap(await getLayer(PLATFORM));
      const r = await restore(PLATFORM, typeof b.revisionId === "string" ? b.revisionId : "", by, { platform: true });
      if (!r.ok) return refused(r);
      await logSkills(who, "restore", before, snap(r.layer), viaOf(req));
      return NextResponse.json({ ok: true, layer: publicLayer(r.layer), base: editBase(r.layer), revision: summarizeRevision(publicRevision(r.revision)) });
    }
    case "pause": {
      if (typeof b.on !== "boolean") return bad("bad_request");
      const was = await isPaused();
      await setPaused(b.on);
      await logSkills(who, "pause", { paused: was }, { paused: b.on }, viaOf(req));
      return NextResponse.json({ ok: true, paused: b.on });
    }
    case "test":
      return runTest(b, who, viaOf(req));
    default:
      return bad("unknown_action");
  }
}

/**
 * The admin test. Order: the body (agent and type as the
 * customer's test checks them, a brief of at most 500 characters), a draft to test, a model that is not paused and can write
 * the type (all cheap, no model call), then the console's hourly allowance (one bucket, a server constant). Then two
 * `generate` calls together on the sample brand, one with the live platform set and one with the draft, the reviewer on,
 * cross-review off, no inbox, no learning, metered under `ADMIN_TEST_LABEL`. No credit is taken from anyone: nothing here
 * imports `charge`. A throw answers 502 with a fixed code; the model's own message is logged by name only.
 */
async function runTest(b: Record<string, unknown>, who: string, via: ReturnType<typeof viaOf>) {
  // Taken first: the generations end by it.
  const deadline = deadlineFor(maxDuration);
  const { agent, type } = b;
  if (!isAgentId(agent) || agent === "reem" || !isDraftType(type) || agentForTask(type).id !== agent) return bad("bad_type");
  const brief = b.brief === undefined || b.brief === null ? "" : b.brief;
  if (typeof brief !== "string") return bad("bad_body");
  if (brief.length > TEST_BRIEF_CHARS) return bad("brief_too_long");
  const layer = await getLayer(PLATFORM);
  if (layer.draft === null) return bad("no_draft");
  if (modelState() === "paused") return bad("model_paused", 503);
  const quote = testQuote({}, SAMPLE_BRAND, type);
  if (!quote.available) return bad("model_unavailable", 503);
  // A request that would be refused anyway (above) takes no slot; the hourly allowance is spent only when the generations start.
  if (!(await allow(ADMIN_SKILL_TEST_BUCKET, ADMIN_SKILL_TESTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  // The platform alone: the sample brand has no workspace, and the pause switch is irrelevant to it.
  const layersOf = (platform: InstructionSet): Layers => ({ ...NO_LAYERS, platform });
  const one = (platform: InstructionSet) =>
    generate(type, SAMPLE_BRAND, [], brief.trim() || undefined, { meter: ADMIN_TEST_LABEL, crossReview: false, model: quote.model, layers: layersOf(platform), count: 1, deadline });
  try {
    const [before, after] = await Promise.all([one(layer.active), one(layer.draft)]);
    if (!before[0] || !after[0]) throw new Error("empty_generation");
    await logSkills(who, "test", { v: layer.active.v }, { agent, type }, via);
    return NextResponse.json({ ok: true, before: before[0], after: after[0], spent: 0, sample: SAMPLE_BRAND.name });
  } catch (error) {
    console.error("admin skills test failed", error instanceof Error ? error.name : "error");
    return error instanceof ModelPaused ? bad("model_paused", 503) : bad("generation_failed", 502);
  }
}
