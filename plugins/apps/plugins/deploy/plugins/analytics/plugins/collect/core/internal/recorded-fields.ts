/**
 * What one visit records — the data behind the dashboard's "What one visit
 * records" panel, and the list the server's storage is checked against.
 *
 * Each field names the storage columns (drizzle keys of `analytics_visits` /
 * `analytics_hits`) that hold it. The server asserts at compile time that the
 * union of those columns is EXACTLY the set of stored columns minus row
 * identifiers — so a column added to the tables without a field here, or a
 * field here with no column behind it, is a type error, and the panel cannot
 * drift from what is actually stored.
 */
export const RECORDED_COLUMNS = [
  // timing
  "day",
  "startedAt",
  "lastAt",
  "exitAt",
  "ts",
  // site and pages
  "host",
  "kind",
  "path",
  "entryPath",
  "exitPath",
  "pageviews",
  // source
  "referrerHost",
  "referrerPath",
  "channel",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  // visitor context
  "country",
  "language",
  "device",
  "browser",
  "os",
  // engagement and events
  "engagedMs",
  "exitEngagedMs",
  "events",
  "eventName",
  "eventProps",
  // identity while the visitor keeps returning
  "visitorId",
  "returning",
] as const;
export type RecordedColumn = (typeof RECORDED_COLUMNS)[number];

export interface RecordedField {
  /** Short name as shown in the panel. */
  name: string;
  /** One plain sentence: what it holds. */
  description: string;
  /** Storage columns holding it. */
  columns: readonly RecordedColumn[];
}

export const RECORDED_FIELDS = [
  {
    name: "time",
    description:
      "When the visit started, its last activity, and when each page or event happened (server clock, UTC day)",
    columns: ["day", "startedAt", "lastAt", "exitAt", "ts"],
  },
  {
    name: "site",
    description: "Which site: the hostname the page was served on",
    columns: ["host"],
  },
  {
    name: "kind",
    description: "pageview or event",
    columns: ["kind"],
  },
  {
    name: "path",
    description:
      "Page path with the query string removed; the visit's first and last page, and how many pages it viewed",
    columns: ["path", "entryPath", "exitPath", "pageviews"],
  },
  {
    name: "referrer_host",
    description: "Site they came from",
    columns: ["referrerHost"],
  },
  {
    name: "referrer_path",
    description:
      "The exact page that linked, when the source sends it; query string removed",
    columns: ["referrerPath"],
  },
  {
    name: "channel",
    description:
      "Direct, Search, Social, Referral or Campaign, derived from the two above",
    columns: ["channel"],
  },
  {
    name: "utm_source / medium / campaign",
    description: "Campaign tags on the landing URL",
    columns: ["utmSource", "utmMedium", "utmCampaign"],
  },
  {
    name: "country",
    description:
      "Country of the visitor's network, looked up on the server in a local copy of DB-IP; the IP address itself is not kept",
    columns: ["country"],
  },
  {
    name: "language",
    description: "Browser language, primary tag only",
    columns: ["language"],
  },
  {
    name: "device · browser · os",
    description: "Families only, parsed on the server",
    columns: ["device", "browser", "os"],
  },
  {
    name: "event_name · props",
    description:
      "Custom events the site fires (e.g. improve_open), with up to ten short text props",
    columns: ["eventName", "eventProps", "events"],
  },
  {
    name: "engaged_ms",
    description: "How long each page was visible",
    columns: ["engagedMs", "exitEngagedMs"],
  },
  {
    name: "visitor_id",
    description:
      "A random id, found again on each return through a hash of IP + browser + site + that day's salt, and whether the visit is such a return; forgotten after 30 days without a visit",
    columns: ["visitorId", "returning"],
  },
] as const satisfies readonly RecordedField[];

/** What is never stored, in the panel's words. */
export const NEVER_RECORDED = [
  "IP addresses or the full user-agent string",
  "Cookies, localStorage, or anything left on the visitor's device",
  "Who someone is after 30 days away: older salts are deleted, so a returning visitor gets a new id",
  "Query strings, form input, or page content",
] as const;
