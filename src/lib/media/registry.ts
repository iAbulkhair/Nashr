/**
 * The real providers and store behind the job engine (spec A6). The engine never imports an adapter or the Blob code;
 * the routes and the chat tool hand it this object. Tests replace this module with fakes (vi.mock), never the engine.
 */
import type { MediaProviderId } from "../media-catalog";
import { falAdapter } from "./fal";
import { kieAdapter } from "./kie";
import { higgsfieldAdapter } from "./higgsfield";
import { copyToBlob } from "./blob";
import { blobConfigured } from "./config";
import type { MediaAdapter, MediaDeps } from "./types";

const ADAPTERS: Record<MediaProviderId, MediaAdapter> = { fal: falAdapter, kie: kieAdapter, higgsfield: higgsfieldAdapter };

export function mediaDeps(): MediaDeps {
  return { adapter: (p) => ADAPTERS[p], store: copyToBlob, blobReady: blobConfigured };
}
