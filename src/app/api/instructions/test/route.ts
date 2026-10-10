import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { agentForTask, isAgentId } from "@/lib/agents";
import { loadLayers } from "@/lib/agent-instructions";
import { getBrand, listPreferencesFor } from "@/lib/brand";
import { byOf } from "@/lib/actor";
import { recordActivity, type Activity } from "@/lib/activity";
import { charge, refund, renewIfDue, renewalDue } from "@/lib/credits";
import { db } from "@/lib/db";
import { entitlements } from "@/lib/entitlements";
import { memoryBlock } from "@/lib/files";
import { feedbackFor } from "@/lib/feedback";
import { countCost } from "@/lib/generate-batch";
import { getLayer } from "@/lib/instructions-store";
import { getGov } from "@/lib/governance";
import { ModelPaused, modelState } from "@/lib/model";
import { modelAllowsTask, modelById } from "@/lib/models/catalog";
import { creditsFor } from "@/lib/models/credits";
import { generateRouteFor } from "@/lib/models/overrides";
import { generate } from "@/lib/noor";
import { statsFor } from "@/lib/stats";
import { noteRejectedPick } from "@/lib/usage";
import { warnAgentCap } from "@/lib/notifications";
import { allow, INSTRUCTION_TESTS_PER_DAY, INSTRUCTION_TESTS_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { isDraftType } from "@/lib/tasks";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 300;

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
/** What the owner may add to the test as a note for the agent: it is the owner-notes argument of `generate` (in the user message, after the task spec), never system text. */
const BRIEF_CHARS = 500;
/** How long a click's nonce stays claimed: a replay inside it is a duplicate (spec 11). */
const CLAIM_SECONDS = 600;

/**
 * "Test this instruction" (agent skills portal, spec 11; rule 952). POST `{ agent, type, brief, confirm: true, nonce }` ->
 * `{ ok, before, after, spent }`: one item of `type` written twice, once with the workspace's live instructions and once with
 * its draft, so the owner reads the difference. It is the only route of the portal that spends credits, and it spends
 * only on this click.
 *
 * The order is the contract. Authenticate (401), `instructions.test` (403, admin and owner), the workspace's hourly and
 * daily allowance (429 + Retry-After; the key is `sc(u)`, so a refused role is not counted), then the body: `confirm`
 * must be the literal `true` (400 `confirm_required`: the page sends it only after its dialog), `agent`/`type` (400
 * `bad_type`: a type the agent does not own, Reem, or a type chat's `draft_items` cannot draft), `brief` at most 500
 * characters, `nonce` (400 `bad_nonce`), a draft to test (400 `no_draft`). Then the model and the price are resolved
 * as `generateBatch` resolves them (a paused model is 503 before anything is claimed), the nonce is claimed
 * (`setNx` `skilltest:{sc(u)}:{nonce}`, 600 s; a second request with it is 409 `duplicate`, in sequence or at the same
 * instant) and only then credits are taken: two items' worth, once, with the owner's monthly cap for the agent.
 * Not `chargeOnce`, whose holds stay on the user record for 8 days.
 *
 * Insufficient credits or the cap is 402 (`no_credits` / `agent_cap`); no model call happened, so the claim is released
 * and the same click can be sent again after a top-up. Every other end keeps the claim, a failed and refunded test
 * too: a retry is a new click with a new nonce from the page. Any throw after the charge gives back exactly what was
 * taken (the receipt, which also lowers the agent's counter) and answers 502 `generation_failed` (503 `model_paused`
 * for a paused model); the model's own error text is logged by name only and never sent.
 *
 * The two generations run together with the same model, `count: 1`, the account's metering, the reviewer as the
 * governance sets it, no cross-review, and no judge, inbox row, learning or feedback is written. The brief is only ever the
 * owner's-notes argument of `generate` (the user message, as an owner's note), never system text. The spend is one row of the
 * owner's activity log (`instructions_tested`, `credits` = what was taken), and a refusal at the charge is a batch's own
 * `cap_reached` / `no_credits` row, as `generateBatch` writes them; a refunded failure leaves no row, as there. The workspace is `sc(u)`: no scope, email or brand
 * id in the body is read.
 */
export async function POST(req: Request) {
  // Taken first: the generations end by it (generate() throws, and the refund below runs, before the platform's kill).
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.test");
  if (no) return no;
  const scope = sc(u);
  // Both allowances are per workspace and counted per attempt (a refused body counts too: it is a click). Hour first, so
  // a caller the hour refused does not use up the day.
  if (!(await allow(`instr:t:h:${scope}`, INSTRUCTION_TESTS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  if (!(await allow(`instr:t:d:${scope}`, INSTRUCTION_TESTS_PER_DAY, WINDOW.day))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.day);

  const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("bad_body");
  if (b.confirm !== true) return bad("confirm_required");
  const { agent, type } = b;
  // The type's owner is computed in code from the type; the body's agent must agree with it. Reem has no task types.
  if (!isAgentId(agent) || agent === "reem" || !isDraftType(type) || agentForTask(type).id !== agent) return bad("bad_type");
  const brief = b.brief === undefined || b.brief === null ? "" : b.brief;
  if (typeof brief !== "string") return bad("bad_body");
  if (brief.length > BRIEF_CHARS) return bad("brief_too_long");
  const nonce = b.nonce;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return bad("bad_nonce");

  const layer = await getLayer(scope);
  if (layer.draft === null) return bad("no_draft");

  // Before the claim and the charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return bad("model_paused", 503);
  const [brand, gov] = await Promise.all([getBrand(scope), getGov(scope)]);
  if (!brand) return bad("no_brand");
  if (trialOver(u)) return bad("trial_over", 402);
  // The model `generateBatch` would use for this brand and type, resolved once for both generations and the price.
  const routed = generateRouteFor(u, brand, type);
  const model = routed.model;
  // A refused pick is counted for the founder console (global, best effort: it never changes the test), as in generateBatch.
  if (routed.rejected) await noteRejectedPick("generate", routed.rejected);
  const entry = modelById(model);
  if (!entry || (!entry.auto && !entry.pick) || !modelAllowsTask(entry, type)) return bad("model_unavailable", 503);
  const cost = 2 * creditsFor(countCost(type, 1), model, "generate", type);

  const by = await byOf(u);
  // The claim comes before the charge: whoever loses it has taken nothing.
  const row = (kind: Activity["kind"]): Activity => ({ at: new Date().toISOString(), kind, agent, by, via: "app", type, note: "instruction test" });
  const claim = `skilltest:${scope}:${nonce}`;
  if (!(await db.setNx(claim, "1", CLAIM_SECONDS))) return bad("duplicate", 409);

  if (renewalDue(u)) await renewIfDue(u.email);
  const paid = await charge(u.email, cost, { scope, agent, cap: gov.agentCaps[agent] });
  if (!paid.ok) {
    // Nothing was taken and no model was called: the same click may be sent again. Deleting the claim is safe only while
    // CLAIM_SECONDS (600) exceeds the route's maxDuration (300): no other request of this click can still be running.
    await db.del(claim).catch(() => {});
    // The refusal row, as generateBatch writes it: what the test would have cost and, at a cap, what the agent spent of it.
    await recordActivity(scope, [{ ...row(paid.reason === "agent_cap" ? "cap_reached" : "no_credits"), credits: cost, ...(paid.reason === "agent_cap" ? { outcome: `${paid.spent}/${paid.cap}` } : {}) }]);
    if (paid.reason === "agent_cap") return NextResponse.json({ ok: false, error: "agent_cap", agent: paid.agent, spent: paid.spent, cap: paid.cap }, { status: 402 });
    return NextResponse.json({ ok: false, error: "no_credits", need: cost, have: paid.credits }, { status: 402 });
  }

  try {
    // A warning about the cap must never fail a paid test.
    await warnAgentCap(u, paid).catch(() => {});
    // What a real `draft_items` of this type would read, so the two items differ only by the instruction set.
    const [prefs, memory, stats, feedback, active, draft] = await Promise.all([
      listPreferencesFor(scope, agent),
      memoryBlock(scope),
      statsFor(type, scope),
      feedbackFor(scope, agent, { gov }),
      loadLayers(scope, entitlements(u).instructions, "active", [agent]),
      loadLayers(scope, entitlements(u).instructions, "draft", [agent]),
    ]);
    const one = (layers: typeof active) =>
      generate(type, brand, prefs, brief.trim() || undefined, { memory, reviewer: gov.reviewer, noEmDash: gov.noEmDash, crossReview: false, meter: u.email, stats, feedback, model, layers, count: 1, deadline });
    const [before, after] = await Promise.all([one(active), one(draft)]);
    if (!before[0] || !after[0]) throw new Error("empty_generation");
    // After the answer exists: a failed log write never undoes the test (recordActivity does not throw).
    await recordActivity(scope, [{ ...row("instructions_tested"), count: 2, credits: cost }]);
    return NextResponse.json({ ok: true, before: before[0], after: after[0], spent: cost });
  } catch (error) {
    console.error("instruction test failed", error instanceof Error ? error.name : "error");
    // Exactly what was taken, with the receipt so the agent's monthly counter comes down with the balance.
    try {
      await refund(u.email, cost, paid);
    } catch {
      // The amount and the spend reference (agent, month, and a short hash of the scope, which for a default brand is the email) so the founder can find the charge; never the email or a secret.
      console.error("instruction test refund failed", JSON.stringify({ cost, agent: paid.agent, month: paid.month, scope: createHash("sha256").update(paid.scope).digest("hex").slice(0, 12) }));
      return bad("refund_failed", 500);
    }
    return error instanceof ModelPaused ? bad("model_paused", 503) : bad("generation_failed", 502);
  }
}
