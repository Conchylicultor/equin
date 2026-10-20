import { useEffect, useMemo, useState } from "react";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { useConversationSubagents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import { useConversationShells } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web";
import type { BackgroundShell } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import {
  nextLingerExpiry,
  visibleAgentRows,
  type BandSource,
  type RunningAgentRow,
} from "../internal/agent-rows";

/**
 * What the band knows about this conversation's sub-agents and background
 * shells right now.
 *
 * `pending` is a real arm: "how many agents are working" is answered from the
 * sub-agent files AND the parent transcript (and the shells from that
 * transcript), so until every read has arrived there is no honest answer — and an empty band is a claim ("none are working") that
 * would then reverse itself the moment the reads land.
 */
export type RunningAgentsState =
  | { kind: "pending" }
  /** A read behind the band FAILED — rendered with Retry, never as "none working". */
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  /**
   * This host cannot watch sub-agents (an in-browser server). Not "none
   * working" — nothing here can tell — so the band is hidden, shells too:
   * a band of shells alone would read as "no agents running".
   */
  | { kind: "unavailable" }
  | { kind: "known"; rows: RunningAgentRow[] };

const NOTHING: Omit<BandSource, "shells"> = { entries: [], workflowRuns: [] };
const NO_SHELLS: readonly BackgroundShell[] = [];

/**
 * The sub-agents to show above the prompt box: every one still running, plus
 * the ones that stopped moments ago and are still saying so, plus the
 * ancestors of both — a workflow run's row among them (see `visibleAgentRows`).
 *
 * Run state is NOT derived here. It comes from the subagents plugin, which owns
 * the three-armed answer (running / finished / ended without reporting) and
 * reads it from what each sub-agent and its parent actually wrote — and, for a
 * background shell, from the background-shells plugin's fold.
 *
 * The linger needs one thing the pushed data cannot provide: a re-render at the
 * moment a row's three seconds are up. That is one `setTimeout` to the next
 * expiry — a presentational timer, not a poll. An expiry already behind the
 * real clock (the rows changed under a stale reading of it) fires at once.
 */
export function useRunningAgents(
  conversationId: string,
  showAll: boolean,
): RunningAgentsState {
  const subagents = useConversationSubagents(conversationId);
  const shellRead = useConversationShells(conversationId);
  const { entries, workflowRuns } =
    subagents.kind === "known" ? subagents : NOTHING;
  const shells = shellRead.kind === "known" ? shellRead.shells : NO_SHELLS;

  // The instant the linger is measured against.
  const [now, setNow] = useState(() => Date.now());
  const rows = useMemo(
    () => visibleAgentRows({ entries, workflowRuns, shells }, now, { showAll }),
    [entries, workflowRuns, shells, now, showAll],
  );

  useEffect(() => {
    const expiry = nextLingerExpiry(rows, now);
    if (expiry === null) return;
    const id = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(id);
  }, [rows, now]);

  // Failed wins over pending: a read that failed will not arrive by waiting.
  if (subagents.kind === "failed") return subagents;
  if (shellRead.kind === "failed") return shellRead;
  if (subagents.kind === "unavailable") return { kind: "unavailable" };
  if (subagents.kind === "pending" || shellRead.kind === "pending") {
    return { kind: "pending" };
  }
  return { kind: "known", rows };
}
