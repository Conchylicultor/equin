import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import type { SpanKind } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  cn,
  Button,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  MultiSpanLane,
  formatDuration,
  type SpanBar,
} from "@plugins/debug/plugins/profiling/web";
import type {
  TraceLaneProps,
  TraceSelection,
} from "@plugins/debug/plugins/trace/plugins/engine/web";
import {
  buildSpanTree,
  flattenTree,
  ancestorChain,
  type SpanNode,
} from "../internal/build-tree";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  useRowFold,
  type RowFoldProps,
} from "@plugins/primitives/plugins/virtual-rows/plugins/row-fold/web";

const chevronRightIcon = symbol("chevron-right");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

// Categorical color per span kind (fill = "what", never state — the op-gantt
// convention). The kind is now a per-row dot rather than a lane grouping: the rows
// are ordered by the call tree, not bucketed by kind.
const KIND_CONFIG: Record<
  SpanKind,
  { label: string; bar: string; dot: string }
> = {
  http: { label: "HTTP", bar: "bg-categorical-1", dot: "bg-categorical-1" },
  sub: { label: "Sub", bar: "bg-categorical-2", dot: "bg-categorical-2" },
  push: { label: "Push", bar: "bg-categorical-3", dot: "bg-categorical-3" },
  flush: { label: "Flush", bar: "bg-categorical-4", dot: "bg-categorical-4" },
  cascade: {
    label: "Cascade",
    bar: "bg-categorical-8",
    dot: "bg-categorical-8",
  },
  loader: { label: "Loader", bar: "bg-categorical-5", dot: "bg-categorical-5" },
  job: { label: "Job", bar: "bg-categorical-6", dot: "bg-categorical-6" },
  db: { label: "DB", bar: "bg-categorical-7", dot: "bg-categorical-7" },
  // categorical-1..8 are all taken above; a `bg` (runTracked) root reuses the
  // unused categorical-9 so it reads as its own distinct color in the waterfall.
  bg: { label: "BG", bar: "bg-categorical-9", dot: "bg-categorical-9" },
  // Live-state plumbing around the loader: routing reuses the flush hue and a
  // membership query the loader hue — each reads as a sibling of what it feeds.
  route: { label: "Route", bar: "bg-categorical-4", dot: "bg-categorical-4" },
  membership: {
    label: "Membership",
    bar: "bg-categorical-5",
    dot: "bg-categorical-5",
  },
};

// Stable per-LAYER color for wait bands (and their legend swatch), independent of
// the span kind — so the SAME gate reads as the SAME color across every stalled
// row, which is the whole point: twelve loaders all stopping dead on `db-acquire`
// at t=1.4s line up as one color. Hashed into the categorical palette; every
// literal appears here (and in KIND_CONFIG) so Tailwind extracts all eight.
const LAYER_PALETTE = [
  "bg-categorical-1",
  "bg-categorical-2",
  "bg-categorical-3",
  "bg-categorical-4",
  "bg-categorical-5",
  "bg-categorical-6",
  "bg-categorical-7",
  "bg-categorical-8",
] as const;

function layerColorClass(layer: string): string {
  let h = 0;
  for (let i = 0; i < layer.length; i++) h = (h * 31 + layer.charCodeAt(i)) | 0;
  return LAYER_PALETTE[Math.abs(h) % LAYER_PALETTE.length]!;
}

// px of indentation per tree depth.
const INDENT = 10;

// The tripping span's own instance id, when the trigger names one. Absent for
// non-span triggers (op-time, stall, client signals) — then no row is outlined.
const tripDetailSchema = z.object({ spanId: z.number() }).partial();
function tripSpanId(detail: unknown): number | null {
  const parsed = tripDetailSchema.safeParse(detail);
  return parsed.success ? (parsed.data.spanId ?? null) : null;
}

const rowKey = (row: { node: SpanNode }): string => String(row.node.id);

/**
 * The spans Gantt lane group: the captured flight window rendered as a **nested
 * waterfall** — one row per span *instance*, depth-indented under its true parent
 * (linked by the recorder's per-instance `parentId`, so two concurrent runs of the
 * same label are two rows under their own parents). A bar click reports the span's
 * full decomposition up to the pane's shared detail strip via `onSelect`.
 */
