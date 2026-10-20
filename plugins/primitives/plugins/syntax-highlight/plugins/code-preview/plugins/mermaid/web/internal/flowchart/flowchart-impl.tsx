import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  FlowEdge,
  FlowNode,
  Flowchart as FlowchartModel,
} from "../../../core";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { participantHue } from "../hues";
import {
  arrivalAngle,
  edgeKeys,
  edgePath,
  layoutFlowchart,
  shapeSize,
  type FlowLayout,
  type Size,
} from "./layout";
import "./flowchart.css";

const HEAD = 9;

type Box = { x: number; y: number; width: number; height: number };

/**
 * A flowchart drawn natively: nodes are HTML cards measured where they render,
 * laid out by dagre at their real size, joined by smooth SVG edges with label
 * pills; subgraphs are tinted frames. Drawn at natural size — the caller's
 * scroller handles a wide one. Hovering a node traces its edges.
 *
 * Every label stays the same DOM element from first render on, so the size
 * observer keeps watching it across layouts.
 */
export function Flowchart({ diagram }: { diagram: FlowchartModel }) {
  const labelRefs = useRef(new Map<string, HTMLElement>());
  const edgeLabelRefs = useRef(new Map<string, HTMLElement>());
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const keys = useMemo(() => edgeKeys(diagram), [diagram]);

  // Measured synchronously before paint for each new source, then again
  // whenever a label changes size (a web font landing, an edited label).
  useResizeObserver(
    () => [...labelRefs.current.values(), ...edgeLabelRefs.current.values()],
    () => {
      const nodeSizes = new Map<string, Size>();
      for (const node of diagram.nodes) {
        const el = labelRefs.current.get(node.id);
        if (!el)
          throw new Error(`flowchart: node ${node.id} has no rendered label`);
        nodeSizes.set(
          node.id,
          shapeSize(node.shape, {
            width: el.offsetWidth,
            height: el.offsetHeight,
          }),
        );
      }
      const labelSizes = new Map<string, Size>();
      for (const [key, el] of edgeLabelRefs.current) {
        labelSizes.set(key, {
          width: el.offsetWidth + 8,
          height: el.offsetHeight + 4,
        });
      }
      setLayout(layoutFlowchart(diagram, nodeSizes, labelSizes));
    },
    { deps: [diagram] },
  );

  const groupHue = new Map(diagram.groups.map((g, i) => [g.id, i]));
  const touches = (e: FlowEdge) =>
    hot !== null && (e.from === hot || e.to === hot);

  return (
    <div
      className="mmd-flow"
      data-laid-out={layout ? "" : undefined}
      style={
        layout ? { width: layout.width, height: layout.height } : undefined
      }
    >
      {diagram.groups.map((group) => {
        const box = layout?.groups.get(group.id);
        if (!box) return null;
        return (
          <Placed
            key={group.id}
            className="mmd-flow-group"
            style={
              {
                "--mmd-hue": participantHue(groupHue.get(group.id)! + 2),
              } as CSSProperties
            }
            x={{ center: box.x, size: box.width }}
            y={{ center: box.y, size: box.height }}
          >
            <span className="mmd-flow-group-label">{group.label}</span>
          </Placed>
        );
      })}

      {layout ? (
        <svg
          className="mmd-flow-wires"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {diagram.edges.map((edge, i) => {
            const at = layout.edges.get(keys[i]!);
            return at ? (
              <Wire
                key={keys[i]}
                edge={edge}
                points={at.points}
                hot={touches(edge)}
              />
            ) : null;
          })}
        </svg>
      ) : null}

      {diagram.nodes.map((node) => (
        <NodeBox
          key={node.id}
          node={node}
          box={layout?.nodes.get(node.id) ?? null}
          hot={hot === node.id}
          labelRef={(el) => {
            if (el) labelRefs.current.set(node.id, el);
            else labelRefs.current.delete(node.id);
          }}
          onHover={(on) => setHot(on ? node.id : null)}
        />
      ))}

      {diagram.edges.map((edge, i) => {
        if (edge.label === null || edge.label === "") return null;
        const key = keys[i]!;
        const at = layout?.edges.get(key)?.label ?? null;
        return (
          <Placed
            key={key}
            className="mmd-flow-edge-label-box"
            data-pending={at ? undefined : ""}
            x={at ? { center: at.x } : { start: 0 }}
            y={at ? { center: at.y } : { start: 0 }}
          >
            <span
              ref={(el) => {
                if (el) edgeLabelRefs.current.set(key, el);
                else edgeLabelRefs.current.delete(key);
              }}
              className="mmd-flow-edge-label"
              data-hot={touches(edge) ? "" : undefined}
            >
              {edge.label}
            </span>
          </Placed>
        );
      })}
    </div>
  );
}

