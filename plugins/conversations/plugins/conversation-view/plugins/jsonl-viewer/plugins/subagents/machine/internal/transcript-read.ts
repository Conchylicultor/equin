import { readJsonlEventsFromChain } from "@plugins/conversations/plugins/transcript-watcher/server";
import type { WatchTargets } from "@plugins/conversations/plugins/transcript-watcher/server";
import type { SubagentRef, SubagentTranscript } from "../../core";
import {
  findSubagentByAgentId,
  findSubagentIn,
  listWorkflowRuns,
  subagentDirs,
  subagentWatchDirs,
  type SubagentLookup,
} from "./discovery";
import { requestedNameFor } from "./agent-calls";

/**
 * Find one sub-agent of a conversation, by whichever key the surface holds.
 *
 * By agent id there is nothing to join: the id names the files. By call, a
 * resource is handed only a tool-use id, so the name half of the join has to be
 * read back out of the parent's own `Agent` call (`agent-calls.ts`). That lookup
 * is memoized on the parent chain's signature, so it costs one read per parent
 * write, not one per sub-agent append.
 */
async function lookup(
  conversationId: string,
  ref: SubagentRef,
): Promise<SubagentLookup> {
  const dirs = await subagentDirs(conversationId);
  if (ref.by === "agent") return findSubagentByAgentId(dirs, ref.key);
  return findSubagentIn(conversationId, dirs, {
    toolUseId: ref.key,
    requestedName: await requestedNameFor(conversationId, ref.key),
  });
}

/**
 * The files one sub-agent's transcript is read from: exactly one, or none while
 * nothing is (or can be) tied to the card.
 */
export async function transcriptPaths(
  conversationId: string,
  ref: SubagentRef,
): Promise<string[]> {
  const found = await lookup(conversationId, ref);
  return found.kind === "found" ? [found.entry.transcriptPath] : [];
}

/**
 * What to watch for one sub-agent's transcript.
 *
 * While the sub-agent is still starting there is no file to watch, so the room
 * watches the conversation's `subagents/` DIRECTORIES — the only way an event
 * for a file that does not exist yet can reach us at all — including each
 * `workflows/` level below them, since a workflow agent's file is born in its
 * run's folder (`subagentWatchDirs`). Once the file is
 * known its identity is fixed, so the room narrows to that one path and a
 * sibling sub-agent's appends stop waking it.
 */
export async function resolveTranscriptTargets(
  conversationId: string,
  ref: SubagentRef,
): Promise<WatchTargets> {
  const found = await lookup(conversationId, ref);
  if (found.kind === "found") return { paths: [found.entry.transcriptPath] };
  const roots = await subagentDirs(conversationId);
  return {
    paths: [],
    dirs: subagentWatchDirs(roots, await listWorkflowRuns(roots)),
  };
}

/**
 * One sub-agent's transcript, parsed by the SAME reader the main conversation
 * uses — its lines carry `type` / `uuid` / `parentUuid` / `message` exactly like
 * a session transcript, so every existing event renderer already knows how to
 * draw the result.
 *
 * Three-armed, and the two failing arms mean different things to a pane:
 * `unlinked` is "not yet" and resolves itself, `unjoinable` is "never" and must
 * be said out loud rather than spun on.
 */
export async function readSubagentTranscriptIn(
  found: SubagentLookup,
): Promise<SubagentTranscript> {
  if (found.kind === "ambiguous") {
    return { kind: "unjoinable", reason: found.reason };
  }
  if (found.kind === "none") return { kind: "unlinked" };
  return {
    kind: "linked",
    agentId: found.entry.agentId,
    events: await readJsonlEventsFromChain([found.entry.transcriptPath]),
  };
}

/** `readSubagentTranscriptIn`, bound to a conversation's own anchored directories. */
export async function readSubagentTranscript(
  conversationId: string,
  ref: SubagentRef,
): Promise<SubagentTranscript> {
  return readSubagentTranscriptIn(await lookup(conversationId, ref));
}
