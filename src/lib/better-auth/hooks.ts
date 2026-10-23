import { queryOptions, useQuery } from "@tanstack/react-query";
import type { PasskeyItem } from "@/lib/passkeys";
import { authClient, type AuthClient } from "./client";

/**
 * TanStack Query hooks over the better-auth client (rule 3419, spec section 7), as Supastarter's
 * `modules/auth/lib/api.ts`: one key per question, exported so a mutation can invalidate it, and an options builder per
 * hook so a screen can prefetch or a test can `fetchQuery` without React. Every queryFn resolves the client when it runs,
 * so a server render of a component that holds one of these hooks builds nothing and fetches nothing.
 *
 * Errors are the wrapper's legacy codes (`not_found` while AUTH_ENGINE is off, `slow_down`, `invalid`, ...) as an
 * `AuthQueryError`, so a screen maps them through the same messages as the forms.
 */
export const sessionQueryKey = ["user", "session"] as const;
export const userAccountsQueryKey = ["user", "accounts"] as const;
export const userPasskeysQueryKey = ["user", "passkeys"] as const;

export class AuthQueryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "AuthQueryError";
    this.code = code;
    this.status = status;
  }
}

/** better-fetch's error object (`{...body, status, statusText}`) or a JSON body, as an `AuthQueryError`. */
export function authQueryError(e: unknown, status?: number): AuthQueryError {
  const r = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
  const code = typeof r.error === "string" && r.error ? r.error : "failed";
  return new AuthQueryError(code, typeof r.status === "number" ? r.status : status ?? 0);
}

type GetClient = () => AuthClient;

/** Who is signed in, or null. Never refetched on focus and never retried: a sign-in or sign-out invalidates the key. */
export function sessionQueryOptions(getClient: GetClient = authClient) {
  return queryOptions({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      const { data, error } = await getClient().getSession();
      if (error) throw authQueryError(error);
      return data ?? null;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The signed-in login's ways in: `credential` (a password is set) and `google`, never a provider token or hash. */
export function userAccountsQueryOptions(getClient: GetClient = authClient) {
  return queryOptions({
    queryKey: userAccountsQueryKey,
    queryFn: async () => {
      const { data, error } = await getClient().listAccounts();
      if (error) throw authQueryError(error);
      return Array.isArray(data) ? data : [];
    },
    retry: false,
  });
}

export type PasskeyList = { items: PasskeyItem[]; max: number; enabled: boolean; proof: "password" | "code" | "none" };

/** The acting login's passkeys, as GET /api/account/passkeys answers them (the card's own read, rule 2413). */
export function userPasskeysQueryOptions(fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  return queryOptions({
    queryKey: userPasskeysQueryKey,
    queryFn: async (): Promise<PasskeyList> => {
      const res = await fetchImpl("/api/account/passkeys", { credentials: "same-origin", headers: { accept: "application/json" } });
      const j = (await res.json().catch(() => null)) as (Partial<PasskeyList> & { ok?: boolean; error?: string }) | null;
      if (!res.ok || !j?.ok || !Array.isArray(j.items)) throw authQueryError(j, res.status);
      return { items: j.items, max: typeof j.max === "number" ? j.max : 10, enabled: !!j.enabled, proof: j.proof ?? "password" };
    },
    retry: false,
  });
}

export const useSessionQuery = () => useQuery(sessionQueryOptions());
export const useUserAccountsQuery = () => useQuery(userAccountsQueryOptions());
export const useUserPasskeysQuery = () => useQuery(userPasskeysQueryOptions());
