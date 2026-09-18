import { db } from "./db";
import { monthKey } from "./credits";

/**
 * Model token metering per account per month. Credits are what users pay;
 * this is what the models actually cost us, so margins are visible in the
 * admin console. Counters are Redis integers (INCRBY), cost stored in
 * micro-dollars to stay integer.
 */
export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** USD per million tokens. Approximate list prices; update when Anthropic changes them. */
const RATES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const DEFAULT_RATE = RATES["claude-opus-5"];

export const KINDS = ["generate", "review", "chat", "onboard", "image_prompt", "tool", "judge"] as const;
export type Kind = (typeof KINDS)[number];

export function costUsd(model: string, u: TokenUsage): number {
  const r = RATES[model] ?? DEFAULT_RATE;
  const inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
  return (inp * r.in + out * r.out + cr * r.cacheRead + cw * r.cacheWrite) / 1e6;
}

/** Record one model call. `email` undefined = anonymous (free tools); still counted globally. */
export async function meter(email: string | undefined, model: string, kind: Kind, usage?: TokenUsage | null) {
  if (!usage) return;
  const m = monthKey();
  const inp = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const out = usage.output_tokens ?? 0;
  const micro = Math.round(costUsd(model, usage) * 1e6);
  const targets = [`usage:_all:${m}`, ...(email ? [`usage:${email}:${m}`] : [])];
  try {
    await Promise.all(
      targets.flatMap((k) => [
        db.incrby(`${k}:in`, inp),
        db.incrby(`${k}:out`, out),
        db.incrby(`${k}:calls`, 1),
        db.incrby(`${k}:usd_micro`, micro),
        db.incrby(`${k}:kind:${kind}`, 1),
      ]),
    );
  } catch (e) {
    console.error("meter failed", e);
  }
}

export type UsageSummary = { month: string; in: number; out: number; calls: number; usd: number; kinds: Record<string, number> };

export async function getUsage(email: string | "_all", month = monthKey()): Promise<UsageSummary> {
  const k = `usage:${email}:${month}`;
  const n = async (s: string) => Number((await db.get<number>(`${k}:${s}`)) ?? 0);
  const [inp, out, calls, micro] = await Promise.all([n("in"), n("out"), n("calls"), n("usd_micro")]);
  const kinds: Record<string, number> = {};
  const counts = await Promise.all(KINDS.map((kind) => n(`kind:${kind}`)));
  KINDS.forEach((kind, i) => { if (counts[i]) kinds[kind] = counts[i]; });
  return { month, in: inp, out, calls, usd: Math.round(micro / 1e4) / 100, kinds };
}
