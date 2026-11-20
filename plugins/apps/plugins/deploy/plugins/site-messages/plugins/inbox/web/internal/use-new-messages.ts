import { useCallback } from "react";
import { useDeploymentShips } from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive, type LiveRowResult } from "@plugins/network/plugins/live/web";
import { siteMessagesInbox } from "../../core";
import { markSiteMessagesSeen, siteMessagesSeen } from "../../shared";
import { INTAKE_PLUGIN_ID } from "./intake-plugin-id";
import { useMessagesCopy } from "./use-messages-copy";

/**
 * How many messages a site received since the user last opened its Messages
 * tab — what {@link useNewMessagesCount} answers:
 *
 * - `loading` — any of the reads it depends on is still out;
 * - `error` — one failed (`refetch` retries it);
 * - `no-intake` — the deployment's composition does not ship the intake: the
 *   site takes no messages, so there is nothing to count (not zero);
 * - `not-copied` — no whole copy of its messages here yet (`syncing` while a
 *   pull is asked for): a pending state, never zero;
 * - `ready` — `count` accepted messages received after the seen mark (every
 *   accepted message when the tab was never opened). Spam is never new.
 */
export type NewMessagesCount =
  | { kind: "loading" }
  | { kind: "error"; error: Error; refetch: () => Promise<void> }
  | { kind: "no-intake" }
  | { kind: "not-copied"; syncing: boolean }
  | { kind: "ready"; count: number };

/**
 * What "new" starts after, as a filter on `createdAt`: every message when the
 * tab was never opened (no row), else those received after the mark. `null`
 * while the mark is not known — loading, or failed (reported by the caller).
 */
function afterMark(
  seen: LiveRowResult<{ seenAt: Date }>,
): { createdAt?: { gt: string } } | null {
  switch (seen.status) {
    case "loading":
    case "error":
      return null;
    case "ready":
      return seen.found
        ? { createdAt: { gt: seen.row.seenAt.toISOString() } }
        : {};
  }
}

/**
 * The live count of a site's new messages (see {@link NewMessagesCount}),
 * counted on this computer's copy of the site's messages after its seen mark
 * (`deploy-site-messages.seen`), so it moves when a sync brings a message and
 * when the Messages tab is opened. Pushed; no request of its own.
 */
export function useNewMessagesCount(deploymentId: string): NewMessagesCount {
  const ships = useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID);
  const copy = useMessagesCopy(ships.kind === "yes" ? deploymentId : null);
  const seen = useLive(siteMessagesSeen, { id: deploymentId });
  const after = afterMark(seen);
  const counted = useLive(
    siteMessagesInbox,
    copy.kind === "copied" && after !== null
      ? {
          count: true,
          where: { deploymentId, verdict: "accepted", ...after },
        }
      : null,
  );
  switch (ships.kind) {
    case "pending":
      return { kind: "loading" };
    case "failed":
      return { kind: "error", error: ships.error, refetch: ships.refetch };
    case "no":
      return { kind: "no-intake" };
    case "yes":
      break;
  }
  if (copy.kind === "loading") return { kind: "loading" };
  if (copy.kind === "error") return copy;
  if (copy.kind === "not-copied")
    return { kind: "not-copied", syncing: copy.syncing };
  if (seen.status === "loading") return { kind: "loading" };
  if (seen.status === "error")
    return { kind: "error", error: seen.error, refetch: seen.refetch };
  switch (counted.status) {
    case "loading":
      return { kind: "loading" };
    case "error":
      return {
        kind: "error",
        error: counted.error,
        refetch: counted.refetch,
      };
    case "ready":
      return { kind: "ready", count: counted.data };
  }
}

/**
 * Mark a site's messages seen, up to its copy's clock — called when the
 * Messages tab shows the list. The mark only moves forward; its answer is the
 * pushed seen mark (and so the new-messages count), not this call's.
 */
export function useMarkMessagesSeen(deploymentId: string): () => void {
  const mark = useEndpointMutation(markSiteMessagesSeen);
  const { mutate } = mark;
  return useCallback(
    () => mutate({ params: { id: deploymentId } }),
    [mutate, deploymentId],
  );
}
