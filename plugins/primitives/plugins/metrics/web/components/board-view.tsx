import { useCallback, useState, type ReactNode } from "react";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ResourceErrorInline,
  ResourceView,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { OutlineRail } from "@plugins/primitives/plugins/outline/plugins/rail/web";
import {
  boardParamsFor,
  type BoardSection,
  type BoardSpec,
  type Catalog,
  type CatalogMetric,
} from "../../core";
import {
  useBoardViewState,
  type BoardViewStateHandle,
} from "../internal/board-state";
import type { BoardContext } from "../internal/query";
import {
  cardKey,
  resolveCardRef,
  resolveMetricRef,
} from "../internal/resolve-ref";
import { useMetricCatalog } from "../internal/use-metric";
import { BreakdownCard } from "./breakdown-card";
import { DrillDrawer, type DrillTarget } from "./drill-drawer";
import { MetricCard, type MetricPick } from "./metric-card";
import { MetricError } from "./metric-error";
import { MetricTile } from "./metric-tile";
import { RangeBar } from "./range-bar";

export interface BoardViewProps {
  spec: BoardSpec;
  /** With `viewId`, keys the device-local look of this view (range, compare, selections). */
  storageKey: string;
  viewId: string;
  /** A click on a chart's bucket. Default: open the drill-down drawer on it. */
  onPick?: (pick: MetricPick) => void;
}

/**
 * One board: its range bar, then its sections — each a row of focus tiles
 * choosing the section's lead card, then a grid of cards. Every ref is checked
 * against the served catalog; an unknown one is an error card in its place.
 * An outline rail appears once there are two sections to move between.
 */
export function BoardView({
  spec,
  storageKey,
  viewId,
  onPick,
}: BoardViewProps): ReactNode {
  const catalog = useMetricCatalog();
  const view = useBoardViewState(`${storageKey}:${viewId}`);
  return (
    <ResourceView
      resource={catalog}
      errorFallback={(error) => (
        <ResourceErrorInline
          variant="block"
          error={error}
          refetch={catalog.refetch}
          subject="the metrics catalog"
        />
      )}
    >
      {(data) => (
        <Sections spec={spec} catalog={data} view={view} onPick={onPick} />
      )}
    </ResourceView>
  );
}

/** Every metric on the board that can list the records behind a bucket. */
function drillableMetrics(spec: BoardSpec, catalog: Catalog): CatalogMetric[] {
  const out: CatalogMetric[] = [];
  for (const section of spec.sections) {
    const refs = [...(section.focus?.items ?? []), ...section.cards];
    for (const ref of refs) {
      if (!("metric" in ref)) continue;
      const entry = catalog.metrics.find((m) => m.id === ref.metric);
      if (entry?.drill !== undefined && !out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

function Sections({
  spec,
  catalog,
  view,
  onPick,
}: {
  spec: BoardSpec;
  catalog: Catalog;
  view: BoardViewStateHandle;
  onPick: ((pick: MetricPick) => void) | undefined;
}): ReactNode {
  const context: BoardContext & { compare: boolean } = {
    preset: view.state.preset,
    params: spec.params,
    compare: view.state.compare,
  };
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const pick = (p: MetricPick) => {
    if (onPick !== undefined) {
      onPick(p);
      return;
    }
    // The picked metric's records first, then the rest of the board's.
    const rest = drillableMetrics(spec, catalog).filter(
      (m) => m.id !== p.metric.id,
    );
    setDrill({
      bucket: p.bucket,
      sources: [p.metric, ...rest].map((metric) => ({
        metric,
        params:
          metric === p.metric ? p.params : boardParamsFor(spec.params, metric),
      })),
    });
  };
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const resolve = useCallback(
    (id: string) =>
      root === null
        ? null
        : root.querySelector(`[data-metrics-section="${CSS.escape(id)}"]`),
    [root],
  );
  return (
    <Stack gap="lg" ref={setRoot} className="relative">
      <RangeBar
        preset={view.state.preset}
        onPreset={view.setPreset}
        compare={view.state.compare}
        onCompare={view.setCompare}
      />
      {spec.sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          catalog={catalog}
          view={view}
          context={context}
          onPick={pick}
        />
      ))}
      {spec.sections.length >= 2 && (
        <OutlineRail
          entries={spec.sections.map((s) => ({
            id: s.id,
            label: s.title ?? s.id,
            depth: 0,
          }))}
          resolve={resolve}
          label="Board sections"
        />
      )}
      <DrillDrawer target={drill} onClose={() => setDrill(null)} />
    </Stack>
  );
}

function Section({
  section,
  catalog,
  view,
  context,
  onPick,
}: {
  section: BoardSection;
  catalog: Catalog;
  view: BoardViewStateHandle;
  context: BoardContext & { compare: boolean };
  onPick: (pick: MetricPick) => void;
}): ReactNode {
  const focus = (section.focus?.items ?? []).map((ref) =>
    resolveMetricRef(catalog, ref),
  );
  const known = focus.flatMap((f) => (f.kind === "metric" ? [f] : []));
  const selectedId = view.state.selected[section.id];
  const lead = known.find((f) => f.entry.id === selectedId) ?? known[0];

  return (
    <Stack gap="md" as="section" data-metrics-section={section.id}>
      {section.title !== undefined && (
        <Text variant="subheading" as="h2">
          {section.title}
        </Text>
      )}
      {focus.length > 0 && (
        <Grid minCellWidth="12rem" gap="md">
          {focus.map((f, i) =>
            f.kind === "metric" ? (
              <MetricTile
                key={f.entry.id}
                entry={f.entry}
                context={context}
                selected={f === lead}
                onSelect={() => view.select(section.id, f.entry.id)}
              />
            ) : (
              <MetricError
                key={`unknown-${i}`}
                title="Unknown metric"
                message={f.message}
                height={48}
              />
            ),
          )}
        </Grid>
      )}
      {lead !== undefined && (
        <MetricCard
          key={lead.entry.id}
          entry={lead.entry}
          metricRef={lead.ref}
          context={context}
          view={view.state.cards[cardKey(section.id, lead.ref)] ?? {}}
          onView={(patch) => view.setCard(cardKey(section.id, lead.ref), patch)}
          onPick={onPick}
        />
      )}
      {section.cards.length > 0 && (
        <Grid minCellWidth="24rem" mode="fit" gap="md">
          {section.cards.map((ref, i) => {
            const resolved = resolveCardRef(catalog, ref);
            const key = cardKey(section.id, ref);
            switch (resolved.kind) {
              case "unknown":
                return (
                  <MetricError
                    key={`${key}#${i}`}
                    title="Unknown card"
                    message={resolved.message}
                  />
                );
              case "breakdown":
                return (
                  <BreakdownCard
                    key={`${key}#${i}`}
                    entry={resolved.entry}
                    context={context}
                  />
                );
              case "metric":
                return (
                  <MetricCard
                    key={`${key}#${i}`}
                    entry={resolved.entry}
                    metricRef={resolved.ref}
                    context={context}
                    view={view.state.cards[key] ?? {}}
                    onView={(patch) => view.setCard(key, patch)}
                    onPick={onPick}
                  />
                );
            }
          })}
        </Grid>
      )}
    </Stack>
  );
}
