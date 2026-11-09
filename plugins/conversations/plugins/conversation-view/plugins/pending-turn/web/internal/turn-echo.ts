import { useEffect, useRef } from "react";
import {
  clientLatencySink,
  splitPhases,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import type { LedgerTurn } from "@plugins/conversations/plugins/turn-ledger/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { transcriptShows, turnLineIn } from "./landed";

/**
 * The `turn-echo` samples of one look at a conversation: every turn the
 * agent had taken (`accepted`, `submittedAt` set) whose echo this tab was
 * drawing at the previous look (`watched`: id → `submittedAt` ms) and whose
 * line the window now holds — the moment its "Sending…" goes away. Returns
 * them with the turns still waiting, to watch at the next look.
 *
 * Only a turn seen waiting is sampled: one already shown when the tab first
 * looked says nothing about how long it took. One that leaves the window
 * without its line in it (the window moved past) is dropped, unsampled.
 */
export function turnEchoSamples(
  conversationId: string,
  watched: ReadonlyMap<string, number>,
  rows: readonly Pick<
    LedgerTurn,
    "id" | "kind" | "state" | "submittedAt" | "promptUuid"
  >[],
  events: readonly JsonlEvent[],
  now: number,
): { samples: ClientLatencySample[]; waiting: Map<string, number> } {
  const samples: ClientLatencySample[] = [];
  const waiting = new Map<string, number>();
  for (const row of rows) {
    if (row.state !== "accepted" || row.submittedAt === null) continue;
    const submittedAt = row.submittedAt.getTime();
    if (!transcriptShows(row, events)) {
      waiting.set(row.id, submittedAt);
      continue;
    }
    if (!watched.has(row.id)) continue;
    const line = turnLineIn(row, events);
    if (line === undefined) continue;
    // A prompt folded into a running turn is written when it was QUEUED,
    // before the agent took it: its delivery starts at the taking.
    const writtenAt = Math.max(Date.parse(line.at), submittedAt);
    samples.push({
      signal: "turn-echo",
      key: "jsonl-events",
      params: { id: conversationId },
      variant: row.kind,
      phases: splitPhases("turn-echo", {
        "agent-write": writtenAt - submittedAt,
        delivery: now - writtenAt,
      }),
      totalMs: now - submittedAt,
    });
  }
  return { samples, waiting };
}

/**
 * Emit a `turn-echo` sample each time a taken turn's line reaches this tab
 * (see {@link turnEchoSamples}), measured as the render that shows it
 * commits. Nothing is kept while nobody listens.
 */
export function useTurnEchoLatency(
  conversationId: string,
  rows: readonly LedgerTurn[] | undefined,
  events: readonly JsonlEvent[] | undefined,
): void {
  const watched = useRef(new Map<string, number>());
  useEffect(() => {
    if (rows === undefined || events === undefined) return;
    if (!clientLatencySink.hasSubscribers()) return;
    const { samples, waiting } = turnEchoSamples(
      conversationId,
      watched.current,
      rows,
      events,
      Date.now(),
    );
    watched.current = waiting;
    for (const sample of samples) clientLatencySink.emit(sample);
  }, [conversationId, rows, events]);
}
