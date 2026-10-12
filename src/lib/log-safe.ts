/**
 * What a log line may say about a caught error (rule 1354): its class name and, when the message carries one, the
 * first HTTP status in it. Never the message itself, the stack's arguments or the whole object: a provider's error body
 * can echo what was sent to it, and "secrets are never logged" (CLAUDE.md) has to hold whatever the provider answers.
 */
export function errorTag(e: unknown): string {
  if (!(e instanceof Error)) return "error";
  const status = e.message.match(/\b([1-5]\d\d)\b/)?.[1];
  return status ? `${e.name} ${status}` : e.name;
}
