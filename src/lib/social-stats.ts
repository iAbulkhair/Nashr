/**
 * Instagram and LinkedIn page results, read through Composio for Dana's reports and the Reports page
 * (docs/superpowers/specs/2026-10-08-social-results-via-composio-design.md). Read only.
 */

/**
 * Instagram media ids Thakeen published for this workspace (publish-once.ts), so a result can say «من ذكين». No TTL: the
 * wrapper cannot refresh a set's TTL, one id is about 20 bytes, and wipeAccount deletes it.
 */
export const SOCIAL_PUB_KEY = (scope: string) => `socialpub:${scope}`;
