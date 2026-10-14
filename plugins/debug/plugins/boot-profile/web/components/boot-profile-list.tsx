import { type ReactElement } from "react";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
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
      overrides={overrides}
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

// How the derived fields present here.
const overrides = fieldOverrides(bootTraces, {
  id: {
    cell: (r) => (
      <span className="font-mono text-muted-foreground">{r.id}</span>
    ),
  },
  createdAt: {
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.createdAt} />
      </span>
    ),
    align: "end",
  },
});
