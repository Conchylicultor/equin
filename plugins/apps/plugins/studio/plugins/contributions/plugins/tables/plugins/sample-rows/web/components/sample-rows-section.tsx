import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { tableSampleRows } from "../../shared/resources";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

export function SampleRowsSection({
  tableName,
}: {
  tableName: string;
  pluginId: string;
}) {
  // A snapshot: sampled when read, never pushed — Refresh re-samples.
  const result = useLive(tableSampleRows, { tableName });

  if (result.status === "loading") {
    return <Loading variant="spinner" label="Loading sample rows…" />;
  }

  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="sample rows"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  return (
    <Stack gap="sm">
      <Stack direction="row" gap="none" justify="end">
        <Button variant="outline" onClick={() => result.refresh()}>
          Refresh
        </Button>
      </Stack>
      <SampleRowsTable
        sampleColumns={result.data.columns}
        rows={result.data.rows}
      />
    </Stack>
  );
}

function SampleRowsTable({
  sampleColumns,
  rows,
}: {
  sampleColumns: readonly string[];
  rows: Record<string, unknown>[];
}) {
  const columns: ColumnDef<Record<string, unknown>>[] = useMemo(
    () =>
      sampleColumns.map((col) => ({
        id: col,
        header: col,
        width: "minmax(120px,200px)",
        cell: (row: Record<string, unknown>) =>
          row[col] === null ? (
            <span className="italic text-muted-foreground">null</span>
          ) : (
            <span className="font-mono">{String(row[col])}</span>
          ),
      })),
    [sampleColumns],
  );

  return (
    <Scroll axis="x">
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(_row, index) => String(index)}
        emptyLabel="No rows"
      />
    </Scroll>
  );
}
