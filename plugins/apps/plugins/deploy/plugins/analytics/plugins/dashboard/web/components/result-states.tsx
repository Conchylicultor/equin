import type { ReactNode } from "react";
import type { AnalyticsFilter } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  HostQueryErrorState,
  HostQueryFailureState,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import type { DeploymentAnalyticsResult } from "../../core";
import { DIMENSION_LABEL } from "../internal/format";

/** Every answer that is not a report. */
export type NonReport = Exclude<DeploymentAnalyticsResult, { kind: "report" }>;

const ANALYTICS_SUBJECT: HostQuerySubject = {
  reading: "analytics",
  answer: "an analytics report",
};

/**
 * The dashboard's body for every answer that is not a report. Each is named
 * for what failed and what to do — none of them renders as an empty dashboard.
 * The SSH / request failures speak host-query's shared vocabulary; `refused`
 * is collect's own answer.
 */
export function ResultState({
  result,
  filters,
  onKeepFirstFilter,
}: {
  result: NonReport;
  filters: readonly AnalyticsFilter[];
  onKeepFirstFilter: () => void;
}): ReactNode {
  if (result.kind !== "refused") {
    return (
      <HostQueryFailureState failure={result} subject={ANALYTICS_SUBJECT} />
    );
  }
  const first = filters[0];
  return (
    <HostQueryErrorState
      title={`This range reaches past the last ${result.rawWindowDays} days, where only single filters are kept — at most ${result.maxFilters} filter applies.`}
    >
      {first && (
        <Button variant="outline" onClick={onKeepFirstFilter}>
          Keep only “{DIMENSION_LABEL[first.dimension]} is {first.value}”
        </Button>
      )}
    </HostQueryErrorState>
  );
}
