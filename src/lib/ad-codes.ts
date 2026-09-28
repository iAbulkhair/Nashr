/**
 * Ad codes: how Nashr knows which of the owner's ads it wrote. Each new ad or social item gets a short code
 * (NSR-7K2QM); the owner puts it in the ad's name in their ads manager, and when results come in, by CSV or from a
 * connected ad account, the rows carrying a code of this workspace are Nashr's. Nothing else links an ad to an item:
 * the platforms know nothing about Nashr, and the read-only connectors never write names.
 *
 * Import-free: the inbox shows and copies the code, the server assigns and matches it.
 */
import type { TaskType } from "./tasks";

export const AD_CODE_TYPES: TaskType[] = ["ads", "social"];
export const hasAdCode = (type: TaskType) => AD_CODE_TYPES.includes(type);

// No 0/O, 1/I/L: the owner retypes the code as often as they paste it.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE = /\bNSR[-_ ]?([2-9A-HJKMNP-Z]{5})\b/gi;

export function newAdCode(): string {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return `NSR-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

/** Every code written in a piece of text, normalised to NSR-XXXXX, whatever the case or separator the owner used. */
export function codesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CODE)].map((m) => `NSR-${m[1].toUpperCase()}`))];
}

/** The text without its codes: a code's letters and digits are not the ad's wording. */
export const withoutCodes = (text: string) => text.replace(CODE, " ").replace(/\s+/g, " ").trim();
