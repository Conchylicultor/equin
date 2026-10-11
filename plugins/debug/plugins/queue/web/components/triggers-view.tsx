import { useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  eventTriggers,
  type TriggerRow,
} from "@plugins/infra/plugins/events/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FieldDef,
  ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useQueueActions } from "../internal/actions";
import { compactJson } from "../internal/format";
import { JobBadge, WhenText } from "./cells";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const TRIGGERS_VIEW = defineDataView("debug.queue.triggers");

const deleteIcon = symbol("delete");

/** The Triggers list's per-row actions: the enable switch (at rest) and Delete. */
export const TriggersItemActions = defineItemActions<TriggerRow>();

/** Enable / disable the trigger — painted at rest, so the state reads at a glance. */
export function TriggerEnabledAction({ row }: ItemActionProps<TriggerRow>) {
  const actions = useQueueActions();
  return (
    <Switch
      checked={row.enabled}
      aria-label={row.enabled ? "Disable trigger" : "Enable trigger"}
      onCheckedChange={(next) => {
        void actions.setTriggerEnabled(row.id, next);
      }}
    />
  );
}

export function DeleteTriggerAction({ row }: ItemActionProps<TriggerRow>) {
  const actions = useQueueActions();
  return (
    <IconButton
      icon={deleteIcon}
      label="Delete trigger"
      onClick={() => actions.deleteTrigger(row.id)}
    />
  );
}

/** A trigger's filters as `key value` badges; `any` when it has none. */
export function TriggerFilters({
  filters,
}: {
  filters: TriggerRow["filters"];
}) {
  const entries = Object.entries(filters);
  if (entries.length === 0) return <Text tone="faint">any</Text>;
  return (
    <Cluster gap="2xs">
      {entries.map(([key, value]) => (
        <Badge key={key} mono>
          {key}={value === null ? "*" : JSON.stringify(value)}
        </Badge>
      ))}
    </Cluster>
  );
}

/**
 * Debug → Queue's Triggers section: every active subscription across every
 * registered event (the `eventTriggers` value — a union over one table per
 * event, so a value rather than a collection).
 */
export function TriggersView({
  selectedId,
  linkTo,
}: {
  selectedId?: string;
  linkTo: (id: string) => LinkTarget;
}) {
  const result = useLive(eventTriggers);
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready read's rows reach the view.
  const rows = foldResource(result, {
    loading: () => NO_TRIGGERS,
    error: () => NO_TRIGGERS,
    ready: (d) => d,
  });
  const fields = useMemo(() => buildFields(rows), [rows]);
  return (
    <DataView<TriggerRow>
      storageKey={TRIGGERS_VIEW}
      fields={fields}
      views={["table", "list"]}
      defaultView="table"
      rows={rows}
      readiness={result}
      rowKey={(r) => r.id}
      searchAccessor={(r) =>
        [r.eventName, r.jobName, r.id, compactJson(r.filters)].join(" ")
      }
      searchPlaceholder="Search triggers…"
      selectedRowId={selectedId}
      rowActivation={(r) => linkTo(r.id)}
      rowTone={(r) => (r.enabled ? "default" : "muted")}
      itemActions={TriggersItemActions}
      emptyState={<>No active triggers.</>}
    />
  );
}

const NO_TRIGGERS: readonly TriggerRow[] = [];

function buildFields(rows: readonly TriggerRow[]): FieldDef<TriggerRow>[] {
  const options = (values: string[]) =>
    [...new Set(values)].sort().map((v) => ({ value: v, label: v }));
  return [
    {
      id: "eventName",
      label: "Event",
      type: "enum",
      value: (r) => r.eventName,
      options: options(rows.map((r) => r.eventName)),
      cell: (r) => (
        <Text variant="code" title={r.eventName}>
          {r.eventName}
        </Text>
      ),
      sortable: true,
      filterable: true,
      width: "minmax(8rem,14rem)",
    },
    {
      id: "jobName",
      label: "Job",
      type: "enum",
      value: (r) => r.jobName,
      options: options(rows.map((r) => r.jobName)),
      cell: (r) => (
        <Inline gap="xs">
          <JobBadge name={r.jobName} />
          {r.dangling && <Badge variant="destructive">dangling</Badge>}
        </Inline>
      ),
      primary: true,
      sortable: true,
      filterable: true,
      width: "minmax(8rem,16rem)",
    },
    {
      id: "filters",
      label: "Filters",
      type: "text",
      value: (r) => compactJson(r.filters),
      cell: (r) => <TriggerFilters filters={r.filters} />,
      sortable: false,
      filterable: false,
      width: "minmax(0,1fr)",
    },
    {
      id: "jobWith",
      label: "Job input",
      type: "text",
      value: (r) => compactJson(r.jobWith),
      cell: (r) => (
        <Text variant="code" tone="muted">
          {compactJson(r.jobWith)}
        </Text>
      ),
      sortable: false,
      filterable: false,
      width: "minmax(0,1fr)",
    },
    {
      id: "oneShot",
      label: "One-shot",
      header: false,
      type: "bool",
      value: (r) => r.oneShot,
      cell: (r) => (r.oneShot ? <Badge variant="info">one-shot</Badge> : null),
      sortable: false,
      filterable: true,
      width: "max-content",
    },
    {
      id: "createdAt",
      label: "Created",
      type: "date",
      value: (r) => new Date(r.createdAt),
      cell: (r) => <WhenText date={new Date(r.createdAt)} prefix="Created" />,
      sortable: true,
      filterable: true,
      align: "end",
      width: "5.5rem",
    },
    {
      id: "enabled",
      label: "Enabled",
      type: "bool",
      value: (r) => r.enabled,
      sortable: true,
      filterable: true,
      visible: false,
    },
    {
      id: "dangling",
      label: "Dangling",
      type: "bool",
      value: (r) => r.dangling,
      sortable: true,
      filterable: true,
      visible: false,
    },
  ];
}
