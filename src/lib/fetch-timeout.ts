/**
 * How long one outbound call to a third party may take, body included, when its caller sets no deadline of its own
 * (rule 1344). Without it a slow or silent provider held the function until the host's own limit: `safeFetch` had no
 * default, and the Salla, Zid, Meta, ads, Telegram and Brevo calls passed no `AbortSignal`. A caller with a longer job
 * (a media download, a crawl) passes its own signal and keeps it.
 */
export const PROVIDER_TIMEOUT_MS = 30_000;

/** A fresh deadline for one call (an `AbortSignal` is spent once it fires, so never share one). */
export const providerTimeout = () => AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
