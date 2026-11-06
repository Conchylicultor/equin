import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  type ResourceUnavailable,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useConversation } from "@plugins/conversations/web";
import {
  opsInFlight,
  type OpRow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { OP_KINDS } from "@plugins/infra/plugins/worktree/core";
import { opsOfSlug, slugOf } from "./op-lines";

/**
 * Every in-flight op on the host — the ONE param-less `opsInFlight` (`all`)
 * subscription the banner and every sidebar chip share (it is boot-preloaded,
 * so it paints settled). Callers filter by slug on the client. The ops are
 * this machine's (`needsMachine`): under a host without the computer the read
 * is `unavailable` — its own arm, never an empty "nothing in flight".
 *
 * Only the kinds that read as their conversation working
 * (`OP_KINDS[kind].readsAsWorking`): a plain script run is an op in the op log
 * and the Ops views, but a watcher left running must not hold its
 * conversation's banner and chip on "working" for as long as it lives.
 */
export function useOpsInFlight():
  ResourceResult<OpRow[]> | ResourceUnavailable {
  const ops = useLive(opsInFlight);
  return useMemo(
    () =>
      mapResource(ops, (rows) =>
        rows.filter((r) => OP_KINDS[r.kind].readsAsWorking),
      ),
    [ops],
  );
}

/**
 * What a conversation's worktree shows right now: its highest-ranked in-flight
 * op. A read rather than a nullable op, so "the ops have not loaded yet" (or
 * failed to) can never reach a caller as "idle": a ready `null` is a settled
 * answer. An unknown conversation (ready, no row) has no worktree to key on, so
 * it reads as ready with no op. `unavailable` passes through from the ops.
 */
export function useWorktreeOp(
  conversationId: string,
): ResourceResult<OpRow | null> | ResourceUnavailable {
  const conv = useConversation(conversationId);
  const ops = useOpsInFlight();
  return useMemo(
    () =>
      mapResource(combineResources({ conv, ops }), (d) =>
        d.conv
          ? (opsOfSlug(d.ops, slugOf(d.conv.worktreePath))[0] ?? null)
          : null,
      ),
    [conv, ops],
  );
}