export function SpansLane({ trace, onSelect }: TraceLaneProps): ReactElement {
  const tree = useMemo(() => buildSpanTree(trace), [trace]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  const rows = useMemo(
    () => (tree.kind === "ok" ? flattenTree(tree.roots, collapsed) : []),
    [tree, collapsed],
  );
  // A toggle folds the rows it reveals or hides: the fold reads the flips of
  // the collapsed set (which side of it is "open" does not matter).
  const foldKeys = useMemo(
    () => new Set([...collapsed].map(String)),
    [collapsed],
  );
  const fold = useRowFold({ items: rows, getKey: rowKey, openKeys: foldKeys });
  const tripId = useMemo(
    () => tripSpanId(trace.trigger.detail),
    [trace.trigger.detail],
  );

  if (tree.kind !== "ok") return <SectionPlaceholder section={tree} />;

  const { byId, roots } = tree;
  const collapseAll = (): void =>
    setCollapsed(
      new Set(
        [...byId.values()]
          .filter((n) => n.children.length > 0)
          .map((n) => n.id),
      ),
    );

  return (
    <div className="border-b">
      <Stack direction="row" align="center" gap="sm" className="px-lg py-xs">
        <Text as="div" variant="caption" className="font-semibold">
          Spans
        </Text>
        <Text
          as="div"
          variant="caption"
          className="tabular-nums text-muted-foreground"
        >
          {byId.size} span{byId.size === 1 ? "" : "s"} · {roots.length} root
          {roots.length === 1 ? "" : "s"}
        </Text>
        <Fill />
        <Button variant="ghost" onClick={() => setCollapsed(new Set())}>
          Expand all
        </Button>
        <Button variant="ghost" onClick={collapseAll}>
          Collapse all
        </Button>
      </Stack>
      <Stack gap="2xs" className="px-lg pb-sm" {...fold.hostProps}>
        {fold.items.map(({ node, depth }) => (
          <SpanRow
            key={node.id}
            fold={fold.rowProps(String(node.id))}
            node={node}
            depth={depth}
            collapsed={collapsed.has(node.id)}
            isTrip={node.id === tripId}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (!next.delete(node.id)) next.add(node.id);
                return next;
              })
            }
            onClick={() =>
              onSelect?.(toSelection(node, byId, trace.wallTime, trace.atMs))
            }
          />
        ))}
      </Stack>
    </div>
  );
}

function SpanRow({
  fold,
  node,
  depth,
  collapsed,
  isTrip,
  onToggle,
  onClick,
}: {
  /** The row's place in a fold (`useRowFold`). */
  fold: RowFoldProps;
  node: SpanNode;
  depth: number;
  collapsed: boolean;
  isTrip: boolean;
  onToggle: () => void;
  onClick: () => void;
}): ReactElement {
  const config = KIND_CONFIG[node.kind];
  // Wait bands paint OVER the work bar at their true offsets, colored per LAYER
  // (not per kind) so a saturated gate is one recognizable color down the column.
  // Reduced opacity keeps the work bar visible underneath. `unavailable` (pre-band
  // trace) paints nothing — the detail strip says why rather than guessing a place.
  const overlays =
    node.waitPosition.kind === "positioned"
      ? node.waitPosition.bands.map((b) => ({
          startMs: b.startMs,
          ms: b.ms,
          colorClass: cn(layerColorClass(b.layer), "opacity-70"),
        }))
      : undefined;
  const bar: SpanBar = {
    id: String(node.id),
    startMs: node.startMs,
    durationMs: node.durationMs,
    colorClass: config.bar,
    treatment: node.open ? "pulse" : "solid",
    overlays,
  };

  return (
    <div
      {...fold}
      className={cn("rounded-md", isTrip && "ring-1 ring-primary")}
    >
      <MultiSpanLane
        label={
          <TreeLabel
            node={node}
            depth={depth}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        }
        duration={formatDuration(node.ageMs)}
        bars={[bar]}
        onBarClick={onClick}
      />
    </div>
  );
}

// The indented label cell. MultiSpanLane's label slot is a rigid, clipping column,
// so this supplies its own single-line context: the <Text> leaf ellipsizes a long
// label while the chevron / dot / orphan marker stay rigid.
function TreeLabel({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: SpanNode;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
}): ReactElement {
  const hasChildren = node.children.length > 0;
  return (
    <SingleLineProvider value={true}>
      {/* Depth indentation is a runtime value — no Tailwind class can express it. */}
      <Stack
        direction="row"
        align="center"
        gap="2xs"
        style={{ paddingLeft: depth * INDENT }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={collapsed ? "Expand" : "Collapse"}
            aria-expanded={!collapsed}
            className="text-muted-foreground hover:text-foreground"
            onClick={onToggle}
          >
            {collapsed ? (
              <Icon icon={chevronRightIcon} className="size-3" />
            ) : (
              <Icon icon={keyboardArrowDownIcon} className="size-3" />
            )}
          </button>
        ) : (
          <span className="size-3" />
        )}
        <span
          className={cn("size-2 rounded-full", KIND_CONFIG[node.kind].dot)}
        />
        <Fill>
          <Text
            as="span"
            variant="caption"
            className="font-mono"
            title={node.label}
          >
            {node.label}
          </Text>
        </Fill>
        {node.orphan && (
          <span
            className="text-muted-foreground"
            title="Parent span not in this window — evicted (<5ms, never entered the flight ring) or a detached child that outlived its parent."
          >
            ⇱
          </span>
        )}
      </Stack>
    </SingleLineProvider>
  );
}

