import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { agentNotesAuthors, type AgentNotesAuthor } from "../shared/schemas";

/**
 * The conversations that wrote into one agent-notes card, oldest-first — the
 * collection's declared order (`createdAt`, then `conversationId`), which a
 * scoped set holds its rows in.
 *
 * "Not loaded yet" stays its own state: the caller decides what a card whose
 * provenance has not arrived shows, rather than reading it as "no recorded
 * author".
 */
export function useAgentNotesAuthors(
  blockId: string,
): ResourceResult<AgentNotesAuthor[]> {
  return useLive(agentNotesAuthors, { where: { blockId } });
}

/**
 * The conversation that wrote into `blockId` FIRST — the block's creator, when
 * the block is one an agent brings into being (an agent-authored page) — or
 * `null` once the authorship has loaded and holds nobody.
 *
 * "Not loaded yet" is its own state: a chip that NAMES the creator cannot stand
 * in "nobody" for "not known yet", since that is a claim about the block that
 * then reverses itself.
 *
 * The first record of the value, which arrives oldest-first (see above).
 */
export function useAgentNotesCreator(
  blockId: string,
): ResourceResult<AgentNotesAuthor | null> {
  const result = useAgentNotesAuthors(blockId);
  return useMemo(
    () => mapResource(result, (authors) => authors[0] ?? null),
    [result],
  );
}
