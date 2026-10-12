/**
 * The most characters a channel takes in one post, shown as "n / limit" under a draft and blocking Approve when passed.
 * One list for the chat's approval card and the inbox (rule 1124); they had two copies that disagreed on Meta.
 */
export const CHANNEL_LIMITS: Readonly<Record<string, number>> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, meta: 63206, linkedin: 3000 };

/** Whether a body is longer than its channel takes; a channel with no listed limit is never over. */
export const overLimit = (channel: string, length: number) => {
  const limit = CHANNEL_LIMITS[channel];
  return !!limit && length > limit;
};
