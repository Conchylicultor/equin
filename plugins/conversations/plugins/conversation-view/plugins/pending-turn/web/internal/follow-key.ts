import { useState } from "react";
import type { TurnKind } from "@plugins/conversations/plugins/turn-ledger/core";

/**
 * Whether a turn of this kind is the user acting — what may pull a reading
 * user back to the bottom of the transcript. A Record, so a new kind must say.
 * An `event` (a watched task started, reported, went quiet) or the agent's own
 * `/compact` arrives with nobody at the keyboard: following it would yank a
 * user reading earlier messages to the bottom every time a task they launched
 * from elsewhere moves. A `launch` prompt exists before the pane does.
 */
const USER_SENT: Record<TurnKind, boolean> = {
  turn: true,
  answer: true,
  "push-and-exit": true,
  launch: false,
  event: false,
  compact: false,
};

/** The newest turn of `turns` (oldest first) the user sent, or null. */
export function latestUserTurnId(
  turns: readonly { id: string; kind: TurnKind }[],
): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (USER_SENT[turn.kind]) return turn.id;
  }
  return null;
}

/**
 * The transcript's `followKey` (`useStickyScroll`): it changes exactly when a
 * turn the user sent appears, never when one retires (its echo handing over to
 * the transcript's line) nor when an automatic turn comes or goes. A count of
 * the cards was both: each moved it, and each re-asserted following.
 */
export function useSentTurnFollowKey(
  turns: readonly { id: string; kind: TurnKind }[],
): string | undefined {
  const latest = latestUserTurnId(turns);
  const [key, setKey] = useState(latest ?? undefined);
  // Adjusting state during render on a new id (React's "storing information
  // from previous renders"): a retired turn (latest back to an older one, or
  // null) keeps the key, so only a newly sent turn moves it.
  const [seen, setSeen] = useState<ReadonlySet<string>>(
    () => new Set(latest === null ? [] : [latest]),
  );
  if (latest !== null && !seen.has(latest)) {
    setSeen(new Set([...seen, latest]));
    setKey(latest);
  }
  return key;
}
