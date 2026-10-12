import { type ReactElement } from "react";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { bootTraces, type BootTraceItem } from "../../core";
import { bootProfileDetailPane } from "../panes";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const BOOT_PROFILES_VIEW = defineDataView("debug.boot-profiles");

// The saved snapshots (metadata only — no blob) as a live source: sort, filter
// and search compile to SQL server-side, and a save or the 30-day sweep reaches
// the list through the change feed.
const bootTracesSource = liveDataSource(bootTraces, {
  searchable: ["worktree"],
});

// Browse pane: lists saved snapshots, each row opening the detail pane.
export function BootProfileList(): ReactElement {
  const openPane = useOpenPane();
  return (
    <DataView<BootTraceItem>
      source={bootTracesSource}
      fields={fields}
      views={["list"]}
      storageKey={BOOT_PROFILES_VIEW}
      rowActivation={(r) =>
        openPane.to(bootProfileDetailPane, { id: r.id }, { mode: "push" })
      }
      emptyState={
        <>
          No saved boot traces yet. Use Copy permalink on the Boot Profile page
          to save one.
        </>
      }
    />
  );
}

// Static: every sortable / filterable field's id IS its collection column.
const fields: FieldDef<BootTraceItem>[] = [
  {
    id: "worktree",
    label: "Worktree",
    type: "text",
    value: (r) => r.worktree,
    primary: true,
    sortable: true,
    filterable: true,
  },
  {
    id: "id",
    label: "Id",
    type: "text",
    value: (r) => r.id,
    cell: (r) => (
      <span className="font-mono text-muted-foreground">{r.id}</span>
    ),
    sortable: false,
    filterable: false,
  },
  {
    id: "createdAt",
    label: "When",
    type: "date",
    value: (r) => r.createdAt,
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.createdAt} />
      </span>
    ),
    sortable: true,
    filterable: true,
    align: "end",
  },
];
