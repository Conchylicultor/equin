import type { ReactNode } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { matchResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { formatValue } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/core";
import { Sparkline } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/web";
import { delta, type CatalogMetric, type SeriesResult } from "../../core";
import { boardQuery, type BoardContext } from "../internal/query";
import { useMetric } from "../internal/use-metric";
import { Delta } from "./delta";

export interface MetricTileProps {
  entry: CatalogMetric;
  context: BoardContext;
  selected: boolean;
  onSelect: () => void;
}

/**
 * A KPI tile: the metric's label, its value over the range (formatted by unit,
 * auto-compact), the change against the previous period coloured by whether
 * it is good news, and a sparkline of the range. A toggle button — selecting
 * it chooses the section's lead card.
 */
export function MetricTile({
  entry,
  context,
  selected,
  onSelect,
}: MetricTileProps): ReactNode {
  const result = useMetric(boardQuery(entry, context, null));
  return (
    <Card
      as="button"
      type="button"
      interactive
      selected={selected}
      aria-pressed={selected}
      onClick={onSelect}
      data-metric-tile={entry.id}
      className="text-left"
    >
      <Stack gap="xs">
        <Text variant="label" tone="subtle">
          {entry.label}
        </Text>
        {matchResource(result, {
          loading: () => <Loading />,
          // Text, not ResourceErrorInline: the tile is itself a button, so it
          // cannot hold a Retry one; the lead card below offers it.
          error: (error) => (
            <Text variant="caption" tone="destructive" role="alert">
              {error.message}
            </Text>
          ),
          ready: (data) =>
            data.kind === "series" ? (
              <TileBody entry={entry} data={data} selected={selected} />
            ) : (
              <Text variant="caption" tone="destructive" role="alert">
                {`"${entry.id}" answered a breakdown, not a series`}
              </Text>
            ),
        })}
      </Stack>
    </Card>
  );
}

function TileBody({
  entry,
  data,
  selected,
}: {
  entry: CatalogMetric;
  data: SeriesResult;
  selected: boolean;
}): ReactNode {
  // An unsplit query answers exactly one series (the engine checks it).
  const values = data.series[0]!.values;
  return (
    <Stack direction="row" gap="sm" align="end">
      <Fill>
        <Stack gap="2xs">
          <Text variant="title" className="tabular-nums">
            {formatValue(entry.unit, data.total)}
          </Text>
          {data.previous !== undefined && (
            <Delta
              delta={delta(data.total, data.previous.total)}
              polarity={entry.polarity}
              vs={`vs ${data.previous.label}`}
            />
          )}
        </Stack>
      </Fill>
      <Sparkline
        values={values}
        color={selected ? "var(--primary)" : "var(--muted-foreground)"}
      />
    </Stack>
  );
}
