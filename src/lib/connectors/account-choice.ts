/**
 * Which providers let the customer choose, and later change, the account or Page a Composio connection uses.
 *
 * Composio cannot force the platform's own chooser: `connectedAccounts.link` takes a callback, an alias and `allowMultiple`
 * only (no prompt, no re-consent option), and its Facebook guide says the account is whatever Meta's picker returned and
 * that it cannot be switched on an issued token. Meta and LinkedIn remember the earlier grant and the browser's saved login,
 * so a second connect can skip the screen. The only way to see it again is to remove the app in the platform's own settings
 * and connect once more. The panel therefore explains that and links the settings page; it never promises a fresh consent
 * from the Reconnect button alone (docs/system/tests/4200-account-choice.md).
 *
 * The links are the platforms' own settings pages, typed here and nowhere else, and shown only to an owner or admin who
 * can already connect (the connect route is unchanged). Pure data, no environment, safe in a client component.
 */
export const ACCOUNT_SETTINGS: Readonly<Record<string, string>> = {
  meta: "https://www.facebook.com/settings?tab=business_tools",
  linkedin: "https://www.linkedin.com/psettings/permitted-services",
};

/** The platform's settings page where the grant is removed, or null for a provider that has no such step. Own keys only. */
export function accountSettingsUrl(provider: string): string | null {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_SETTINGS, provider) ? ACCOUNT_SETTINGS[provider] : null;
}
