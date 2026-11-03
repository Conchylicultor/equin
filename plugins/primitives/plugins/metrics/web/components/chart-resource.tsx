import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  matchResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { ChartState } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/web";

/** The chart body's height, every state included, so the layout never jumps. */
export const CARD_CHART_HEIGHT = 240;

/**
 * A card body over one read: loading and a failure at the chart's own height
 * (the failure through `ResourceErrorInline`, so an out-of-date tab is offered
 * a reload rather than a Retry that cannot help), `ready` once it lands.
 */
export function matchChart<T>(
  result: ResourceResult<T>,
  subject: string,
  ready: (data: T) => ReactNode,
): ReactNode {
  return matchResource(result, {
    loading: () => <ChartState state="loading" height={CARD_CHART_HEIGHT} />,
    error: (error) => (
      <Center
        className="w-full"
        style={{ height: CARD_CHART_HEIGHT }}
        data-chart-state="error"
        role="alert"
      >
        <ResourceErrorInline
          variant="block"
          error={error}
          refetch={result.refetch}
          subject={subject}
        />
      </Center>
    ),
    ready,
  });
}
