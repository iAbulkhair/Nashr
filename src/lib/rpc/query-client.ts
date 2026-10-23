import { QueryClient } from "@tanstack/react-query";

/**
 * The query cache's defaults (rule 3420, spec section 7), as Supastarter's `createQueryClient`: answers stay fresh for a
 * minute, nothing is retried (a 401, 403 or 429 is an answer, not a hiccup, and a retried mutation could spend a rate
 * limit or a password try twice), and nothing refetches because a tab got focus. One cache per browser tab
 * (`QueryProvider`); it lives in memory only, never in storage.
 */
export const QUERY_STALE_MS = 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: QUERY_STALE_MS, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
