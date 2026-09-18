/** Map with bounded concurrency. Upstash is HTTP per command, so sequential loops cost one round trip each. */
export async function pmap<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, limit = 24): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
