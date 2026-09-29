import { vi } from "vitest";
import type { MediaKind, MediaProviderId } from "@/lib/media-catalog";
import { StoreError, type MediaAdapter, type MediaDeps, type StatusResult, type StoredMedia, type SubmitInput, type SubmitResult } from "@/lib/media/types";

/** Every variable that switches a media provider, the Blob store or a model on. Tests set ALL of them, never FAL_KEY alone. */
export const MEDIA_ENV = { fal: ["FAL_KEY"], kie: ["KIE_API_KEY"], hmac: ["KIE_WEBHOOK_HMAC_KEY"], higgsfield: ["HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET"], blob: ["BLOB_READ_WRITE_TOKEN"] } as const;
/** `models: "all"` lists every catalogue id in MEDIA_MODELS_ON; a string is used as is; absent means unset (img-fast only). */
export function mediaEnv(on: Partial<Record<keyof typeof MEDIA_ENV, boolean>> & { models?: "all" | string } = {}) {
  for (const [group, names] of Object.entries(MEDIA_ENV)) for (const n of names) vi.stubEnv(n, on[group as keyof typeof MEDIA_ENV] ? `test-${n.toLowerCase()}` : "");
  vi.stubEnv("MEDIA_MODELS_ON", on.models === "all" ? "img-balanced,img-premium,img-text,img-lifestyle,img-design,vid-quick,vid-sound,vid-premium,vid-cinematic,vid-motion" : on.models ?? "");
}

/**
 * The memory store is shared by every test in a file (globalThis.__nashrMem, src/lib/db.ts) and allow() is a fixed
 * window (src/lib/rate.ts), so global counters leak between tests. The spend counters (render:_all:*) are global too, so
 * a test that reads one exact total sees only its own jobs. Call in beforeEach of every media test file.
 */
export function resetMediaCounters() {
  const mem = (globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>>; exp?: Map<string, number> } }).__nashrMem;
  if (!mem) return;
  const global = /^(rate:kie:create|rate:mhook:|rate:mfail:|media:off|msweep|mhfclean|mjobs:recent|render:_all:)/;
  for (const k of [...mem.kv.keys()]) if (global.test(k)) { mem.kv.delete(k); mem.exp?.delete(k); }
  for (const k of [...mem.lists.keys()]) if (global.test(k)) mem.lists.delete(k);
  for (const k of [...mem.sets.keys()]) if (k.startsWith("mjobs:open:")) mem.sets.delete(k);
}
/** A distinct client IP per webhook test, so clientIp() is never "unknown" for all of them (src/lib/rate.ts:14-16). */
export const ipHeaders = (n: number) => ({ "x-vercel-forwarded-for": `203.0.113.${n}` });

/** Any fetch fails loudly and is recorded. Returns the recorder and a restore function. */
export function noNetwork() {
  const real = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(u.host);
    throw new Error(`network in a test: ${u.host}`);
  }) as typeof fetch;
  return { hosts, restore: () => { globalThis.fetch = real; } };
}

export type FakeScript = { submit?: (i: SubmitInput, n: number, signal: AbortSignal) => SubmitResult | Promise<SubmitResult>; status?: (n: number) => StatusResult | Promise<StatusResult> };
/**
 * A scripted provider. Defaults: fal answers done at once; kie and Higgsfield answer pending with a well-formed task id.
 * The counters live on the returned object itself (not a copy), so a test reads them after the calls.
 */
export function fakeAdapter(id: MediaProviderId, script: FakeScript = {}) {
  const a = {
    id,
    submits: [] as SubmitInput[],
    signals: [] as AbortSignal[],
    statusCalls: 0,
    cancels: 0,
    async submit(i: SubmitInput, signal: AbortSignal): Promise<SubmitResult> {
      a.submits.push(i); a.signals.push(signal);
      const n = a.submits.length;
      if (script.submit) return script.submit(i, n, signal);
      if (id === "fal") return { state: "done", urls: ["https://v3.fal.media/files/test.jpg"] };
      return { state: "pending", providerTaskId: id === "kie" ? `kietask${n}abc` : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` };
    },
    async status(): Promise<StatusResult> { a.statusCalls++; return script.status ? script.status(a.statusCalls) : { state: "pending" }; },
    async cancel(): Promise<void> { a.cancels++; },
  };
  return a satisfies MediaAdapter;
}

/** MediaDeps over fakes. `stored` records every copy the engine asked for; `storeFails` fails the first N copies (true = all). */
export function fakeDeps(adapters: Partial<Record<MediaProviderId, MediaAdapter>> = {}, opts: { blob?: boolean; storeFails?: boolean | number; now?: () => number } = {}) {
  const stored: { source: string; kind: MediaKind; url: string; deadline: number }[] = [];
  let failures = 0;
  const deps: MediaDeps & { stored: typeof stored } = {
    stored,
    adapter: (p) => { const a = adapters[p]; if (!a) throw new Error(`no fake adapter for ${p}`); return a; },
    async store(source, kind, deadline): Promise<StoredMedia> {
      if (opts.storeFails === true || (typeof opts.storeFails === "number" && failures < opts.storeFails)) { failures++; throw new StoreError("put_failed"); }
      const url = `https://test.public.blob.vercel-storage.com/media/${String(stored.length + 1).padStart(32, "0")}.${kind === "image" ? "jpg" : "mp4"}`;
      stored.push({ source, kind, url, deadline });
      return { url, bytes: 1, contentType: kind === "image" ? "image/jpeg" : "video/mp4" };
    },
    blobReady: () => opts.blob ?? true,
    now: opts.now,
  };
  return deps;
}
