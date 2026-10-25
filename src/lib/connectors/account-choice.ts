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
 * Each toolkit has its own settings page: on staging (2026-10-25) the Instagram grant was under Instagram's "Apps and
 * websites", not under Facebook's Business integrations, and the app may carry Composio's name, not ours. The links are the
 * platforms' own settings pages, typed here and nowhere else, and shown only to an owner or admin who can already connect
 * (the connect route is unchanged). Pure data, no environment, safe in a client component.
 */
export const ACCOUNT_SETTINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  meta: {
    facebook: "https://www.facebook.com/settings?tab=business_tools",
    instagram: "https://www.instagram.com/accounts/manage_access/",
  },
  linkedin: { linkedin: "https://www.linkedin.com/psettings/permitted-services" },
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The provider has a platform-side account or Page choice the owner may need to reset. Own keys only. */
export const hasAccountChoice = (provider: string): boolean => own(ACCOUNT_SETTINGS, provider);

/** The settings page where one toolkit's grant is removed, or null for a provider or toolkit with no such step. Own keys only. */
export function accountSettingsUrl(provider: string, toolkit: string): string | null {
  if (!own(ACCOUNT_SETTINGS, provider)) return null;
  const pages = ACCOUNT_SETTINGS[provider];
  return own(pages, toolkit) ? pages[toolkit] : null;
}
