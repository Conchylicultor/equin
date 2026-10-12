import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { claudeCliCallsFor, type ClaudeCliCallsResult } from "../../core";

/**
 * The model calls recorded for one domain record, oldest first — live: a call
 * recorded (or aged out of the log) while the reader watches is pushed to it.
 *
 * Pass `occurredAt` (when the record itself happened) whenever you have it: it is
 * the only thing that lets the server tell `not-retained` from `none`. Omit it and
 * an aged-out call is indistinguishable from one that was never made, and the UI
 * will confidently say the wrong thing. Pass `null` while the record itself is
 * still loading: nothing is read, and the result stays `loading` — rather than
 * asking without `occurredAt` and briefly answering `none`.
 *
 * Render every arm of the result. A consumer that only handles `calls` has
 * re-introduced the collapse the discriminated union exists to prevent.
 */
export function useClaudeCliCalls(
  args: { correlationId: string; occurredAt?: Date } | null,
): ResourceResult<ClaudeCliCallsResult> {
  return useLive(
    claudeCliCallsFor,
    args === null
      ? null
      : {
          correlationId: args.correlationId,
          occurredAt: args.occurredAt?.toISOString(),
        },
  );
}
