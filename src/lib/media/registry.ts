/**
 * The real providers and store behind the job engine (spec A6). The engine never imports an adapter or the store code;
 * the routes and the chat tool hand it this object. Tests replace this module with fakes (vi.mock), never the engine.
 */
import type { MediaProviderId } from "../media-catalog";
import { falAdapter } from "./fal";
import { kieAdapter } from "./kie";
import { higgsfieldAdapter } from "./higgsfield";
import { copyToStore, storeReady } from "./store";
import { shareUrl } from "./share";
import type { MediaAdapter, MediaDeps } from "./types";

/**
 * Rule 1755: a reference image leaves for the provider as a short signed link, minted here at the send. The engine and
 * the job record keep the plain URL, so nothing stored or logged ever carries a signature.
 */
const signed = (a: MediaAdapter): MediaAdapter => ({
  ...a,
  submit: (input, signal) => a.submit(input.imageUrl ? { ...input, imageUrl: shareUrl(input.imageUrl) } : input, signal),
});

const ADAPTERS: Record<MediaProviderId, MediaAdapter> = { fal: falAdapter, kie: signed(kieAdapter), higgsfield: signed(higgsfieldAdapter) };

export function mediaDeps(): MediaDeps {
  return { adapter: (p) => ADAPTERS[p], store: copyToStore, storeReady };
}
