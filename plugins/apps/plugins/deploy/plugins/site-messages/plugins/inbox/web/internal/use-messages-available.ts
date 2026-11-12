import {
  useDeploymentShips,
  useShipsGate,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import type { TabBadge } from "@plugins/primitives/plugins/tabbed-view/web";
import { siteMessagesInbox } from "../../core";
import { INTAKE_PLUGIN_ID } from "./intake-plugin-id";
import { useMessagesCopy } from "./use-messages-copy";

/**
 * The section gate: does the deployment's composition ship the intake? `true`
 * while loading (the card shows its own loading state rather than popping in a
 * frame late) and when the answer failed, so the card can show that failure.
 */
export function useMessagesAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  return useShipsGate(deploymentId, INTAKE_PLUGIN_ID);
}

/** How far back the Messages tab's badge counts. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Messages tab's badge: accepted messages received in the last 7 days
 * (there is no read/unread state — the count is "what came in this week"),
 * counted on this computer's copy of the site's messages. No badge until the
 * copy is in place and counted, and none for a site without the intake.
 */
export function useRecentMessagesBadge({
  deploymentId,
}: {
  deploymentId: string;
}): TabBadge | null {
  const ships = useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID);
  const copy = useMessagesCopy(ships.kind === "yes" ? deploymentId : null);
  // Re-evaluated hourly, so a message ages out of the week without a reload.
  const now = useNow(60 * 60 * 1000);
  const since = new Date(now - RECENT_MS).toISOString();
  const recent = useLive(
    siteMessagesInbox,
    copy.kind === "copied"
      ? {
          count: true,
          where: {
            deploymentId,
            verdict: "accepted",
            createdAt: { gte: since },
          },
        }
      : null,
  );
  // No badge while counting or after a failed count (the tab shows that
  // failure); a count of 0 is no badge either.
  return recent.status === "ready" && recent.data > 0
    ? { count: recent.data }
    : null;
}
