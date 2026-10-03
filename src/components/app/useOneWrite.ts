"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { formatWhen } from "@/lib/secretary-agenda";

/**
 * Shared by the to-do page's Away and Working days panels (client components).
 *
 * `localDay(lang, today)` writes a local day "YYYY-MM-DD" the way the to-do page writes dates (through `dates.ts`, Latin
 * digits), with its year when that is not `today`'s; the day is the same in every Gulf zone. Text formatted in the
 * browser may be worded differently by the server's ICU, so the element holding it carries `suppressHydrationWarning`.
 */
export const localDay = (lang: "ar" | "en", today: string) => (day: string) =>
  formatWhen(`${day}T09:00:00.000Z`, true, lang, Date.parse(`${today}T09:00:00.000Z`));

/** A refused request in the page's words: too many requests; else the error's own words (`words` first, then the to-do list's); else "could not save". */
export function refusalText(t: AppDict, status: number, code: unknown, words: Readonly<Record<string, string>> = {}): string {
  if (status === 429) return t.handoff.errors.slow_down;
  if (typeof code === "string") return words[code] ?? t.todo.errors[code] ?? t.todo.errors.generic;
  return t.todo.errors.generic;
}

/**
 * One write at a time. `send(key, url, method, body)` sends the JSON body and, when the answer is ok, refreshes the
 * server render and returns the answer; otherwise it sets `error` (for `key`) and returns null. A call while another runs
 * sends nothing: the in-flight mark is a ref, set before the request, so a double click cannot pass it even before React
 * re-renders; `busy` names the running write so the panel can disable its buttons. `words` overrides the to-do list's
 * words for an error code (the away list's "not found" is a name, not an item).
 */
export function useOneWrite(t: AppDict, words?: Readonly<Record<string, string>>) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const inflight = useRef(false);
  async function send(key: string, url: string, method: "PUT" | "DELETE", body: unknown): Promise<Record<string, unknown> | null> {
    if (inflight.current) return null;
    inflight.current = true;
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok || !j.ok) {
        setError({ key, text: refusalText(t, r.status, j.error, words) });
        return null;
      }
      router.refresh();
      return j;
    } catch {
      setError({ key, text: t.todo.errors.generic });
      return null;
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }
  return { busy, error, send };
}
