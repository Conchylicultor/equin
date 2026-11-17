import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import type { ReactNode } from "react";
import { useTransient } from "@plugins/primitives/plugins/kept-state/web";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

export const CANVAS_EDGE_TYPE = "graphCanvasEdge";

export type CanvasEdgeData = {
  /** Hover-revealed mid-edge overlay (e.g. insert / remove buttons). */
  actions?: ReactNode;
  edgePath?: "bezier" | "smoothstep";
};

export type CanvasFlowEdge = Edge<CanvasEdgeData, typeof CANVAS_EDGE_TYPE>;

export function CanvasEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const [hovered, setHovered] = useTransient(
    "hover: gone with the pointer",
    false,
  );

  const pathArgs = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  };
  const [edgePath, labelX, labelY] =
    data?.edgePath === "smoothstep"
      ? getSmoothStepPath(pathArgs)
      : getBezierPath(pathArgs);

  const actions = data?.actions;
  if (actions == null) {
    return <BaseEdge path={edgePath} style={style} markerEnd={markerEnd} />;
  }

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Wider invisible hit area for hover detection. */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={20} />
      <BaseEdge path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {/* The placed box is the OUTER element, so xyflow's `nodrag`/`nopan`
            markers and `pointer-events-auto` sit on what is actually under the
            pointer — not on a Stack nested inside it. `center` on both axes is
            the old `translate(-50%, -50%)`, as the `translate` property. */}
        <Placed
          x={{ center: labelX }}
          y={{ center: labelY }}
          className="nodrag nopan pointer-events-auto"
          style={{ opacity: hovered ? 1 : 0, transition: "opacity 150ms" }}
        >
          <Stack direction="row" gap="xs" align="center">
            {actions}
          </Stack>
        </Placed>
      </EdgeLabelRenderer>
    </g>
  );
}
