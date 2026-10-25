/**
 * What Thakeen may call through Composio, per toolkit: the exact tool slugs and, for each, the argument names the code
 * may send. Nothing outside these lists is ever executed (docs/superpowers/specs/2026-10-05-meta-via-composio-design.md,
 * section 3). Slugs and argument names were read from Composio's tool schemas on 2026-10-05; the measured run on the
 * founder's own accounts confirms them (plan Task 8). No imports: the registry and tests read it freely.
 *
 * Ad accounts and Google's analytics are read only here. Composio's own toolkits do list write tools (for example
 * `METAADS_COPY_AD_OBJECT`, `GOOGLE_SEARCH_CONSOLE_ADD_SITE`); only this allowlist keeps them read-only: their entries
 * below list no write tool at all, so nothing here can create, edit, pause or fund an ad, or change a property (the
 * founder's rule of 2026-10-05: ads are read and analysed, never published or edited; rule 653).
 *
 * Instagram, Facebook Page, LinkedIn page, YouTube channel and TikTok account results are reads (rules 663, 739, 740 and
 * 742, specs 2026-10-08-social-results and 2026-10-08-social-analytics-reports B1, B2, C1): no tool here posts, replies,
 * likes or edits on the strength of them.
 *
 * WhatsApp and YouTube are drafts only (rule 657): WhatsApp's one write submits a message template to Meta's review and
 * no tool sends a message; YouTube's one write uploads a video whose privacyStatus is pinned to "private" in `fixed`.
 *
 * Google Docs and Google Sheets are reference files only (rules 955-956, spec 2026-10-10 agent skills portal 8.3): two
 * searches and two reads, `write: {}`, so no tool here creates, edits, shares or deletes a document or a sheet. What a
 * read returns is untrusted text; src/lib/instruction-refs.ts stores it as a workspace file.
 *
 * Google Drive, Dropbox and OneDrive are the customer's own cloud drives (rules 1775-1776, src/lib/cloud-drives.ts): one
 * search, one download and one or two uploads each. Nothing here lists, moves, shares, deletes or edits a file in the
 * drive, and no upload takes a URL for Composio to fetch (OneDrive's `source_url` is left out): the only file handed over
 * is our own copy, staged by composioStageFile. Dropbox and OneDrive uploads are pinned in `fixed` to add a new file and
 * rename on a clash, so an export never overwrites the customer's file; OneDrive's land in "/Thakeen". What a download
 * returns is untrusted: cloud-drives.ts checks its size, its magic bytes or its UTF-8 before anything keeps it.
 *
 * Google Calendar is Reem's marketing calendar read through Composio instead of Thakeen's own Google app (rules 4260-4279,
 * src/lib/secretary-gcal-via.ts): the list of the account's own calendars and one events read, `write: {}`, so no tool here
 * creates, moves, edits or deletes an event, shares a calendar or sends an invitation. The events read always carries
 * `fields`, a constant selector with the same event fields the direct path asks Google for (no description, attendee
 * names, place or meeting link). What it returns is untrusted: `keepGoogle` reads each item.
 *
 * Not here on purpose: ad writes (money moves need their own spec, evaluation spec C-R1), comments and messages (untrusted
 * input with no feature to use it), Google Business Profile (Composio lists no toolkit for it), Calendly and Cal.com
 * (Reem B2 receives their webhooks directly, evaluation spec C-R4).
 */
export type Toolkit =
  | "facebook" | "instagram" | "twitter" | "linkedin" | "tiktok" | "whatsapp" | "youtube"
  | "metaads" | "snapchat" | "googleads" | "tiktok_ads" | "linkedin_ads" | "google_analytics" | "google_search_console"
  | "googledocs" | "googlesheets" | "googledrive" | "dropbox" | "one_drive" | "googlecalendar";

type Tools = Readonly<Record<string, readonly string[]>>;
/**
 * `fixed`: argument values a write must carry exactly, checked in composio.ts before anything is sent. They keep a
 * draft a draft in code, not only in the caller: TikTok's photo lands in the owner's inbox, YouTube's upload is private.
 */
