import {
  recordReportDebounced,
  DEFAULT_REPORT_DEBOUNCE_MS,
} from "@plugins/reports/plugins/engine/server";
import type { ForeignSessionPayload } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * File a `conversation-foreign-session` report, debounced per
 * `(conversationId, foreignSessionId)`.
 *
 * The debounce is not cosmetic rate-limiting: the caller is the status
 * reconciler's transcript-write listener, which hears every append to the
 * session's file — several times a second while an agent is talking — and the
 * condition stands as long as that session runs. `recordReport` is a DB upsert;
 * without a gate in FRONT of it one such session would put the report engine
 * on the watcher's hot path.
 *
 * `recordReportDebounced` never throws into the caller and never hands it a
 * promise to wait on: a report that cannot be written must not be able to break
 * the watcher's fan-out.
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
