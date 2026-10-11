import type { ReactNode } from "react";
import { navigate } from "@plugins/apps-core/plugins/tabs/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { formatValue } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/core";
import {
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { LiveListResult } from "@plugins/network/plugins/live/web";
import type {
  CatalogMetric,
  DetailsSelector,
  DrillItem,
  DrillMeta,
} from "../../core";
import {
  DETAILS_STEP,
  useMetricDetails,
  useMetricDetailsTotal,
} from "../internal/use-metric";
import type { MetricBucket } from "./metric-card";

/** One metric whose records the drawer lists, with the params its card queried with. */
export interface DrillSource {
  metric: CatalogMetric;
  params: Record<string, unknown>;
}

/** What the drawer is open on: one bucket, and the metrics that can say what is behind it. */
export interface DrillTarget {
  bucket: MetricBucket;
  sources: DrillSource[];
}

export interface DrillDrawerProps {
  /** `null` = closed. */
  target: DrillTarget | null;
  onClose: () => void;
}

/**
 * The records behind one bucket, from the right edge: the bucket's label,
 * then one group per metric that declares a drill-down (the same records
 * listed once — metrics sharing a source and a drill label are one group).
 * Each group previews five and pages the rest on "Show more" (up to the
 * drill-down's cap — past it, "first N of total"); a record with a link
 * opens it.
 */
export function DrillDrawer({ target, onClose }: DrillDrawerProps): ReactNode {
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        {target !== null && <DrawerBody target={target} />}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ target }: { target: DrillTarget }): ReactNode {
  const groups = dedupe(target.sources);
  return (
    <>
      <SheetHeader>
        <SheetTitle>{target.bucket.label}</SheetTitle>
        <SheetDescription>
          {target.bucket.partial
            ? "So far in this period"
            : "Everything in this period"}
        </SheetDescription>
      </SheetHeader>
      <Scroll fill>
        <Inset x="md" b="lg">
          <Stack gap="lg">
            {groups.length === 0 && (
              <Text variant="caption" tone="muted">
                Nothing on this board lists its records.
              </Text>
            )}
            {groups.map((g) => (
              <DrillGroup
                key={`${g.metric.source}:${g.metric.drill!.label}`}
                source={g}
                bucket={target.bucket}
              />
            ))}
          </Stack>
        </Inset>
      </Scroll>
    </>
  );
}

/** Metrics sharing a source and a drill label list the same records: one group. */
function dedupe(sources: readonly DrillSource[]): DrillSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (s.metric.drill === undefined) return false;
    const key = `${s.metric.source}:${s.metric.drill.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function DrillGroup({
  source,
  bucket,
}: {
  source: DrillSource;
  bucket: MetricBucket;
}): ReactNode {
  const { metric, params } = source;
  const label = metric.drill!.label;
  const selector: DetailsSelector = {
    metric: metric.id,
    interval: { start: bucket.start, end: bucket.end },
    split: null,
    params,
  };
  const details = useMetricDetails(selector);
  const total = useMetricDetailsTotal(selector);
  return (
    <Stack
      gap="xs"
      as="section"
      aria-label={label}
      data-drill-group={metric.id}
    >
      <DrillGroupBody
        label={label}
        metric={metric}
        details={details}
        total={total}
      />
    </Stack>
  );
}

/** A switch, not `matchResource`: the ready arm's paging handles are needed too. */
function DrillGroupBody({
  label,
  metric,
  details,
  total,
}: {
  label: string;
  metric: CatalogMetric;
  details: LiveListResult<DrillItem>;
  total: ResourceResult<DrillMeta>;
}): ReactNode {
  switch (details.status) {
    case "loading":
      return (
        <>
          <Text variant="label">{label}</Text>
          <Loading variant="rows" count={3} />
        </>
      );
    case "error":
      // A page that failed keeps the ones already listed on screen, with the
      // failure under them; a first page that failed is the failure.
      return (
        <>
          {details.stale === undefined ? (
            <Text variant="label">{label}</Text>
          ) : (
            <DrillList
              label={label}
              metric={metric}
              items={details.stale}
              total={total}
            />
          )}
          <ResourceErrorInline
            variant="inline"
            error={details.error}
            refetch={details.refetch}
            subject={label.toLowerCase()}
          />
        </>
      );
    case "ready": {
      const count = total.status === "ready" ? total.data.total : null;
      const shown = details.data.length;
      // A full last page may be all there is: once the total says every
      // record is listed, there is nothing more to show.
      const more = count === null || count > shown;
      return (
        <>
          <DrillList
            label={label}
            metric={metric}
            items={details.data}
            total={total}
          />
          {((details.canGrow && more) || details.growing) && (
            <Button
              variant="link"
              onClick={details.loadMore}
              disabled={details.growing}
            >
              {/* The next step completes the list: say how long it will be. */}
              {count !== null && count <= shown + DETAILS_STEP
                ? `Show all ${count} →`
                : "Show more →"}
            </Button>
          )}
          {/* At the cap: the list stops short of the bucket's records. */}
          {!details.canGrow &&
            !details.growing &&
            count !== null &&
            count > shown && (
              <Text variant="caption" tone="muted">
                {`First ${shown} of ${count}`}
              </Text>
            )}
        </>
      );
    }
  }
}

/** The group's heading with its total, then every record loaded so far. */
function DrillList({
  label,
  metric,
  items,
  total,
}: {
  label: string;
  metric: CatalogMetric;
  items: readonly DrillItem[];
  total: ResourceResult<DrillMeta>;
}): ReactNode {
  return (
    <>
      <Stack direction="row" gap="xs" align="center">
        <Text variant="label">{label}</Text>
        <DrillTotal total={total} />
      </Stack>
      {total.status === "error" && (
        <ResourceErrorInline
          variant="inline"
          error={total.error}
          refetch={total.refetch}
          subject={`${label.toLowerCase()} total`}
        />
      )}
      {items.length === 0 && (
        <Text variant="caption" tone="muted">
          None
        </Text>
      )}
      <Stack gap="none">
        {items.map((item) => (
          <DrillRow key={item.id} item={item} metric={metric} />
        ))}
      </Stack>
    </>
  );
}

/** The bucket's total beside the heading: pending until known — never a 0 standing in. */
function DrillTotal({
  total,
}: {
  total: ResourceResult<DrillMeta>;
}): ReactNode {
  switch (total.status) {
    case "loading":
      return <Loading variant="block" className="h-3 w-6" />;
    case "error":
      return null;
    case "ready":
      // `null`: the metric lists its records without counting them.
      return total.data.total === null ? null : (
        <Text tone="muted">{`· ${total.data.total}`}</Text>
      );
  }
}

function DrillRow({
  item,
  metric,
}: {
  item: DrillItem;
  metric: CatalogMetric;
}): ReactNode {
  return (
    <Row
      onClick={
        item.link === undefined ? undefined : () => navigate(item.link!.href)
      }
    >
      <Fill>
        <Stack gap="none">
          <Text>{item.title}</Text>
          {item.subtitle !== undefined && (
            <Text variant="caption" tone="muted">
              {item.subtitle}
            </Text>
          )}
        </Stack>
      </Fill>
      {item.value !== undefined && (
        <Text variant="caption" tone="subtle" className="tabular-nums">
          {formatValue(metric.unit, item.value)}
        </Text>
      )}
    </Row>
  );
}
