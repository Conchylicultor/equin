import type { ReactNode } from "react";
import { useTransient } from "@plugins/primitives/plugins/kept-state/web";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  cn,
  SURFACE_LEVELS,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";

export const CANVAS_NODE_TYPE = "graphCanvas";

export type CanvasNodeData = {
  label: string;
  title?: string;
  tintClass?: string | null;
  ringClass?: string | null;
  /** Extra classes on the truncating label span (e.g. `italic line-through`). */
  labelClassName?: ClassName | null;
  /** Shrink-0 content rendered before the label (e.g. a status icon). */
  leading?: ReactNode;
  badge?: ReactNode;
  /** Hover-revealed corner overlay (e.g. a delete button). */
  actions?: ReactNode;
  /** Opt this node into visible, draggable connect handles (editor mode). */
  connectable?: boolean;
};

export type CanvasFlowNode = Node<CanvasNodeData, typeof CANVAS_NODE_TYPE>;

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 36;

const EDITOR_HANDLE_CLASS =
  "!bg-muted-foreground/60 !border-border !w-2.5 !h-2.5 !rounded-full";

export function CanvasNode({ data }: NodeProps<CanvasFlowNode>) {
  const {
    label,
    title,
    tintClass,
    ringClass,
    labelClassName,
    leading,
    badge,
    actions,
    connectable,
  } = data;
  const [hovered, setHovered] = useTransient(
    "hover: gone with the pointer",
    false,
  );

  // Connectable handles are visible on hover; otherwise handles stay hidden but
  // mounted so xyflow can still anchor edges (read-only viewer default).
  const handleStyle = connectable
    ? {
        opacity: hovered ? 1 : 0,
        transition: "opacity 150ms",
        cursor: "crosshair",
      }
    : undefined;

  return (
    <Stack
      direction="row"
      align="center"
      gap="sm"
      title={title ?? label}
      className={cn(
        // The raised-surface chrome (rounded + border + bg-card + shadow) routed
        // through the single source of truth, so a preset swap re-themes nodes
        // with every other card. We use the class map directly (not <Surface>) to
        // avoid the component's baked-in Ctrl+A select-scope, which is unwanted on
        // an interactive xyflow node. tintClass/ringClass intentionally trail so a
        // node's accent overrides the base border/bg.
        SURFACE_LEVELS.raised,
        "text-foreground relative h-9 px-sm text-caption transition-colors",
        "hover:border-foreground/40 focus:outline-none cursor-pointer",
        tintClass,
        ringClass,
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={connectable ? EDITOR_HANDLE_CLASS : "!opacity-0"}
        isConnectable={connectable ?? false}
        style={handleStyle}
      />
      {leading != null && <Rigid as="span">{leading}</Rigid>}
      <Fill as="span" className={cn("truncate", labelClassName)}>
        {label}
      </Fill>
      {badge != null && <Rigid as="span">{badge}</Rigid>}
      <Handle
        type="source"
        position={Position.Right}
        className={connectable ? EDITOR_HANDLE_CLASS : "!opacity-0"}
        isConnectable={connectable ?? false}
        style={handleStyle}
      />
      {actions != null && (
        <div
          // eslint-disable-next-line layout/no-adhoc-layout -- corner action overlay at fixed -8px pixel offset (off the spacing ramp; not a Pin anchor)
          className="nodrag nopan pointer-events-auto absolute"
          style={{
            top: -8,
            right: -8,
            opacity: hovered ? 1 : 0,
            transition: "opacity 150ms",
          }}
        >
          {actions}
        </div>
      )}
    </Stack>
  );
}