function SectionPlaceholder({
  section,
}: {
  section:
    | { kind: "absent" }
    | { kind: "legacy" }
    | { kind: "invalid"; message: string };
}): ReactElement {
  const message: ReactNode =
    section.kind === "absent"
      ? "No spans in flight or recently completed (≥5ms) during this window."
      : section.kind === "legacy"
        ? "Legacy spans section — captured before per-instance span ids existed, so the call tree cannot be reconstructed. Re-capture to see it."
        : `Malformed spans section: ${section.message}`;
  return (
    <Stack gap="none" className="px-lg py-sm">
      <Placeholder tone={section.kind === "invalid" ? "error" : "muted"}>
        {message}
      </Placeholder>
    </Stack>
  );
}

// Wall-clock anchor: profiler-clock t maps to wall via wallTime + (t − atMs).
function wallAt(wallTime: string, atMs: number, t: number): string {
  const base = new Date(wallTime).getTime();
  const d = new Date(base + (t - atMs));
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function toSelection(
  node: SpanNode,
  byId: Map<number, SpanNode>,
  wallTime: string,
  atMs: number,
): TraceSelection {
  const fields: TraceSelection["fields"] = [
    { label: "kind", value: KIND_CONFIG[node.kind].label },
    {
      label: "when",
      value:
        node.t1 === null
          ? `${wallAt(wallTime, atMs, node.t0)} → open`
          : `${wallAt(wallTime, atMs, node.t0)} → ${wallAt(wallTime, atMs, node.t1)}`,
    },
    { label: "duration", value: formatDuration(node.ageMs) },
    {
      label: "wait / child / self",
      value: `${ms(node.waitMs)} / ${ms(node.childMs)} / ${ms(node.selfMs)}`,
    },
  ];

  const chain = ancestorChain(node, byId);
  if (chain.length > 0) {
    fields.push({
      label: "parent",
      value: chain.map((n) => `${n.kind}:${n.label}`).join(" ← "),
    });
  } else if (node.orphan) {
    fields.push({
      label: "parent",
      value: "not in this window (evicted or detached)",
    });
  }
  if (node.children.length > 0) {
    fields.push({ label: "children", value: String(node.children.length) });
  }
  // Honest wait accounting: bands sit at true offsets, so the total is either
  // fully positioned, partly positioned (the rest dropped to the recorder's band
  // budget or clamped off the window), or not captured at all (pre-band trace).
  if (node.waitMs > 0) {
    const wp = node.waitPosition;
    if (wp.kind === "unavailable") {
      fields.push({
        label: "wait",
        value: `${ms(node.waitMs)} — position not captured (pre-wait-band trace)`,
      });
    } else if (wp.residualMs === 0) {
      fields.push({ label: "wait", value: ms(node.waitMs) });
    } else {
      fields.push({
        label: "wait",
        value: `${ms(node.waitMs)} — ${ms(wp.positionedMs)} positioned, ${ms(wp.residualMs)} unpositioned`,
      });
    }
  }
  // Per-layer totals, each with the swatch its bands wear in the Gantt — the legend
  // that ties a color in a stalled row to the gate it names. Completed spans now
  // carry `waits` (they didn't before positioned bands landed), so this renders for
  // most rows, not just open ones.
  if (node.waits && Object.keys(node.waits).length > 0) {
    fields.push({ label: "waits", value: <WaitsLegend waits={node.waits} /> });
  }
  return { title: `${node.kind}:${node.label}`, fields };
}

/** Per-layer wait totals, each prefixed by the layer's Gantt band color swatch. */
function WaitsLegend({
  waits,
}: {
  waits: Record<string, number>;
}): ReactElement {
  return (
    <Inline gap="sm">
      {Object.entries(waits)
        .sort((a, b) => b[1] - a[1])
        .map(([layer, w]) => (
          <Inline key={layer} gap="2xs">
            <span
              className={cn("size-2 rounded-full", layerColorClass(layer))}
            />
            <span>
              {layer} {ms(w)}
            </span>
          </Inline>
        ))}
    </Inline>
  );
}

function ms(v: number): string {
  return `${Math.round(v)}ms`;
}
