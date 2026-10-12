import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import dagre from "dagre";
import {
  Background,
  ConnectionLineType,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CanvasNode,
  CANVAS_NODE_TYPE,
  NODE_HEIGHT,
  NODE_WIDTH,
  type CanvasFlowNode,
} from "./canvas-node";
import { CanvasEdge, CANVAS_EDGE_TYPE } from "./canvas-edge";
import {
  GroupBackground,
  GROUP_BG_TYPE,
  GROUP_PAD,
  GROUP_LABEL_HEIGHT,
  type GroupBgFlowNode,
} from "./group-background";

/** A single node in the generic graph canvas. */
export interface GraphCanvasNode {
  id: string;
  label: string;
  /** Tooltip (e.g. full id). Falls back to `label`. */
  title?: string;
  /** Background tint (Tailwind class). */
  tintClass?: string | null;
  /** Emphasis ring (focus / entry, Tailwind class). */
  ringClass?: string | null;
  /** Extra classes on the truncating label span (e.g. `italic line-through`). */
  labelClassName?: ClassName | null;
  /** Shrink-0 content rendered before the label (e.g. a status icon). */
  leading?: ReactNode;
  /** Optional trailing inline content. */
  badge?: ReactNode;
  /** Hover-revealed corner overlay (editor mode, e.g. a delete button). */
  actions?: ReactNode;
  /** Opt this node into visible, draggable connect handles (requires canvas `connectable`). */
  connectable?: boolean;
}

/** Edge stroke color, mapped to a theme token inside the primitive. */
export type GraphCanvasEdgeTone = "default" | "muted" | "success";

/** A single directed edge `from → to` in the generic graph canvas. */
export interface GraphCanvasEdge {
  from: string;
  to: string;
  /** Line style; consumers map domain kinds onto this (e.g. hard→solid, soft→dashed). */
  variant?: "solid" | "dashed";
  /** Semantic stroke color (orthogonal to `variant`). */
  tone?: GraphCanvasEdgeTone;
  emphasized?: boolean;
  /** Hover-revealed mid-edge overlay (editor mode, e.g. insert / remove buttons). */
  actions?: ReactNode;
}

/** A labeled background rectangle enclosing a set of member nodes. */
export interface GraphCanvasGroup {
  id: string;
  label: string;
  /** Member node ids; the primitive computes the bounding box from their positions. */
  memberIds: string[];
  /** Background + border classes (caller resolves any palette / depth). */
  bgClassName?: ClassName | null;
  /** Classes for the corner label. */
  labelClassName?: ClassName | null;
}

export interface GraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  /** Background rectangles drawn behind the nodes they enclose. */
  groups?: GraphCanvasGroup[];
  /** Node to emphasize + fit around. */
  focusId?: string;
  /** dagre rankdir, default "LR". */
  direction?: "LR" | "TB";
  /** Enable drag-to-connect (editor mode). Default false (read-only viewer). */
  connectable?: boolean;
  /** Fired when a connection is drawn (editor mode). */
  onConnect?: (source: string, target: string) => void;
  /** Edge path shape, default "bezier". */
  edgePath?: "bezier" | "smoothstep";
  /** Minimum zoom, default 0.3. */
  minZoom?: number;
  /**
   * What activating node `id` does (`undefined`: the node is inert). A
   * `LinkTarget` gets the full link gestures — ⌘/Ctrl- and middle-click open
   * its `href()` in a new browser tab — a plain action only the plain click.
   */
  nodeActivation?: (id: string) => Activation | undefined;
}

const NODE_TYPES = {
  [CANVAS_NODE_TYPE]: CanvasNode,
  [GROUP_BG_TYPE]: GroupBackground,
};
const EDGE_TYPES = { [CANVAS_EDGE_TYPE]: CanvasEdge };

const EDGE_TONE_STROKE: Record<GraphCanvasEdgeTone, string> = {
  default: "var(--foreground)",
  muted: "var(--muted-foreground)",
  success: "var(--success)",
};

