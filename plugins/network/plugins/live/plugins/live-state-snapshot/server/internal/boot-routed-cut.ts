import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import {
  feedCut,
  feedListening,
} from "@plugins/network/plugins/live/plugins/change-feed/server";
import { createRoutedCut } from "./routed-cut";
import { snapshotLog as log } from "./log-sink";

// This backend's routed cut (`./routed-cut`): refused until `onReady`'s boot
// catch-up has routed the changelog behind the LISTEN session.
export const bootRoutedCut = createRoutedCut(feedCut);

// How long `onReady` waits for change-feed's LISTEN session before the replay
// reads (the epoch handoff's own budget): a commit between the replay's read
// and the session is routed by neither.
const LISTENING_BUDGET_MS = 5_000;

/** Whether the LISTEN session came up before the replay reads. */
export type ListeningForReplay =
  { kind: "listening" } | { kind: "not-listening"; reason: string };

/**
 * Wait (bounded) for change-feed's LISTEN session — its `onReady` only
 * STARTED it. Past the budget it is logged: the replay then runs anyway, as
 * before, and no alias floor is advanced this process.
 */
export async function awaitListeningForReplay(): Promise<ListeningForReplay> {
  try {
    await withDeadline(
      feedListening(),
      LISTENING_BUDGET_MS,
      () => new Error(`no LISTEN session within ${LISTENING_BUDGET_MS} ms`),
    );
    return { kind: "listening" };
  } catch (err) {
    // `feedListening` never rejects: the only error is the deadline's.
    log.publish(
      `[live-state-snapshot] WARNING: ${String(err)} — replaying anyway; no persisted alias floor is advanced this process`,
      "stderr",
    );
    return { kind: "not-listening", reason: String(err) };
  }
}
