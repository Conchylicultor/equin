import { useMemo } from "react";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { parseMermaid, type Flowchart as FlowchartModel } from "../../core";
import { SequenceDiagram } from "./sequence/sequence-diagram";
import "./stage.css";

// The layout engine (dagre) loads with the first flowchart.
const Flowchart = lazyComponent<{ diagram: FlowchartModel }>(
  () =>
    import("./flowchart/flowchart-impl").then((m) => ({
      default: m.Flowchart,
    })),
  { fallback: null },
);

// Mermaid is a multi-megabyte package: only a diagram the native renderers do
// not draw loads it.
const MermaidSvg = lazyComponent<{ source: string }>(
  () =>
    import("./svg/mermaid-svg-impl").then((m) => ({ default: m.MermaidSvg })),
  { fallback: null },
);

/**
 * A mermaid source, drawn natively when it is a sequence diagram or a flowchart
 * the parser reads, and by Mermaid itself otherwise — another diagram type, a
 * construct the native renderers do not model, or a source with a syntax error
 * (which Mermaid reports). Native diagrams are drawn on their own stage (one
 * surface every part of them shares, stage.css) at the text's own size, and
 * scroll sideways when wider than the frame.
 */
export function MermaidPreview({ source }: { source: string }) {
  const parsed = useMemo(() => parseMermaid(source), [source]);
  switch (parsed.kind) {
    case "sequence":
    case "flowchart":
      return (
        <div className="mmd-stage">
          <Scroll axis="x">
            <Inset pad="xl">
              {parsed.kind === "sequence" ? (
                <SequenceDiagram diagram={parsed.diagram} />
              ) : (
                <Flowchart diagram={parsed.diagram} />
              )}
            </Inset>
          </Scroll>
        </div>
      );
    case "unsupported":
      return <MermaidSvg source={source} />;
  }
}
