import type { ReactNode } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { AnalyticsDashboard } from "./analytics-dashboard";
import { useShipsAnalytics } from "../internal/use-analytics-available";

/**
 * The section body. It waits on the same answer as the availability gate, so
 * the dashboard — and its SSH request — starts only once the deployment is
 * known to ship analytics; an answer that could not be read says so, with
 * Retry. (On `no` the gate has already removed the card.)
 */
export function AnalyticsSection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const ships = useShipsAnalytics(deploymentId);
  switch (ships.kind) {
    case "pending":
      return <Loading variant="rows" count={3} />;
    case "failed":
      return (
        <ResourceErrorInline
          variant="block"
          subject="whether this deployment ships analytics"
          error={ships.error}
          refetch={ships.refetch}
        />
      );
    case "yes":
      return <AnalyticsDashboard deploymentId={deploymentId} />;
    // The gate removes the card on `no`; a frame between the two renders
    // nothing rather than a spinner for a card that is going away.
    case "no":
      return null;
  }
}
