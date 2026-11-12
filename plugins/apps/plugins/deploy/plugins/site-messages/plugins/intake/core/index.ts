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
  SPAM_REASONS,
  SPAM_RETENTION_DAYS,
  SiteMessageVerdictSchema,
  SpamReasonSchema,
} from "./internal/record";
export type {
  NotifyState,
  SiteMessageVerdict,
  SpamReason,
} from "./internal/record";
export { sendSiteMessageEndpoint } from "./internal/endpoints";
export { SITE_MESSAGES_MIRROR_SET_ID } from "./internal/mirror-set";
