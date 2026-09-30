/**
 * The contracts between the media engine (./jobs), the provider adapters, the Blob store and the routes. Types only,
 * plus the two error classes whose messages are fixed codes: chat tool errors reach the model and routes log them.
 */
import type { Aspect, MediaFailure, MediaKind, MediaModelId, MediaProviderId } from "../media-catalog";
import type { Task } from "../brand";
import type { AgentId } from "../agents";
import type { SpendRef } from "../credits";
import type { By } from "../actor";

/** What the engine hands an adapter. `imageUrl` is set only when mediaImageFor allowed it. */
export type SubmitInput = { model: MediaModelId; prompt: string; aspect: Aspect; imageUrl?: string };
/** fal answers in the same request (or refuses the content); kie and Higgsfield hand back a task id to poll. */
export type SubmitResult = { state: "pending"; providerTaskId: string } | { state: "done"; urls: string[] } | { state: "failed"; reason: "nsfw" };
export type StatusResult =
  | { state: "pending" }
  | { state: "done"; urls: string[]; /** kie `creditsConsumed`, when reported */ providerCredits?: number }
  | { state: "failed"; reason: "nsfw" | "provider_failed" };
/** Founder console check: balances and estimates only, never a secret. */
export type ProviderCheck = Record<string, number | string>;

export interface MediaAdapter {
  readonly id: MediaProviderId;
  /** Never retried by the caller: no provider offers an idempotency key, so a retry could render and bill twice. */
  submit(input: SubmitInput, signal: AbortSignal): Promise<SubmitResult>;
  status(ref: { providerTaskId: string; model: MediaModelId }, signal: AbortSignal): Promise<StatusResult>;
  cancel?(ref: { providerTaskId: string; model: MediaModelId }): Promise<void>;
  check?(signal: AbortSignal): Promise<ProviderCheck>;
}

export type ProviderErrorCode = "busy" | "no_balance" | "rejected" | "unavailable" | "bad_response";
/** The only error an adapter throws. Its message is a fixed code: never a provider body, header or key. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly status = 0) {
    super(`provider_${code}${status ? `:${status}` : ""}`);
    this.name = "ProviderError";
  }
}

export type StoredMedia = { url: string; bytes: number; contentType: "image/jpeg" | "video/mp4" };
export type StoreErrorCode = "not_https" | "fetch_failed" | "too_large" | "not_media" | "convert_failed" | "put_failed" | "no_blob" | "no_time";
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(`store_${code}`);
    this.name = "StoreError";
  }
}

export type MediaJobState = "queued" | "running" | "done" | "failed";
export type { MediaFailure };

export type MediaJob = {
  /** 16 random bytes, hex. Server-generated. */
  id: string;
  /** sc(u) when the job was created: the only workspace this job ever reads or writes. */
  scope: string;
  /** The account charged (credits are per account, not per brand). */
  email: string;
  /** That account's createdAt: a refund or a notification goes only to the same account (spec A32). */
  accountSince: string;
  /** The owner's interface language, for the notification (spec A28). */
  lang: "ar" | "en";
  taskId: string;
  kind: MediaKind;
  model: MediaModelId;
  provider: MediaProviderId;
  credits: number;
  prompt: string;
  /** Reference image sent to the provider (our Blob URL), if any. */
  imageUrl?: string;
  providerTaskId?: string;
  state: MediaJobState;
  error?: MediaFailure;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Provider result URLs not yet copied (untrusted; fetched only through safeFetch). Spec A25. */
  resultUrls?: string[];
  storeTries?: number;
  /** Our Blob URL (or, for fal without a working Blob store, the fal URL) once done. */
  url?: string;
  /** What this render cost us: kie creditsConsumed × $0.005 when reported, else the catalog estimate. */
  costUsd?: number;
  providerCredits?: number;
  refunded?: boolean;
  /** Holds the account's one trial video (mtrialvid): released if this job is refunded. */
  trialVideo?: boolean;
  /**
   * The agent this render was charged to in `scope`, and the month of the charge: the refund lowers that agent's monthly
   * counter by the same credits (src/lib/credits.ts). Absent on jobs started before agent caps: those refund the balance only.
   */
  spend?: SpendRef;
};

/** What the browser sees of a job. */
export type PublicJob = { id: string; kind: MediaKind; model: MediaModelId; credits: number; createdAt: string; state: "running" | "done" | "failed"; error?: MediaFailure };

/** Providers and storage, injected so the engine runs in tests with scripted fakes and no network. */
export type MediaDeps = {
  adapter(p: MediaProviderId): MediaAdapter;
  /** Copy a provider result to our store; every timeout inside is bounded by `deadline` (epoch ms). */
  store(sourceUrl: string, kind: MediaKind, deadline: number): Promise<StoredMedia>;
  blobReady(): boolean;
  now?(): number;
};

/** Who is moving a job forward. Only "hook" and "sweep" transitions notify the owner (spec A28). */
export type AdvanceVia = "start" | "poll" | "hook" | "sweep";
export type AdvanceOpts = { deadline: number; via: AdvanceVia; /** Skip the 4 s poll throttle (sweeps only). */ force?: boolean };

export type StartInput = {
  scope: string;
  email: string;
  lang: "ar" | "en";
  accountSince: string;
  plan: string;
  /** The balance read with the session: a pre-check so a request that cannot pay moves no counter (spec A24). */
  balance: number;
  /** The agent that owns the task (`agentForTask`, computed in code): the charge counts against its monthly cap in `scope`. */
  agent: AgentId;
  /** The owner's monthly cap for that agent in this scope (`gov.agentCaps`), read before the start; absent is no cap. */
  cap?: number;
  /** That agent's credits this month in this scope, read with the session: a pre-check like `balance`; the ledger decides. */
  spent?: number;
  taskId: string;
  model: MediaModelId;
  aspect: Aspect;
  imageUrl?: string;
  deadline: number;
  /** Called after the charge. Must not throw: prompts fall back to a fixed template. */
  prompt(timeoutMs: number): Promise<string>;
  /** Who started it and from where, for the activity log (`byOf` in ./start; chat passes its turn's). */
  by?: By;
  from?: "app" | "chat";
};
export type StartError =
  | "trial_over" | "bad_model" | "wrong_type" | "plan_required" | "trial_video_used" | "model_unavailable" | "needs_image"
  | "in_progress" | "busy" | "one_open" | "too_many" | "no_credits" | "agent_cap" | "nsfw" | "media_failed";
export type StartResult =
  | { ok: true; job: MediaJob; task: Task | null; credits: number }
  | {
      ok: false; status: 400 | 402 | 409 | 422 | 429 | 502; error: StartError; credits?: number; need?: number; have?: number; job?: PublicJob;
      /** With agent_cap: the agent, its credits this month and the owner's cap, as /api/generate answers them. */
      agent?: AgentId; spent?: number; cap?: number;
    };

export type SweepReport = { open: number; advanced: number; done: number; failed: number; dropped: number; skipped: number };
