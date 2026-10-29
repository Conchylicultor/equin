import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { formatByteSize } from "@plugins/fields/plugins/byte-size/core";
import { depsStates, type DepRow, type DepState } from "../../core";
import { DepItemActions } from "./dep-item-actions";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const DEPENDENCIES_VIEW = defineDataView("infra.deps.dependencies");

const NO_ROWS: DepRow[] = [];

const STATE_LABEL: Record<DepState["kind"], string> = {
  absent: "Not installed",
  installing: "Installing",
  ready: "Ready",
  failed: "Failed",
};

const STATE_BADGE = {
  absent: "muted",
  installing: "info",
  ready: "success",
  failed: "destructive",
} as const satisfies Record<DepState["kind"], string>;

/** The measured size on disk, once installed; unknown (null) before. */
function sizeBytes(row: DepRow): number | null {
  return row.state.kind === "ready" ? row.state.bytes : null;
}

/** The latest line worth showing: the install's log tail, or the failure. */
function detailText(row: DepRow): string {
  switch (row.state.kind) {
    case "installing":
      return row.state.logTail.at(-1) ?? "starting…";
    case "failed":
      return row.state.message.split("\n")[0] ?? "";
    case "ready":
      return `identity ${row.state.identity}`;
    case "absent":
      return row.description;
  }
}

/**
 * Settings → Dependencies: every declared optional dependency with its state
 * on this machine. Pushed live (`deps.states`), so an install started here or
 * from a terminal shows `installing` → `ready` without a reload.
 */
export function DependenciesView() {
  const result = useLive(depsStates);
  const rows = foldResource(result, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    ready: (d) => d,
  });

  const fields = useMemo<FieldDef<DepRow>[]>(
    () => [
      {
        id: "id",
        label: "Dependency",
        type: "text",
        primary: true,
        value: (r) => r.id,
        cell: (r) => <span className="font-mono">{r.id}</span>,
        sortable: true,
        width: "minmax(0,1fr)",
      },
      {
        id: "state",
        label: "State",
        type: "enum",
        value: (r) => r.state.kind,
        options: (Object.keys(STATE_LABEL) as DepState["kind"][]).map(
          (value) => ({ value, label: STATE_LABEL[value] }),
        ),
        cell: (r) => (
          <Badge variant={STATE_BADGE[r.state.kind]}>
            {STATE_LABEL[r.state.kind]}
          </Badge>
        ),
        sortable: true,
        filterable: true,
        width: "8rem",
      },
      {
        id: "detail",
        label: "Detail",
        type: "text",
        value: detailText,
        cell: (r) => (
          <span className="truncate text-muted-foreground">
            {detailText(r)}
          </span>
        ),
        width: "minmax(0,2fr)",
      },
      {
        id: "kind",
        label: "Kind",
        type: "text",
        value: (r) => `${r.kind}: ${r.source}`,
        cell: (r) => (
          <span className="truncate text-muted-foreground">{r.kind}</span>
        ),
        sortable: true,
        filterable: true,
        width: "6rem",
      },
      {
        id: "size",
        label: "Size",
        type: "byte-size",
        value: sizeBytes,
        // Measured once installed; before, the declaration's own estimate
        // ("≈15 MB"), which sorts and filters as no size.
        cell: (r) => {
          const bytes = sizeBytes(r);
          return (
            <span className="tabular-nums text-muted-foreground">
              {bytes === null ? r.sizeHint : formatByteSize(bytes)}
            </span>
          );
        },
        sortable: true,
        width: "6rem",
      },
      {
        id: "lastUsed",
        label: "Last used",
        type: "date",
        value: (r) =>
          r.state.kind === "ready" && r.state.lastUsed !== null
            ? new Date(r.state.lastUsed)
            : null,
        cell: (r) =>
          r.state.kind === "ready" && r.state.lastUsed !== null ? (
            <span className="text-muted-foreground">
              <RelativeTime date={new Date(r.state.lastUsed)} />
            </span>
          ) : null,
        sortable: true,
        width: "7rem",
      },
    ],
    [],
  );

  return (
    <DataView<DepRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.id}
      views={["table", "list"]}
      storageKey={DEPENDENCIES_VIEW}
      readiness={result}
      itemActions={DepItemActions}
      searchAccessor={(r) => `${r.id} ${r.description} ${r.owner}`}
      emptyState={<>No optional dependency is declared.</>}
    />
  );
}
