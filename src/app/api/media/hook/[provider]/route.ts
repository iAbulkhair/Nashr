import { NextResponse, after } from "next/server";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { advance, jobForHook } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { providerConfigured } from "@/lib/media/config";
import { deadlineFor } from "@/lib/media/keys";
import { kieTaskIdFrom, verifyKieSignature } from "@/lib/media/kie";
import { hfRequestIdFrom } from "@/lib/media/higgsfield";
import { errCode } from "@/lib/media/start";

export const maxDuration = 120;

/** A callback body is a task id and a little status. Anything larger is not from a provider. */
const MAX_BODY_BYTES = 64 * 1024;
const HOOK_PER_IP = { max: 240, windowS: 60 };

/** The body as text, or null past the cap: the declared length first, then a running total, so a lying header cannot get more read. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Provider callbacks (spec 4.4 D, A30). Public, so the body is a hint and nothing more: the only field read is the
 * provider's task id, which must match its format; the job is found through the pointer we wrote, under the scope we
 * stored; and `advance` asks the provider itself, with our key, under the same 4 s throttle and job lock as a poll. URLs
 * in the body are never read. A well-formed hint gets 200 whether or not a job matches, so the answer is no oracle.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const { provider } = await ctx.params;
  // fal answers in the request and never calls back.
  if ((provider !== "kie" && provider !== "higgsfield") || !providerConfigured(provider)) return NextResponse.json({ ok: false }, { status: 404 });
  // Per IP only: a global bucket spent before validation would let anyone starve real callbacks (spec A30).
  if (!(await allow(`mhook:${provider}:${clientIp(req)}`, HOOK_PER_IP.max, HOOK_PER_IP.windowS))) return retryLater({ ok: false, error: "slow_down" }, HOOK_PER_IP.windowS);
  let body: unknown;
  try {
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    // A broken stream or a body that is not JSON: not a callback we can read.
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const id = provider === "kie" ? kieTaskIdFrom(body) : hfRequestIdFrom(body);
  if (!id) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  // kie signs its callbacks when the founder set a key; Higgsfield does not sign at all, so its hints stay hints.
  const key = process.env.KIE_WEBHOOK_HMAC_KEY;
  if (provider === "kie" && key && !verifyKieSignature(id, req.headers.get("x-webhook-timestamp"), req.headers.get("x-webhook-signature"), key)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const job = await jobForHook(provider, id);
  // Never `force`: the hint shares the job's poll throttle, so any number of callbacks cost at most one status call per 4 s.
  if (job) after(() => advance(job, mediaDeps(), { deadline, via: "hook" }).then(() => undefined, (e) => console.error("media hook", errCode(e))));
  return NextResponse.json({ ok: true });
}
