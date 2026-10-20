import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  agentCallJoin,
  type SubagentActivityRow,
  type DescribedSubagent,
} from "./protocol";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * The name Claude Code gives the sub-agent launcher in a transcript's
 * `tool_use` block.
 *
 * Spelled here rather than imported from the plugin that RENDERS those calls:
 * that plugin's cards ask this one how their sub-agent is going, so importing
 * it back would close a cycle. Both readings in this plugin — the built events
 * below and the server's raw-line name index — read this one constant.
 */
export const AGENT_TOOL_NAME = "Agent";

/** Every `Agent` tool-call in a parent transcript, in transcript order. */
export function agentCallsIn(events: readonly JsonlEvent[]): ToolCallEvent[] {
  return events.filter(
    (e): e is ToolCallEvent =>
      e.kind === "tool-call" && e.name === AGENT_TOOL_NAME,
  );
}

/**
 * The parent's `Agent` call that spawned a sub-agent — the MIRROR of
 * {@link describedSubagent}.
 *
 * `describedSubagent` answers the card's question ("which row is mine?"), asked
 * by a surface that already holds the call. A surface listing every sub-agent of
 * a conversation holds the rows instead and asks the other way round: given this
 * row, which call launched it? Without the call there is no foreground
 * completion signal, so the row's state would fall back to the parent's own
 * liveness and a finished sub-agent would keep reading as running.
 *
 * Same two keys, same order, because the harness writes one or the other:
 *
 * - **tool-use id** — an ordinary sub-agent, whose meta records the id of the
 *   parent's `Agent` tool-use block. Unique by construction.
 * - **name** — a sub-agent spawned WITH a name, which Claude Code records as an
 *   in-process teammate and writes no `toolUseId` for. Its only key is the name
 *   the parent's call asked for (`input.name`, read by `agentCallJoin`).
 *
 * The name path needs no "is this call already claimed by another row" guard,
 * unlike its mirror: an ordinary `Agent` call requests no name at all, so the
 * only candidates are calls that named a teammate — and a named call's teammate
 * never records a tool-use id. It still refuses a name that more than one call
 * requested, for the same reason the mirror does: a name is not an id, and
 * picking either call would put another sub-agent's launch under this row.
 *
 * `undefined` is ordinary, not a failure: an in-process teammate whose parent
 * call has scrolled out of the kept chain, and every undescribed row (an
 * unreadable meta has no key to join on at all), read this way.
 */
export function agentCallForSubagent(
  row: SubagentActivityRow,
  agentCalls: readonly ToolCallEvent[],
): ToolCallEvent | undefined {
  if (row.kind !== "described") return undefined;
  const described: DescribedSubagent = row;

  if (described.toolUseId !== undefined) {
    return agentCalls.find((call) => call.toolUseId === described.toolUseId);
  }
  if (described.name === undefined) return undefined;

  const byName = agentCalls.filter(
    (call) => agentCallJoin(call).requestedName === described.name,
  );
  return byName.length === 1 ? byName[0] : undefined;
}
