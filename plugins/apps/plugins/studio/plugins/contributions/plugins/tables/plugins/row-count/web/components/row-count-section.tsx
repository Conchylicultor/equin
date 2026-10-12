import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { tableRowCount } from "../../shared/resources";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

/**
 * One number — so it rides the section header as `summary` rather than sitting
 * behind a chevron.
 */
export function RowCountSummary({
  tableName,
}: {
  tableName: string;
  pluginId: string;
}) {
  // A snapshot: the estimate is measured when read, never pushed.
  const result = useLive(tableRowCount, { tableName });

  if (result.status === "loading") {
    return <Loading variant="spinner" label="Loading…" />;
  }

  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the row count"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  const data = result.data;

  return (
    <Inline gap="xs">
      <Text as="span" variant="body" className="tabular-nums">
        {data.estimate != null ? data.estimate.toLocaleString() : "—"}
      </Text>
      <Text as="span" variant="caption" tone="muted">
        rows (est.)
      </Text>
    </Inline>
  );
}
