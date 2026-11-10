import { useEffect, useState } from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { Hint } from "../../core";
import { requestTipFrom, withdrawTipFrom } from "./engine-store";
import { useHintSeen, useMarkHintSeen } from "./seen";
import { holdLedger, updateLedger } from "./seen-ledger";

/**
 * Asks to show `hint` while `when` holds. The host shows it once its seen state
 * is known and unseen, its anchor is on the page and no tour runs — after the
 * settle window, lowest `order` first, one at a time. `when` turning false (or
 * the component unmounting) withdraws it without marking it seen.
 *
 * Several components may hold one hint's moment (every chip of a kind): the
 * request stays while ANY holds it, and is withdrawn when the last lets go.
 * `hint` may be absent — a generic component handed an optional tip asks nothing.
 *
 * The seen state is the one of the server the moment renders against: the
 * moment reads it (`useHintSeen`) and hands the host the write
 * (`useMarkHintSeen`) as its scope's ledger. Inside a `<PluginScope>` (the
 * demo's embedded app) both go to that scope's worker, and the request and its
 * anchor are keyed by the scope — so a demo visitor's tip is remembered inside
 * the demo, never in the page user's hints. Read from where the moment
 * renders, so no caller can forget it.
 */
export function useHintMoment(
  hint: Hint | null | undefined,
  when: boolean,
): void {
  const scope = usePluginScopeId();
  const seen = foldResource(useHintSeen(), {
    ready: (rows) => rows,
    loading: () => null,
    error: () => null,
  });
  const mark = useMarkHintSeen();
  const [holder] = useState(() => Symbol("hint-moment"));
  const asking = !!hint && when;
  // Held while asking, then filled — and refilled in place as the seen rows
  // move (declared in this order, so a new hold is filled in the same commit).
  useEffect(
    () => (asking ? holdLedger(scope, holder) : undefined),
    [asking, scope, holder],
  );
  useEffect(() => {
    if (asking) updateLedger(scope, holder, { seen, mark });
  }, [asking, scope, holder, seen, mark]);
  useEffect(() => {
    if (!hint || !when) return;
    requestTipFrom(scope, hint);
    return () => withdrawTipFrom(scope, hint);
  }, [hint, when, scope]);
}
