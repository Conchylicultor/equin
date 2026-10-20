import {
  recordReportDebounced,
  DEFAULT_REPORT_DEBOUNCE_MS,
} from "@plugins/reports/server";
import type { ForeignSessionPayload } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * File a `conversation-foreign-session` report, debounced per
 * `(conversationId, foreignSessionId)`.
 *
 * The debounce is not cosmetic rate-limiting: the caller is
 * `resolveConversationTranscriptPaths`, which runs on every transcript read and
 * on every live push of an active conversation — several times a second while an
 * agent is talking — and a corrupt chain stays corrupt, so the condition is
 * persistent. `recordReport` is a DB upsert; without a gate in FRONT of it a
 * single corrupted chain would put the report engine on the hot read path.
 *
 * `recordReportDebounced` never throws into the caller and never hands it a
 * promise to wait on: a report that cannot be written must not be able to break
 * reading a conversation.
 */
export function reportForeignSession(payload: ForeignSessionPayload): void {
  recordReportDebounced(
    `conversation-foreign-session ${payload.conversationId} ${payload.foreignSessionId}`,
    DEFAULT_REPORT_DEBOUNCE_MS,
    {
      kind: "conversation-foreign-session",
      source: "server-transcript-watcher",
      data: { ...payload },
      message:
        `${payload.conversationId} has a foreign session ` +
        `${payload.foreignSessionId} in its chain (${payload.reason})`,
    },
  );
}
