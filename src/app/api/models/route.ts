import { NextResponse } from "next/server";
import { currentUser, saveUser, sc } from "@/lib/auth";
import { getBrand, saveBrand } from "@/lib/brand";
import { withBrandLock } from "@/lib/brand-proposals";
import { chatStatus } from "@/lib/chat-allowance";
import { setConversationModel } from "@/lib/conversations";
import { withUserLock } from "@/lib/credits";
import { modelAllowsTask, modelById, pickerView } from "@/lib/models/catalog";
import { chatUnitsFor, tierMultiplier } from "@/lib/models/credits";
import { chatRouteFor, chinaConfirmed } from "@/lib/models/overrides";
import { MODEL_PICKS_PER_HOUR, allow, retryAfter, retryLater } from "@/lib/rate";
import { forbid } from "@/lib/roles";
import { TASK_COST, type TaskType } from "@/lib/tasks";

/**
 * The customer's model picks (spec 2026-10-08-straitly-model-routing, sections 4, 7 and 8; plan Task 6). What a pick
 * does at call time is src/lib/models/overrides.ts.
 *
 * GET: what the picker shows, all worked out here so no rate and no multiplier is hard-coded in the client: the entries
 * customers may pick (`pickerView`: id, label, tier, hosting and `tools`, so the chat picker leaves out an entry that
 * cannot run chat's tools; never a rate), each one's credit multiplier per surface
 * (relative to that surface's default model, `tierMultiplier`), its generation multiplier per task type
 * (`generateByTask`, rule 902: relative to that type's own writer in `TASK_MODELS`, only the types the entry may run,
 * `modelAllowsTask`; `multipliers.generate` stays the multiplier on a type Opus 5.5 writes, for a page loaded before
 * this key existed), the messages of the chat allowance one message on it
 * counts (`chatUnitsFor`), and whether the owner confirmed China-hosted models. Any signed-in login; it reads only what
 * `currentUser()` reads to resolve the session (the `session:{token}` record behind the cookie; for a founder
 * impersonation opened with the console key, `keyImpLive`'s liveness check of that key's console session,
 * `adminsession:{as}`; the login's user and member records and active brand id; for a member, the owner's user record,
 * brand list and roster entry too) and writes nothing of its own (`currentUser()` renews such a console session at most
 * once a minute, src/lib/auth.ts `readSession`).
 *
 * PUT `{ target: "conversation", id, model }` sets (a catalog id) or clears (`null`) a conversation's chat pick; any login
 * of the account (`conversations`). PUT `{ target: "brand", id?, model }` does the same for the ACTIVE brand's
 * generation pick: `id`, when sent, must be the active brand's (`u.brandId`, "default" for the account's first); admin
 * or owner (`brand.write`). PUT `{ confirmChina: true }` stores the owner's confirmation on the account; owner only
 * (`profile.account`), never while a founder impersonates (a consent is the owner's own); sent with `target`, `id` or
 * `model` it is a bad request and nothing is written.
 *
 * Every record is found under the caller's own scope: `sc(u)` for the conversation and the brand, the session's account
 * email for the confirmation. Nothing in the body names a scope or an account, and a field that tries is ignored. A
 * conversation or brand the caller does not have (another account's id, the default thread, which has no record, a
 * brand file that does not exist, another brand's id) is `not_found` and nothing is written.
 *
 * The id is checked in code, never left to the picker: exactly a catalog id (`modelById`; prototype names and anything
 * that is not a string are `unknown_model`), offered to customers (`pick`, else `not_pickable`; for a conversation also
 * able to run chat's tools), and a model not hosted in the west only after the owner's STORED confirmation (else
 * `china_unconfirmed`: a request that skipped the UI gets no further). Validated again at every call (`route()`), so a
 * pick the catalog later drops falls back to automatic.
 *
 * A conversation pick that landed answers `{ ok: true, chat }`: the account's chat status (`chatStatus`, the same one the
 * chat page shows under the box) for the model the conversation now runs on (`chatRouteFor` on the record as written,
 * the page's own resolver), so the allowance line and its overflow ceiling follow the pick without the client working
 * out anything. Counters only (the account's, as for every seat); no rate, no model id. When that read fails after the
 * write, the pick still answers `{ ok: true }`, without `chat` (the line keeps its value until the next answer). A brand
 * pick and the confirmation answer `{ ok: true }`: they change no chat ceiling.
 *
 * A refusal answers `{ error }` with 400 `bad_request` | `unknown_model` | `not_pickable`, 409
 * `china_unconfirmed` | `busy` (the brand lock), 503 `busy` with Retry-After (the conversation's lock, not taken within
 * about 3 s; nothing written), 404 `not_found`, 403 `forbidden`, 429 `slow_down` past MODEL_PICKS_PER_HOUR for the
 * account (with Retry-After), 401 without a session.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const models = pickerView();
  const byId = (f: (id: string) => number) => Object.fromEntries(models.map((m) => [m.id, f(m.id)]));
  const types = Object.keys(TASK_COST) as TaskType[];
  const generateByTask = Object.fromEntries(types.map((t) => [t, Object.fromEntries(models.filter((m) => modelAllowsTask(modelById(m.id)!, t)).map((m) => [m.id, tierMultiplier(m.id, "generate", t)]))]));
  return NextResponse.json({
    models,
    multipliers: { chat: byId((id) => tierMultiplier(id, "chat")), generate: byId((id) => tierMultiplier(id, "generate")) },
    generateByTask,
    chatUnits: byId(chatUnitsFor),
    chinaConfirmed: chinaConfirmed(u),
  });
}

type Body = { target?: unknown; id?: unknown; model?: unknown; confirmChina?: unknown };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!(await allow(`modelpick:${u.email}`, MODEL_PICKS_PER_HOUR, 3600))) return retryLater({ error: "slow_down" }, 3600);
  const raw: unknown = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("bad_request", 400);
  const b = raw as Body;

  if (Object.hasOwn(b, "confirmChina")) {
    // The confirmation goes alone: sent with a pick it would be half applied, so nothing is written for it.
    if (b.confirmChina !== true || Object.hasOwn(b, "target") || Object.hasOwn(b, "id") || Object.hasOwn(b, "model")) return fail("bad_request", 400);
    const no = forbid(u, "profile.account");
    if (no) return no;
    if (u.actor?.kind === "founder") return fail("forbidden", 403);
    // Under the user lock, so it cannot undo a balance change saved at the same time. Only this one field changes.
    await withUserLock(u.email, async (acc) => {
      acc.chinaHostingOk = true;
      await saveUser(acc);
    });
    return NextResponse.json({ ok: true });
  }

  const target = b.target;
  if (target !== "conversation" && target !== "brand") return fail("bad_request", 400);
  const no = forbid(u, target === "brand" ? "brand.write" : "conversations");
  if (no) return no;

  // The pick, checked before anything is read: null clears it.
  let model: string | null = null;
  if (b.model !== null) {
    const entry = modelById(b.model);
    if (!entry) return fail("unknown_model", 400);
    if (!entry.pick || (target === "conversation" && !entry.caps.tools)) return fail("not_pickable", 400);
    if (entry.hosting !== "west" && !chinaConfirmed(u)) return fail("china_unconfirmed", 409);
    model = entry.id;
  }

  if (target === "conversation") {
    // Under the conversation's lock, which every writer of its record holds (src/lib/conversations.ts).
    const done = await setConversationModel(sc(u), b.id, model);
    if (done === "busy") return NextResponse.json({ error: "busy" }, { status: 503, headers: retryAfter(1) });
    if (done !== "ok") return fail("not_found", 404);
    // The chat ceiling for the model the conversation runs on from now: the record holds `model` (or nothing) as written.
    // The pick has landed, so a failed read of the counters (a Redis HTTP error) must not answer a failure: the client
    // would roll back a pick the next turn runs on. It answers without `chat` and the allowance line keeps its value. The
    // warning names nothing: no account, conversation or model, and not the error, whose message can carry the key.
    try {
      const chat = await chatStatus(u, chatRouteFor(u, { model: model ?? undefined }).model);
      return NextResponse.json({ ok: true, chat });
    } catch {
      console.warn("model pick saved; chat status read failed");
      return NextResponse.json({ ok: true });
    }
  }

  // Only the active brand: its scope is the session's, and an id, when sent, must name it.
  if (b.id !== undefined && b.id !== (u.brandId ?? "default")) return fail("not_found", 404);
  const scope = sc(u);
  let found: boolean;
  try {
    // Under the brand lock every brand writer holds, so a field saved meanwhile is never overwritten by this copy. The
    // file's content and `updatedAt` stay as they are: the pick is a setting, not brand content.
    found = await withBrandLock(scope, async () => {
      const cur = await getBrand(scope);
      if (!cur) return false;
      if (model === null) delete cur.model;
      else cur.model = model;
      await saveBrand(scope, cur);
      return true;
    });
  } catch (e) {
    if (e instanceof Error && e.message === "brand_lock_timeout") return fail("busy", 409);
    throw e;
  }
  return found ? NextResponse.json({ ok: true }) : fail("not_found", 404);
}