export type ToolkitEntry = Readonly<{ provider: string; authEnv: string; read: Tools; write: Tools; fixed?: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>;

export const TOOLKITS: Readonly<Record<Toolkit, ToolkitEntry>> = {
  facebook: {
    provider: "meta",
    authEnv: "COMPOSIO_AUTH_FACEBOOK",
    // `fields` is always sent: the tool's default includes each Page's access_token, which Thakeen must never receive.
    // The Page's results (rule 739): its daily insights, its own posts and each post's two insights, with constant
    // metrics and fields (social-read/facebook.ts); no field list here or there names access_token.
    read: {
      FACEBOOK_LIST_MANAGED_PAGES: ["fields", "limit"],
      FACEBOOK_GET_PAGE_INSIGHTS: ["page_id", "metrics", "period", "since", "until"],
      FACEBOOK_GET_PAGE_POSTS: ["page_id", "fields", "limit"],
      FACEBOOK_GET_POST_INSIGHTS: ["post_id", "metrics", "period"],
    },
    write: { FACEBOOK_CREATE_POST: ["page_id", "message", "published"], FACEBOOK_CREATE_PHOTO_POST: ["page_id", "url", "message", "published"] },
  },
  instagram: {
    provider: "meta",
    authEnv: "COMPOSIO_AUTH_INSTAGRAM",
    read: {
      INSTAGRAM_GET_USER_INFO: ["fields"],
      INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT: ["ig_user_id", "fields"],
      // Results (rule 663): the account's totals, its recent posts, and each post's lifetime numbers.
      INSTAGRAM_GET_USER_INSIGHTS: ["ig_user_id", "metric", "period", "metric_type", "since", "until"],
      INSTAGRAM_GET_IG_USER_MEDIA: ["ig_user_id", "fields", "limit", "since", "after"],
      INSTAGRAM_GET_IG_MEDIA_INSIGHTS: ["ig_media_id", "metric"],
    },
    write: { INSTAGRAM_POST_IG_USER_MEDIA: ["ig_user_id", "image_url", "caption"], INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: ["ig_user_id", "creation_id", "max_wait_seconds"] },
  },
  twitter: {
    provider: "x",
    authEnv: "COMPOSIO_AUTH_TWITTER",
    read: { TWITTER_USER_LOOKUP_ME: [] },
    write: { TWITTER_CREATION_OF_A_POST: ["text"] },
  },
  linkedin: {
    provider: "linkedin",
    authEnv: "COMPOSIO_AUTH_LINKEDIN",
    read: {
      LINKEDIN_GET_MY_INFO: [],
      // Company pages the member runs, and a page's totals and followers (rule 663). Results exist only for pages.
      LINKEDIN_GET_COMPANY_INFO: ["start", "count", "state"],
      LINKEDIN_GET_SHARE_STATS: ["organizational_entity", "time_intervals"],
      LINKEDIN_GET_NETWORK_SIZE: ["organization_id", "edgeType"],
      // The page's own views, by day (rule 748): needs the ADMINISTRATOR role and rw_organization_admin, else a 403.
      LINKEDIN_GET_ORG_PAGE_STATS: ["organization", "timeRangeStart", "timeRangeEnd", "timeGranularityType"],
    },
    write: { LINKEDIN_CREATE_LINKED_IN_POST: ["author", "commentary", "visibility", "lifecycleState"] },
  },
  tiktok: {
    provider: "tiktok",
    // TikTok has no managed app on Composio: this auth config carries Thakeen's own TikTok app (plan Task 8).
    authEnv: "COMPOSIO_AUTH_TIKTOK",
    // The account's results (rule 742, social-read/tiktok.ts): its lifetime counts with constant fields and its public
    // videos, at most two pages of 20. Both act on the login's own account: no user or video id is ever sent.
    read: { TIKTOK_GET_USER_STATS: ["fields"], TIKTOK_LIST_VIDEOS: ["max_count", "cursor"] },
    write: { TIKTOK_POST_PHOTO: ["photo_images", "photo_cover_index", "post_mode", "title", "description"] },
    fixed: { TIKTOK_POST_PHOTO: { post_mode: "MEDIA_UPLOAD" } },
  },
  // ---------- drafts only: nothing here reaches a customer or the public ----------
  whatsapp: {
    provider: "whatsapp",
    authEnv: "COMPOSIO_AUTH_WHATSAPP",
    // The WhatsApp Business Account comes from the connection; no waba_id argument is ever sent. No send tool is listed:
    // a template goes to Meta's review and the owner sends it from their own tools.
    read: { WHATSAPP_GET_BUSINESS_ACCOUNT_DETAILS: ["fields"] },
    write: { WHATSAPP_CREATE_MESSAGE_TEMPLATE: ["name", "category", "language", "components", "allow_category_change"] },
  },
  youtube: {
    provider: "youtube",
    authEnv: "COMPOSIO_AUTH_YOUTUBE",
    read: {
      YOUTUBE_LIST_CHANNELS: ["part", "mine", "maxResults"],
      // The channel's results (rule 740): its own analytics (`ids` is always channel==MINE), its latest uploads and those
      // videos' public counts, with constant metrics and parts (social-read/youtube.ts). Read only, like the list above.
      YOUTUBE_QUERY_ANALYTICS: ["ids", "startDate", "endDate", "metrics", "dimensions"],
      YOUTUBE_LIST_CHANNEL_VIDEOS: ["mine", "part", "maxResults"],
      YOUTUBE_GET_VIDEO_DETAILS_BATCH: ["id", "parts"],
    },
    write: { YOUTUBE_UPLOAD_VIDEO: ["title", "description", "tags", "categoryId", "privacyStatus", "videoFilePath"] },
    fixed: { YOUTUBE_UPLOAD_VIDEO: { privacyStatus: "private" } },
  },
  // ---------- read only: ad results (src/lib/connectors/ads-via-composio.ts) ----------
  metaads: {
    provider: "meta_ads",
    authEnv: "COMPOSIO_AUTH_METAADS",
    read: { METAADS_GET_AD_ACCOUNTS: ["fields", "limit"], METAADS_GET_INSIGHTS: ["object_id", "level", "fields", "time_range", "limit", "after"] },
    write: {},
  },
  snapchat: {
    provider: "snapchat",
    authEnv: "COMPOSIO_AUTH_SNAPCHAT",
    read: {
      SNAPCHAT_LIST_ORGANIZATIONS: ["with_ad_accounts"], SNAPCHAT_LIST_ADS_BY_ACCOUNT: ["ad_account_id", "limit", "cursor"], SNAPCHAT_GET_AD_STATS: ["ad_id", "fields", "start_time", "end_time", "granularity"],
      // The ad account's spend over the previous 30 days, one call (rule 733): Snap serves only spend at this level.
      SNAPCHAT_GET_AD_ACCOUNTS_STATS: ["ad_account_id", "fields", "start_time", "end_time", "granularity"],
    },
    write: {},
  },
  googleads: {
    provider: "google_ads",
    authEnv: "COMPOSIO_AUTH_GOOGLEADS",
    // GAQL is a read-only query language; the query text itself is a constant in ads-via-composio.ts, never model text.
    read: { GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS: [], GOOGLEADS_SEARCH_STREAM_GAQL: ["query", "customer_id"] },
    write: {},
  },
  tiktok_ads: {
    provider: "tiktok_ads",
    authEnv: "COMPOSIO_AUTH_TIKTOK_ADS",
    read: { TIKTOK_ADS_GET_ADVERTISER_ACCOUNTS: ["fields"], TIKTOK_ADS_GET_REPORT_INTEGRATED: ["report_type", "advertiser_id", "data_level", "dimensions", "metrics", "start_date", "end_date", "page", "page_size"] },
    write: {},
  },
  // LinkedIn Ads (rule 743, spec C2): the ad accounts at connect time, then one constant analytics call per period and
  // one campaign-name call. Its own LinkedIn app (Advertising API), separate from the page toolkit above.
  linkedin_ads: {
    provider: "linkedin_ads",
    authEnv: "COMPOSIO_AUTH_LINKEDIN_ADS",
    read: {
      LINKEDIN_ADS_SEARCH_AD_ACCOUNTS: ["status", "test", "page_size", "page_token"],
      LINKEDIN_ADS_GET_AD_ACCOUNT: ["ad_account_id"],
      LINKEDIN_ADS_GET_AD_ANALYTICS: ["q", "pivot", "fields", "accounts", "dateRange", "timeGranularity"],
      LINKEDIN_ADS_SEARCH_CAMPAIGNS: ["adAccountId", "pageSize", "pageToken"],
    },
    write: {},
  },
  // ---------- read only: the site's traffic and search (src/lib/site-stats.ts) ----------
  google_analytics: {
    provider: "google",
    authEnv: "COMPOSIO_AUTH_GOOGLE_ANALYTICS",
    read: { GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES: ["pageSize"], GOOGLE_ANALYTICS_RUN_REPORT: ["property", "dateRanges", "dimensions", "metrics", "orderBys", "limit"] },
    write: {},
  },
  google_search_console: {
    provider: "google",
    authEnv: "COMPOSIO_AUTH_GOOGLE_SEARCH_CONSOLE",
    read: { GOOGLE_SEARCH_CONSOLE_LIST_SITES: [], GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY: ["site_url", "start_date", "end_date", "dimensions", "row_limit"] },
    write: {},
  },
  // ---------- read only: reference files for the agent instructions (src/lib/instruction-refs.ts) ----------
  googledocs: {
    provider: "google_workspace",
    authEnv: "COMPOSIO_AUTH_GOOGLEDOCS",
    read: { GOOGLEDOCS_SEARCH_DOCUMENTS: ["query", "max_results"], GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT: ["document_id", "include_tables"] },
    write: {},
  },
  googlesheets: {
    provider: "google_workspace",
    authEnv: "COMPOSIO_AUTH_GOOGLESHEETS",
    read: { GOOGLESHEETS_SEARCH_SPREADSHEETS: ["query", "max_results"], GOOGLESHEETS_VALUES_GET: ["spreadsheet_id", "range"] },
    write: {},
  },
  // ---------- the customer's cloud drives: import into Thakeen, export finished media (src/lib/cloud-drives.ts) ----------
  // Argument names read with `composio tools info` on 2026-10-13 (rule 1775). Google's plain upload takes at most 5 MB,
  // so a video goes through the resumable one.
  googledrive: {
    provider: "google_drive",
    authEnv: "COMPOSIO_AUTH_GOOGLEDRIVE",
    read: { GOOGLEDRIVE_FIND_FILE: ["q", "pageSize"], GOOGLEDRIVE_DOWNLOAD_FILE: ["fileId"] },
    write: { GOOGLEDRIVE_UPLOAD_FILE: ["file_to_upload"], GOOGLEDRIVE_RESUMABLE_UPLOAD: ["file_to_upload"] },
  },
  dropbox: {
    provider: "dropbox",
    authEnv: "COMPOSIO_AUTH_DROPBOX",
    read: { DROPBOX_SEARCH_FILE_OR_FOLDER: ["query", "options"], DROPBOX_READ_FILE: ["path"] },
    write: { DROPBOX_UPLOAD_FILE: ["path", "content", "mode", "autorename"] },
    fixed: { DROPBOX_UPLOAD_FILE: { mode: "add", autorename: true } },
  },
  one_drive: {
    provider: "onedrive",
    authEnv: "COMPOSIO_AUTH_ONEDRIVE",
    read: { ONE_DRIVE_SEARCH_ITEMS: ["q", "top"], ONE_DRIVE_DOWNLOAD_FILE: ["item_id", "file_name"] },
    write: { ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: ["file", "folder", "conflict_behavior"] },
    fixed: { ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: { folder: "/Thakeen", conflict_behavior: "rename" } },
  },
  // ---------- read only: Reem's marketing calendar (src/lib/secretary-gcal-via.ts), next to the direct Google app ----------
  // Argument names read on docs.composio.dev/toolkits/googlecalendar on 2026-10-25. Free/busy and event writes are not listed:
  // Reem works out free time from the synced meetings and does not write events.
  googlecalendar: {
    provider: "gcal",
    authEnv: "COMPOSIO_AUTH_GOOGLECALENDAR",
    read: {
      GOOGLECALENDAR_LIST_CALENDARS: ["min_access_role", "max_results"],
      GOOGLECALENDAR_EVENTS_LIST: ["calendarId", "timeMin", "timeMax", "singleEvents", "orderBy", "maxResults", "fields"],
    },
    write: {},
  },
};

/** Which toolkits each provider connects through, in the order the Integrations card offers them. */
export const PROVIDER_TOOLKITS: Readonly<Record<string, readonly Toolkit[]>> = {
  meta: ["instagram", "facebook"],
  x: ["twitter"],
  linkedin: ["linkedin"],
  tiktok: ["tiktok"],
  whatsapp: ["whatsapp"],
  youtube: ["youtube"],
  meta_ads: ["metaads"],
  snapchat: ["snapchat"],
  google_ads: ["googleads"],
  tiktok_ads: ["tiktok_ads"],
  linkedin_ads: ["linkedin_ads"],
  google: ["google_analytics", "google_search_console"],
  google_workspace: ["googledocs", "googlesheets"],
  google_drive: ["googledrive"],
  dropbox: ["dropbox"],
  onedrive: ["one_drive"],
  gcal: ["googlecalendar"],
};

export const isToolkit = (s: string): s is Toolkit => Object.prototype.hasOwnProperty.call(TOOLKITS, s);
