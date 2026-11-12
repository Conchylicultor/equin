import type { ReactNode } from "react";
import type { AnalyticsFilter } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { HostQueryErrorState } from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import type { DeploymentAnalyticsResult } from "../../core";
import { DIMENSION_LABEL } from "../internal/format";

/** collect's refusal of a question: named for what to do, never an empty dashboard. */
export type Refusal = Extract<DeploymentAnalyticsResult, { kind: "refused" }>;

/**
 * The dashboard's body for a refused question (collect's own answer), with the
 * one change that makes it answerable. A copy that is not readable yet is not
 * a refusal: the caller renders it as loading.
 */
export function ResultState({
  result,
  filters,
  onKeepFirstFilter,
  onVisitorsOnly,
}: {
  result: Refusal;
  filters: readonly AnalyticsFilter[];
  onKeepFirstFilter: () => void;
  /** Back to the default audience — the one the stored totals hold. */
  onVisitorsOnly: () => void;
}): ReactNode {
  if (result.reason === "audience-beyond-raw-window") {
    return (
      <HostQueryErrorState
        title={`Past the last ${result.rawWindowDays} days only visitors are kept — your own visits are left out of the stored totals.`}
      >
        <Button variant="outline" onClick={onVisitorsOnly}>
          Show visitors
        </Button>
      </HostQueryErrorState>
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
