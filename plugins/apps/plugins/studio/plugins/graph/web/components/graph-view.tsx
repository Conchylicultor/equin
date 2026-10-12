import { useMemo, useState } from "react";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { GraphCanvas } from "@plugins/primitives/plugins/graph-canvas/web";
import {
  useCompositionData,
  useActiveComposition,
  useActiveMembership,
  useGraph,
} from "@plugins/plugin-meta/plugins/composition/web";
import { parseEntryPattern } from "@plugins/plugin-meta/plugins/closure/core";
import { STATE_LEGEND } from "@plugins/apps/plugins/studio/plugins/membership-tint/web";
import { focusSubgraph, toCanvas, type Direction } from "../internal/subgraph";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");
const removeIcon = symbol("remove");

const DEFAULT_DEPTH = 2;
const NODE_CAP = 60;
const DIRECTION_OPTIONS: { id: Direction; label: string }[] = [
  { id: "both", label: "Both" },
  { id: "deps", label: "Deps" },
  { id: "dependents", label: "Dependents" },
];

export function GraphView({ paneFocusId }: { paneFocusId?: PluginId }) {
  const { data } = useCompositionData();
  const graph = useGraph();
  const membership = useActiveMembership();
  const active = useActiveComposition();

  // Seed focus: pane param → active composition's first entry point → unset.
  // Entry points are EntryPatterns (`id`, `id.**`, `!id.**`, or the root `**`);
  // strip a pattern down to its base id before using it as a focus node. The root
  // `**` has no base — a composition of every plugin has no meaningful single
  // focus in an 840-node graph — so it seeds nothing and the pane falls back to
  // the search prompt below, letting the reader pick where to start.
  const firstEntryParsed = active?.entryPoints[0]
    ? parseEntryPattern(active.entryPoints[0])
    : null;
  const seed =
    paneFocusId ??
    (firstEntryParsed && firstEntryParsed.kind === "id"
      ? firstEntryParsed.base
      : null);
  const [focusId, setFocusId] = useState<PluginId | null>(seed);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [direction, setDirection] = useState<Direction>("both");
  const [query, setQuery] = useState("");

  const { nodes, edges, hiddenCount } = useMemo(() => {
    if (!graph || !focusId) return { nodes: [], edges: [], hiddenCount: 0 };
    const sub = focusSubgraph(graph, focusId, {
      depth,
      cap: NODE_CAP,
      direction,
    });
    const { nodes, edges } = toCanvas(sub, focusId, membership);
    return { nodes, edges, hiddenCount: sub.hiddenCount };
  }, [graph, focusId, depth, direction, membership]);

  if (data.status === "loading") return <Loading variant="spinner" />;
  if (data.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the composition graph"
        error={data.error}
        refetch={data.refetch}
      />
    );
  }
  // The store's graph is published from this read by an effect, so it lags the
  // ready arm by one commit.
  if (!graph) return <Loading variant="spinner" />;
  const { allIds } = data.data;

  // Empty state: prompt + search over allIds to pick a focus node. Clear the
  // query on pick so the toolbar's own search doesn't open pre-filled.
  if (!focusId) {
    return (
      <FocusPicker
        allIds={allIds}
        query={query}
        onQuery={setQuery}
        onPick={(id) => {
          setFocusId(id);
          setQuery("");
        }}
      />
    );
  }

  return (
    <Column
      fill
      className="h-full"
      scrollBody={false}
      header={
        <Inset pad="sm">
          <Cluster gap="sm">
            <div className="relative w-56">
              <SearchInput
                placeholder="Focus on a plugin…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                // The wrapper's top padding is the gap below the input — the
                // ramp has no margin classes, and the panel's own box is drawn.
                <div
                  // eslint-disable-next-line layout/no-adhoc-layout -- dropdown anchored below the input (top-full), outside Pin's in-parent anchor set
                  className="absolute left-0 top-full z-overlay w-full pt-2xs"
                >
                  <Surface level="overlay" className="p-2xs">
                    <FocusResults
                      allIds={allIds}
                      query={query}
                      onPick={(id) => {
                        setFocusId(id);
                        setQuery("");
                      }}
                    />
                  </Surface>
                </div>
              )}
            </div>

            <ControlSizeProvider size="sm">
              <Stack direction="row" align="center" gap="2xs">
                <Text variant="caption" tone="muted">
                  Depth
                </Text>
                <IconButton
                  icon={removeIcon}
                  label="Decrease depth"
                  disabled={depth <= 1}
                  onClick={() => setDepth((d) => Math.max(1, d - 1))}
                />
                <Text variant="label">{depth}</Text>
                <IconButton
                  icon={addIcon}
                  label="Increase depth"
                  onClick={() => setDepth((d) => d + 1)}
                />
              </Stack>
            </ControlSizeProvider>

            <SegmentedControl<Direction>
              options={DIRECTION_OPTIONS}
              value={direction}
              onChange={setDirection}
            />

            {hiddenCount > 0 && (
              <Text variant="caption" tone="muted">
                +{hiddenCount} hidden
              </Text>
            )}

            {membership && <Legend />}
          </Cluster>
        </Inset>
      }
      body={
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          focusId={focusId}
          onNodeClick={(id) => setFocusId(id as PluginId)}
        />
      }
    />
  );
}

function Legend() {
  return (
    <Cluster gap="sm" className="ml-auto">
      {STATE_LEGEND.map(({ state, label, tint }) => (
        <Stack key={state} as="span" direction="row" align="center" gap="2xs">
          <span
            aria-hidden
            className={`inline-block size-3 rounded-sm border border-border ${tint ?? "bg-transparent"}`}
          />
          <Text variant="caption" tone="muted">
            {label}
          </Text>
        </Stack>
      ))}
    </Cluster>
  );
}

function FocusPicker({
  allIds,
  query,
  onQuery,
  onPick,
}: {
  allIds: PluginId[];
  query: string;
  onQuery: (q: string) => void;
  onPick: (id: PluginId) => void;
}) {
  return (
    <Inset pad="md">
      <Stack gap="md">
        <Text variant="caption" tone="muted">
          Search for a plugin to focus the closure graph on its dependencies and
          dependents.
        </Text>
        <SearchInput
          placeholder="Search plugins…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          autoFocus
        />
        <FocusResults allIds={allIds} query={query} onPick={onPick} />
      </Stack>
    </Inset>
  );
}

function FocusResults({
  allIds,
  query,
  onPick,
}: {
  allIds: PluginId[];
  query: string;
  onPick: (id: PluginId) => void;
}) {
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allIds.filter((id) => id.toLowerCase().includes(q)).slice(0, 12);
  }, [allIds, query]);

  if (matches.length === 0) return null;

  return (
    <Stack gap="2xs">
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- search-match picker for graph recenter (transient chrome) */}
      {matches.map((id) => {
        const segs = pluginIdSegments(id);
        return (
          <Row key={id} onClick={() => onPick(id)}>
            <span className="truncate">
              <span className="font-medium">{segs[segs.length - 1]}</span>
              <span className="text-muted-foreground"> · {id}</span>
            </span>
          </Row>
        );
      })}
    </Stack>
  );
}
