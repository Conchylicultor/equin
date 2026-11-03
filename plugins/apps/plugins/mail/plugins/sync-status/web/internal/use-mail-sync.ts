import {
  deriveMailSyncView,
  mailSyncState,
  type MailSyncView,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";

/**
 * The single, user-facing mail-sync view for the banner and the rail dot.
 * Subscribes to the live `mail_sync_state` rows and folds them through the
 * shared pure aggregator so the displayed phase can never drift from the
 * recorded state. A resource result, so a consumer cannot read a view before
 * one exists — and a failed read reaches it as a failure, not as silence.
 */
export function useMailSyncState(): ResourceResult<MailSyncView> {
  return mapResource(useLive(mailSyncState), deriveMailSyncView);
}
