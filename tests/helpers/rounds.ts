import { vi } from "vitest";
import { db } from "@/lib/db";

/**
 * Counts Redis round trips the way production pays for them (Upstash is HTTP per command, CLAUDE.md).
 *
 * Every `db` method is wrapped. A call that starts while no other call is in flight opens a new round; a call that
 * starts while one is in flight joins the current round (it would ride the same parallel batch of HTTP requests). Each
 * call settles only after a macrotask, standing in for network latency, so a `Promise.all` started in one tick is one
 * round and an `await` between two calls makes two. The self-test in tests/multi-org-session.test.ts pins this
 * behaviour (Promise.all of 3 = 1, three awaits = 3, two then one = 2, calls started a few microtasks late = same round).
 *
 * `start()` resets the counter; `stop()` restores the real methods (vitest's restoreMocks also does).
 */
export type Round = { round: number; op: string; key: string };

export function trackRounds() {
  let round = 0;
  let inFlight = 0;
  const calls: Round[] = [];
  const spies: { mockRestore(): void }[] = [];
  const target = db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of Object.keys(target)) {
    if (typeof target[name] !== "function") continue;
    const real = target[name].bind(db);
    spies.push(
      vi.spyOn(target, name).mockImplementation((async (...args: unknown[]) => {
        if (inFlight === 0) round += 1;
        inFlight += 1;
        calls.push({ round, op: name, key: typeof args[0] === "string" ? args[0] : Array.isArray(args[0]) ? args[0].join(",") : "" });
        try {
          const v = await real(...args);
          await new Promise((res) => setTimeout(res, 1));
          return v;
        } finally {
          inFlight -= 1;
        }
      }) as never),
    );
  }
  return {
    calls,
    /** The rounds opened since the last `start()`. */
    rounds: () => round,
    /** Forget earlier calls: the next call opens round 1. Call it when nothing is in flight. */
    start() {
      round = 0;
      calls.length = 0;
    },
    stop() {
      for (const s of spies) s.mockRestore();
    },
  };
}
