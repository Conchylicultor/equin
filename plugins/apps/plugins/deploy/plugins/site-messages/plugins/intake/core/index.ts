export { siteMessageIdKind } from "./internal/id-kinds";
export type { SiteMessageId } from "./internal/id-kinds";
export { RESEND_API_KEY } from "./internal/secret";
export {
  MAX_MESSAGE_LENGTH,
  MAX_REPLY_TO_LENGTH,
  MAX_SITE_MESSAGE_BODY_BYTES,
  MIN_HUMAN_ELAPSED_MS,
  SiteMessageBodySchema,
  SiteMessageResponseSchema,
} from "./internal/message";
export type { SiteMessageBody, SiteMessageResponse } from "./internal/message";
export {
  NOTIFY_STATES,
  NotifyStateSchema,
  SITE_MESSAGE_VERDICTS,
  SITE_MESSAGES_PAGE_DEFAULT,
  SITE_MESSAGES_PAGE_MAX,
  SPAM_REASONS,
  SPAM_RETENTION_DAYS,
  SiteMessageRecordSchema,
  SiteMessageVerdictSchema,
  SiteMessagesListQuerySchema,
  SiteMessagesPageSchema,
  SpamReasonSchema,
} from "./internal/record";
export type {
  NotifyState,
  SiteMessageRecord,
  SiteMessageVerdict,
  SiteMessagesListQuery,
  SiteMessagesPage,
  SpamReason,
} from "./internal/record";
export {
  sendSiteMessageEndpoint,
  siteMessagesListEndpoint,
  siteMessagesListPath,
} from "./internal/endpoints";