function NodeBox({
  node,
  box,
  hot,
  labelRef,
  onHover,
}: {
  node: FlowNode;
  box: Box | null;
  hot: boolean;
  labelRef: (el: HTMLElement | null) => void;
  onHover: (on: boolean) => void;
}) {
  // One element whether laid out or not, so its label is never remounted (the
  // observer keeps watching it): unplaced, it waits invisibly at the origin.
  return (
    <Placed
      className="mmd-flow-node"
      data-shape={node.shape}
      data-hot={hot ? "" : undefined}
      data-pending={box ? undefined : ""}
      x={box ? { center: box.x, size: box.width } : { start: 0 }}
      y={box ? { center: box.y, size: box.height } : { start: 0 }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {box ? (
        <ShapeOutline
          shape={node.shape}
          width={box.width}
          height={box.height}
        />
      ) : null}
      <span ref={labelRef} className="mmd-flow-node-label">
        {node.label}
      </span>
    </Placed>
  );
}

/** Shapes a CSS border cannot draw (diamond, hexagon, cylinder), as SVG. */
function ShapeOutline({
  shape,
  width: w,
  height: h,
}: {
  shape: FlowNode["shape"];
  width: number;
  height: number;
}): ReactNode {
  const s = 1; // half the stroke, so the outline sits inside the box
  let d: string | null = null;
  if (shape === "decision") {
    d = `M${w / 2},${s} L${w - s},${h / 2} L${w / 2},${h - s} L${s},${h / 2} Z`;
  } else if (shape === "hexagon") {
    const k = Math.min(h * 0.45, w / 4);
    d = `M${k},${s} L${w - k},${s} L${w - s},${h / 2} L${w - k},${h - s} L${k},${h - s} L${s},${h / 2} Z`;
  } else if (shape === "database") {
    const ry = 7;
    d =
      `M${s},${ry} A${w / 2 - s},${ry} 0 0 1 ${w - s},${ry} L${w - s},${h - ry} ` +
      `A${w / 2 - s},${ry} 0 0 1 ${s},${h - ry} Z M${s},${ry} A${w / 2 - s},${ry} 0 0 0 ${w - s},${ry}`;
  }
  if (!d) return null;
  return (
    <svg className="mmd-flow-shape" width={w} height={h} aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Wire({
  edge,
  points,
  hot,
}: {
  edge: FlowEdge;
  points: ReadonlyArray<{ x: number; y: number }>;
  hot: boolean;
}) {
  if (points.length < 2) return null;
  const headLen = edge.head === "arrow" ? HEAD : edge.head === "none" ? 0 : 4;
  return (
    <g
      className="mmd-flow-wire"
      data-line={edge.line}
      data-hot={hot ? "" : undefined}
    >
      <path
        className="mmd-flow-wire-line"
        d={edgePath(points, headLen, edge.bidirectional ? headLen : 0)}
      />
      <Head
        kind={edge.head}
        at={points.at(-1)!}
        angle={arrivalAngle(points, false)}
      />
      {edge.bidirectional ? (
        <Head
          kind={edge.head}
          at={points[0]!}
          angle={arrivalAngle(points, true)}
        />
      ) : null}
    </g>
  );
}

function Head({
  kind,
  at,
  angle,
}: {
  kind: FlowEdge["head"];
  at: { x: number; y: number };
  angle: number;
}) {
  const transform = `translate(${at.x},${at.y}) rotate(${(angle * 180) / Math.PI})`;
  switch (kind) {
    case "arrow":
      return (
        <path
          className="mmd-flow-head"
          transform={transform}
          d={`M0,0 L${-HEAD},${-HEAD / 2 - 0.5} L${-HEAD},${HEAD / 2 + 0.5} Z`}
        />
      );
    case "circle":
      return (
        <circle
          className="mmd-flow-head-ring"
          transform={transform}
          cx={-4}
          cy={0}
          r={4}
        />
      );
    case "cross":
      return (
        <path
          className="mmd-flow-head-cross"
          transform={transform}
          d="M-8,-4 L0,4 M-8,4 L0,-4"
        />
      );
    case "none":
      return null;
  }
}