function layout(
  nodes: GraphCanvasNode[],
  edges: GraphCanvasEdge[],
  groups: GraphCanvasGroup[],
  direction: "LR" | "TB",
  edgePath: "bezier" | "smoothstep",
): { flowNodes: Node[]; flowEdges: Edge[] } {
  // Sort by id for a stable node-insertion order regardless of focus (dagre's
  // crossing-minimization is order-sensitive).
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(sorted.map((n) => n.id));

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 24,
    ranksep: 60,
    marginx: 12,
    marginy: 12,
  });

  for (const n of sorted) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const isLR = direction === "LR";
  const flowNodes: CanvasFlowNode[] = sorted.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: CANVAS_NODE_TYPE,
      data: {
        label: n.label,
        title: n.title,
        tintClass: n.tintClass,
        ringClass: n.ringClass,
        labelClassName: n.labelClassName,
        leading: n.leading,
        badge: n.badge,
        actions: n.actions,
        connectable: n.connectable,
      },
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      sourcePosition: isLR ? Position.Right : Position.Bottom,
      targetPosition: isLR ? Position.Left : Position.Top,
    };
  });

  const flowEdges: Edge[] = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => {
      const dashed = e.variant === "dashed";
      const stroke = e.tone
        ? EDGE_TONE_STROKE[e.tone]
        : dashed
          ? "var(--muted-foreground)"
          : "var(--foreground)";
      // Only attach the custom edge type when it adds something (hover actions or
      // a non-default path shape); plain edges stay xyflow's built-in bezier so
      // the read-only viewer is unchanged.
      const needsCustom = e.actions != null || edgePath === "smoothstep";
      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        ...(needsCustom
          ? { type: CANVAS_EDGE_TYPE, data: { actions: e.actions, edgePath } }
          : {}),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stroke,
          width: 14,
          height: 14,
        },
        style: {
          stroke,
          strokeWidth: e.emphasized ? 2 : 1.5,
          strokeDasharray: dashed ? "4 3" : undefined,
        },
      };
    });

  // Group backgrounds: computed from member node positions AFTER layout, excluded
  // from dagre, and prepended so they render behind the real nodes.
  const bgNodes: GroupBgFlowNode[] = [];
  for (const grp of groups) {
    const positions = grp.memberIds.map((id) => g.node(id)).filter(Boolean);
    if (positions.length === 0) continue;
    const minX =
      Math.min(...positions.map((p) => p.x - NODE_WIDTH / 2)) - GROUP_PAD;
    const minY =
      Math.min(...positions.map((p) => p.y - NODE_HEIGHT / 2)) -
      GROUP_PAD -
      GROUP_LABEL_HEIGHT;
    const maxX =
      Math.max(...positions.map((p) => p.x + NODE_WIDTH / 2)) + GROUP_PAD;
    const maxY =
      Math.max(...positions.map((p) => p.y + NODE_HEIGHT / 2)) + GROUP_PAD;
    bgNodes.push({
      id: grp.id,
      type: GROUP_BG_TYPE,
      data: {
        label: grp.label,
        bgClassName: grp.bgClassName,
        labelClassName: grp.labelClassName,
      },
      position: { x: minX, y: minY },
      style: { width: maxX - minX, height: maxY - minY, pointerEvents: "none" },
      selectable: false,
      draggable: false,
    });
  }

  return { flowNodes: [...bgNodes, ...flowNodes], flowEdges };
}

function GraphCanvasInner({
  flowNodes,
  flowEdges,
  focusId,
  fitKey,
  connectable,
  onConnect,
  minZoom,
  nodeActivation,
}: {
  flowNodes: Node[];
  flowEdges: Edge[];
  focusId?: string;
  fitKey: string;
  connectable: boolean;
  onConnect?: (source: string, target: string) => void;
  minZoom: number;
  nodeActivation?: (id: string) => Activation | undefined;
}) {
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target)
        onConnect?.(connection.source, connection.target);
    },
    [onConnect],
  );

  // Re-fit on container resize (initial settle, pane/sidebar toggles, window
  // resize) and whenever the node set / focus changes. The primitive RAF-
  // debounces resize callbacks and runs the initial fit synchronously on mount.
  useResizeObserver(
    containerRef,
    () => {
      void fitView({ padding: 0.15, maxZoom: 1 });
    },
    { deps: [fitKey, focusId, fitView] },
  );

  // React Flow reports a node's plain (and ⌘-) click through `onNodeClick`, but
  // has no aux-click hook: the middle button is read off the container, the
  // node resolved from the DOM node xyflow stamps with `data-id`.
  const activationAt = (e: MouseEvent): Activation | undefined => {
    if (!(e.target instanceof Element)) return undefined;
    // A node's own controls (an `actions` overlay button) own their clicks.
    if (e.target.closest("button")) return undefined;
    const el = e.target.closest<HTMLElement>(".react-flow__node");
    // Background/group nodes are not navigable.
    if (!el || el.classList.contains(`react-flow__node-${GROUP_BG_TYPE}`)) {
      return undefined;
    }
    const id = el.dataset.id;
    return id === undefined ? undefined : nodeActivation?.(id);
  };

  return (
    <div
      ref={containerRef}
      className="bg-muted/30 size-full"
      onAuxClick={(e) => activationProps(activationAt(e)).onAuxClick?.(e)}
      onMouseDown={(e) => activationProps(activationAt(e)).onMouseDown?.(e)}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={false}
        nodesConnectable={connectable}
        edgesFocusable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        onNodeClick={(e, node) => {
          // Background/group nodes are not navigable.
          if (node.type === GROUP_BG_TYPE) return;
          activationProps(nodeActivation?.(node.id)).onClick?.(e);
        }}
        onConnect={handleConnect}
        connectionRadius={20}
        connectionLineType={ConnectionLineType.SmoothStep}
        proOptions={{ hideAttribution: true }}
        minZoom={minZoom}
        maxZoom={1.5}
      >
        <Background gap={16} size={1} />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas({
  nodes,
  edges,
  groups,
  focusId,
  direction = "LR",
  connectable = false,
  onConnect,
  edgePath = "bezier",
  minZoom = 0.3,
  nodeActivation,
}: GraphCanvasProps) {
  const { flowNodes, flowEdges } = useMemo(
    () => layout(nodes, edges, groups ?? [], direction, edgePath),
    [nodes, edges, groups, direction, edgePath],
  );
  // A cheap key that changes whenever the node/group set changes, so the inner re-fits.
  const fitKey = useMemo(
    () =>
      [...nodes.map((n) => n.id), ...(groups ?? []).map((grp) => grp.id)].join(
        "|",
      ),
    [nodes, groups],
  );

  return (
    <ReactFlowProvider>
      <GraphCanvasInner
        flowNodes={flowNodes}
        flowEdges={flowEdges}
        focusId={focusId}
        fitKey={fitKey}
        connectable={connectable}
        onConnect={onConnect}
        minZoom={minZoom}
        nodeActivation={nodeActivation}
      />
    </ReactFlowProvider>
  );
}
