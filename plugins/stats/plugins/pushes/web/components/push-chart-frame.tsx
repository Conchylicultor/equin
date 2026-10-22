import { useMemo, type ReactNode } from "react";
import { useShowEmptyDays } from "@plugins/stats/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import { LiveChart, fillGaps } from "@plugins/stats/plugins/commits/web";
import type { PushBucket } from "../../shared/values";

type ChartBody<Point> = (points: Point[]) => ReactNode;

/**
 * One pushes chart: its title over the shared Stats frame (`LiveChart` owns
 * the read's states — loading, failure, `unavailable`, empty), with the gaps
 * filled when the stats page shows empty days. Only the title and the gap
 * fill are this plugin's.
 */
export function PushChartFrame<Point extends { bucket: string }>({
  title,
  subject,
  bucket,
  result,
  children,
}: {
  title: string;
  /** What failed to load, for the error message ("the push throughput"). */
  subject: string;
  bucket: PushBucket;
  result: ResourceResult<{ points: Point[] }> | ResourceUnavailable;
  children: ChartBody<Point>;
}) {
  return (
    <Stack gap="sm">
      <Text as="p" variant="label" className="text-muted-foreground">
        {title}
      </Text>
      <LiveChart
        read={result}
        subject={subject}
        isEmpty={(d) => d.points.length === 0}
        emptyText="No pushes yet."
      >
        {({ points }) => (
          <GapFilled points={points} bucket={bucket}>
            {children}
          </GapFilled>
        )}
      </LiveChart>
    </Stack>
  );
}

function GapFilled<Point extends { bucket: string }>({
  points,
  bucket,
  children,
}: {
  points: Point[];
  bucket: PushBucket;
  children: ChartBody<Point>;
}) {
  const { showEmptyDays } = useShowEmptyDays();
  const shown = useMemo(
    () => (showEmptyDays ? fillGaps(points, "bucket", bucket) : points),
    [points, showEmptyDays, bucket],
  );
  return <>{children(shown)}</>;
}
