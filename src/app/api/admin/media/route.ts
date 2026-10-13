import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { renderSpend } from "@/lib/admin-stats";
import type { MediaProviderId } from "@/lib/media-catalog";
import { availableModels, callbackUrl, modelsSwitchedOn, offModels, providerConfigured, storeConfigured } from "@/lib/media/config";
import { abortAfter, mk } from "@/lib/media/keys";
import { kieAdapter } from "@/lib/media/kie";
import { higgsfieldAdapter } from "@/lib/media/higgsfield";
import { probeStore } from "@/lib/media/store";

/**
 * Founder console "Check media providers" (spec A15, 4.9): configuration flags, the disk store probe (write, read back,
 * delete a tiny file; the sentinel's count of builds survived; usage against the ceilings, rule 1762), the kie balance, Higgsfield's /estimate per model, the switched-off models, this month's spend and the last
 * 50 renders. Flags only: no variable value is ever in the answer (the ids of the models switched on are not secret).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROVIDERS: readonly MediaProviderId[] = ["fal", "kie", "higgsfield"];
const CHECK_MS = 10_000;
const unreachable = () => ({ error: "unreachable" });

type Recent = { id: string; model: string; state: string; error?: string; providerCredits?: number; costUsd?: number; at?: string };
/** mjobs:recent rows are written by the engine without email or scope; only these fields are passed on. */
function recentRow(raw: string): Recent | null {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.model !== "string" || typeof r.state !== "string") return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { id: r.id, model: r.model, state: r.state, error: str(r.error), providerCredits: num(r.providerCredits), costUsd: num(r.costUsd), at: str(r.at) };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [kie, higgsfield, store, openSizes, spend, off, recent] = await Promise.all([
    providerConfigured("kie") ? kieAdapter.check!(abortAfter(CHECK_MS)).catch(unreachable) : null,
    providerConfigured("higgsfield") ? higgsfieldAdapter.check!(abortAfter(CHECK_MS)).catch(unreachable) : null,
    probeStore(),
    Promise.all(PROVIDERS.map((p) => db.smembers(mk.open(p)).then((m) => m.length))),
    renderSpend(),
    offModels(),
    db.lrange(mk.recent(), 0, 49),
  ]);
  return NextResponse.json({
    ok: true,
    configured: { fal: providerConfigured("fal"), kie: providerConfigured("kie"), higgsfield: providerConfigured("higgsfield"), store: storeConfigured(), webhooks: !!callbackUrl("kie") },
    modelsOn: [...modelsSwitchedOn()],
    available: availableModels(undefined, off),
    store,
    kie,
    higgsfield,
    open: Object.fromEntries(PROVIDERS.map((p, i) => [p, openSizes[i]])) as Record<MediaProviderId, number>,
    spend,
    off,
    recent: recent.map(recentRow).filter((r): r is Recent => !!r),
  });
}
