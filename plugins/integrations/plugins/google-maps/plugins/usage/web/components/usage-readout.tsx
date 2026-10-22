import type { ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useConfigLink } from "@plugins/config_v2/plugins/config-link/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { mapsUsageConfig } from "../../core";
import { useUsageReadout } from "../internal/use-usage-rows";
import {
  USAGE_STATES,
  type UsageRow,
  type UsageState,
} from "../internal/usage-rows";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MAPS_USAGE_VIEW = defineDataView("google-maps.usage");

const NO_ROWS: UsageRow[] = [];

const STATE_LABEL: Record<UsageState, string> = {
  ok: "Within budget",
  near: "Near budget",
  spent: "Spent",
  free: "Free",
};
const STATE_VARIANT = {
  ok: "success",
  near: "warning",
  spent: "destructive",
  free: "muted",
} as const satisfies Record<UsageState, string>;

const FIELDS: FieldDef<UsageRow>[] = [
  {
    id: "label",
    label: "Call",
    type: "text",
    primary: true,
    value: (r) => r.label,
    cell: (r) => (
      <Stack gap="none">
        <Text variant="body" tone="strong" className="truncate">
          {r.label}
        </Text>
        {r.description === undefined ? null : (
          <Text
            variant="caption"
            tone="muted"
            className="truncate"
            title={r.description}
          >
            {r.description}
          </Text>
        )}
      </Stack>
    ),
    width: "minmax(0,1fr)",
  },
  {
    id: "calls",
    label: "This month",
    type: "number",
    value: (r) => r.calls,
    cell: (r) => <UsageMeter row={r} />,
    sortable: true,
    width: "11rem",
  },
  {
    id: "state",
    label: "State",
    type: "enum",
    value: (r) => r.state,
    options: USAGE_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] })),
    cell: (r) => (
      <Badge variant={STATE_VARIANT[r.state]}>{STATE_LABEL[r.state]}</Badge>
    ),
    filterable: true,
    width: "8rem",
  },
];

/**
 * The Google Maps usage pane: this month's Places calls per SKU against their
 * budgets (Google's free allowance minus a margin), live, with when the month
 * resets and a link to the budgets' config. A spent SKU is one its callers
 * have stepped down from (the search drops ratings, a place card its summary).
 */
export function UsageReadout(): ReactElement {
  const readout = useUsageReadout();
  const rows = foldResource(readout, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    ready: (d) => d.rows,
  });
  const resets = foldResource(readout, {
    loading: () => null,
    error: () => null,
    ready: (d) => d.resetsAt,
  });
  const configLink = useConfigLink();
  return (
    <Stack gap="md">
      <Text variant="caption" tone="muted">
        {resets === null
          ? "Places calls this month against Google's free allowance."
          : `Places calls this month against Google's free allowance · resets ${new Date(
              resets,
            ).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })} (Pacific time). When a budget is spent its callers step down to a cheaper call instead of being billed.`}
      </Text>
      <DataView<UsageRow>
        rows={rows}
        fields={FIELDS}
        rowKey={(r) => r.sku}
        storageKey={MAPS_USAGE_VIEW}
        views={["table", "list"]}
        defaultView="table"
        readiness={readout}
        actions={
          <Button
            variant="outline"
            {...activationProps(configLink(mapsUsageConfig))}
          >
            Edit budgets
          </Button>
        }
        emptyState="No Places calls are budgeted."
      />
    </Stack>
  );
}

/** Calls against the budget: a bar and `calls / budget`; a free SKU shows its count. */
function UsageMeter({ row }: { row: UsageRow }): ReactElement {
  if (row.budget === null) {
    return (
      <Text variant="caption" tone="muted">
        {row.calls.toLocaleString()} calls
      </Text>
    );
  }
  const pct =
    row.budget === 0 ? 100 : Math.min(100, (row.calls / row.budget) * 100);
  return (
    <Stack gap="2xs">
      <Clip className="h-1.5 w-full rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            row.state === "spent"
              ? "bg-destructive"
              : row.state === "near"
                ? "bg-warning"
                : "bg-primary",
          )}
          style={{ width: `${row.calls > 0 ? Math.max(pct, 1.5) : 0}%` }}
        />
      </Clip>
      <Text variant="caption" tone="muted">
        {`${row.calls.toLocaleString()} / ${row.budget.toLocaleString()}`}
      </Text>
    </Stack>
  );
}
