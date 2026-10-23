"use client";
import { useSyncExternalStore } from "react";
import { CONSENT_EVENT, readConsent, type ConsentChoice } from "@/lib/cookie-consent";

const subscribe = (fn: () => void) => {
  window.addEventListener(CONSENT_EVENT, fn);
  return () => window.removeEventListener(CONSENT_EVENT, fn);
};

/**
 * The visitor's answer from the consent cookie: "yes", "no", null (not answered yet) or undefined on the server and
 * during hydration, so nothing that depends on the answer renders until the browser has read it (rule 3335).
 */
export function useConsent(): ConsentChoice | null | undefined {
  return useSyncExternalStore<ConsentChoice | null | undefined>(subscribe, () => readConsent(document.cookie), () => undefined);
}
