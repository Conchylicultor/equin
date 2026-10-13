import { type ReactElement } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { captureHeapSnapshot } from "../../shared/endpoints";
import type { HeapStats } from "../../shared/endpoints";
import { heapStatsValue } from "../../shared/resources";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

type TypeRow = HeapStats["types"][number];

// Sortable type → count table. Defaults to count-desc (already server-sorted);
// DataTable owns the sort state via the `value` accessors.
const COLUMNS: ColumnDef<TypeRow>[] = [
  { id: "type", header: "Object type", value: (r) => r.type },
  {
    id: "count",
    header: "Count",
    align: "end",
    width: "8rem",
    value: (r) => r.count,
    cell: (r) => r.count.toLocaleString(),
  },
];

export function HeapPanel(): ReactElement {
  // A snapshot — measured on open and via the Refresh button. NOT pushed.
  const stats = useLive(heapStatsValue);

  // Heavy, manual-only dump. Blocks the backend event loop for seconds and
  // writes a large file — never auto-triggered.
  const capture = useEndpointMutation(captureHeapSnapshot);
  const result = capture.data;

  return (
    <Inset pad="lg">
      <Stack gap="xl">
        <Stack as="section" gap="sm">
          <Stack direction="row" align="center" gap="sm">
            <SectionLabel>Heap (bun:jsc heapStats)</SectionLabel>
            <Button variant="outline" onClick={() => stats.refresh()}>
              Refresh
            </Button>
          </Stack>
          {stats.status === "loading" ? (
            <Loading variant="spinner" label="Measuring the heap…" />
          ) : stats.status === "error" ? (
            <ResourceErrorInline
              variant="block"
              subject="heap stats"
              error={stats.error}
              refetch={stats.refetch}
            />
          ) : (
            <Text variant="caption" tone="muted">
              {`${stats.data.physFootprintMb.toFixed(0)} MB footprint · ${stats.data.heapSizeMb.toFixed(
                1,
              )} MB heap (cap ${stats.data.heapCapacityMb.toFixed(
                1,
              )} MB) · ${stats.data.objectCount.toLocaleString()} objects · ${stats.data.types.length} types`}
            </Text>
          )}
        </Stack>

        <Stack as="section" gap="sm">
          <SectionLabel>Full heap snapshot (heavy)</SectionLabel>
          <Text variant="caption" tone="muted">
            Walks the entire object graph synchronously — blocks the backend
            event loop for seconds on a multi-GB heap and writes a large{" "}
            .heapsnapshot file to disk (V8 format). Load it offline in Chrome
            DevTools (Memory tab) or VS Code. Manual, on-demand only.
          </Text>
          <Stack direction="row" align="center" gap="sm">
            <Button
              variant="destructive"
              onClick={() => void capture.mutateAsync({})}
              disabled={capture.isPending}
            >
              {capture.isPending ? "Capturing…" : "Capture full snapshot"}
            </Button>
          </Stack>
          {result ? (
            <Text variant="caption" tone="muted">
              {`Wrote ${formatBytes(result.sizeBytes)} → ${result.path}`}
            </Text>
          ) : null}
        </Stack>

        {/* The loading and failed states render in the summary above. */}
        {matchResource(stats, {
          loading: () => null,
          error: () => null,
          ready: (data) => (
            <DataTable
              data={data.types}
              columns={COLUMNS}
              rowKey={(r) => r.type}
              emptyLabel="No objects on the heap."
            />
          ),
        })}
      </Stack>
    </Inset>
  );
}
