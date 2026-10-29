import { useDeploymentShips } from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import type { TabBadge } from "@plugins/primitives/plugins/tabbed-view/web";
import { deploymentSiteMessages } from "../../core";
import { INTAKE_PLUGIN_ID } from "./intake-plugin-id";

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
  return useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID).kind !== "no";
}

/** How far back the Messages tab's badge counts. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Messages tab's badge: accepted messages received in the last 7 days
 * (there is no read/unread state — the count is "what came in this week").
 * Read from the same snapshot the tab and the Overview's Messages card read, so
 * it costs no SSH session of its own beyond the one the page already makes; no
 * badge until that read has answered, and none for a site without the intake.
 */
export function useRecentMessagesBadge({
  deploymentId,
}: {
  deploymentId: string;
}): TabBadge | null {
  const ships = useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID);
  const answer = useLive(
    deploymentSiteMessages,
    ships.kind === "yes" ? { deploymentId } : null,
  );
  // Re-evaluated hourly, so a message ages out of the week without a reload.
  const now = useNow(60 * 60 * 1000);
  const page =
    answer.status === "ready" && answer.data.kind === "messages"
      ? answer.data
      : null;
  if (page === null) return null;
  const since = now - RECENT_MS;
  const count = page.messages.filter(
    (m) => m.verdict === "accepted" && new Date(m.createdAt).getTime() >= since,
  ).length;
  return count > 0 ? { count } : null;
}
