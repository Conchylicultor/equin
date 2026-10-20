import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  conversationArtifacts,
  type ArtifactItem,
  type ConversationArtifactSet as WireSet,
} from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/** What the conversation produced — see `ConversationArtifactSet` in core, keyed here by `Map`. */
export interface ConversationArtifactSet {
  /** Items per kind id. A kind that found nothing has no entry. */
  byKind: ReadonlyMap<string, ArtifactItem[]>;
  /** Every artifact, across every kind — what the panel lists. */
  total: number;
  /** What the conversation MADE, per kind id (produced kinds, never a mere read). */
  made: ReadonlyMap<string, number>;
  /** The sum of `made`. */
  count: number;
}

/** What the conversation produced, as a read: loading, failed, or ready. */
export type ConversationArtifactsResult =
  ResourceResult<ConversationArtifactSet>;

function toSet(wire: WireSet): ConversationArtifactSet {
  return {
    byKind: new Map(Object.entries(wire.byKind)),
    total: wire.total,
    made: new Map(Object.entries(wire.made)),
    count: wire.count,
  };
}

/**
 * Everything one conversation made, changed or looked at.
 *
 * Read from a small value the server derives over the WHOLE transcript (every
 * kind's extractor runs there) — the conversation pane itself holds only the
 * latest events, so it could not answer for the rest.
 *
 * The result is a state, never a stand-in: until the server has answered the
 * result is `loading` (and `error` if it cannot be read), so a surface shows
 * that instead of claiming the conversation produced nothing.
 */
export function useConversationArtifacts(
  convId: string,
): ConversationArtifactsResult {
  const wire = useLive(conversationArtifacts, { id: convId });
  return useMemo(() => mapResource(wire, toSet), [wire]);
}
