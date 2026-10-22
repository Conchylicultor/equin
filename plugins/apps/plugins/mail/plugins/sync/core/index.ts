export { mailSyncEndpoint, mailHydrateMessageEndpoint } from "./endpoints";
export {
  mailMessageBody,
  type MailMessageBody,
  mailSearch,
  type MailSearchQuery,
  type MailSearchHit,
  type MailSearchRefusal,
  MAIL_SEARCH_MAX_CHARS,
} from "./resources";
export {
  BACKFILL_WINDOW_DAYS,
  MAX_BACKFILL_MESSAGES,
  ATTACHMENT_SCAN_DELTA_WINDOW_DAYS,
  MAX_ATTACHMENT_SCAN_PAGES,
} from "./config";
