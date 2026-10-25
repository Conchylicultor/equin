import { useMemo, useState } from "react";
import { conversationPartialMessage } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import { standInsOf, type StandIn } from "./streaming-blocks";

/**
 * The message the agent is writing, as stand-ins for the rows it will become
 * (`standInsOf`); a ready `null` when none is being written. `unavailable`
 * when no computer is behind this page (the demo): no agent is writing.
 */
export type StreamingStandIns =
  | ResourceResult<{ messageId: string; standIns: readonly StandIn[] } | null>
  | ResourceUnavailable;

/**
 * When this page first saw message `messageId`: the stand-ins' timestamp,
 * restarted per message.
 */
function useFirstSeenAt(messageId: string | null): string {
  const [seen, setSeen] = useState(() => ({
    messageId,
    at: new Date().toISOString(),
  }));
  if (seen.messageId === messageId) return seen.at;
  // A new message: stamp it now (React re-renders at once with the new state).
  const next = { messageId, at: new Date().toISOString() };
  setSeen(next);
  return next.at;
}

/**
 * The stand-ins of conversation `conversationId`'s streaming message against
 * `events`, the transcript whole — one read for every surface that shows an
 * agent's words as they are written (the transcript's `StreamingMessage`, an
 * agent thread's answer), so they reveal the same blocks at the same moment.
 */
export function useStreamingStandIns(
  conversationId: string,
  events: readonly JsonlEvent[],
): StreamingStandIns {
  const partial = useLive(conversationPartialMessage, { id: conversationId });
  const message = foldResource(partial, {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (data) => data,
    unavailable: () => null,
  });
  const at = useFirstSeenAt(message?.messageId ?? null);
  const standIns = useMemo(
    () => (message ? standInsOf(message, events, at) : []),
    [message, events, at],
  );
  return useMemo(
    () =>
      mapResource(partial, (data) =>
        data === null ? null : { messageId: data.messageId, standIns },
      ),
    [partial, standIns],
  );
}
