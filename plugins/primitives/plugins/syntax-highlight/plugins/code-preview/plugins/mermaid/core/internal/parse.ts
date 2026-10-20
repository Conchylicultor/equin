import type { FlowDirection, MermaidParse } from "./model";
import { parseFlowchart } from "./parse-flowchart";
import { parseSequence } from "./parse-sequence";
import { statementLines } from "./text";

const FLOW_HEADER = /^(?:flowchart|graph)(?:\s+(TB|TD|BT|RL|LR))?\s*;?$/;

/**
 * Reads a Mermaid source into a diagram the native renderers draw, or says it is
 * not one of those (`unsupported`) — another diagram type, a construct outside
 * the modelled subset, or a line that does not read.
 */
export function parseMermaid(source: string): MermaidParse {
  const lines = statementLines(source);
  const [header, ...body] = lines;
  if (!header) return { kind: "unsupported", reason: "empty" };
  if (/^sequenceDiagram\s*$/.test(header.text)) return parseSequence(body);
  const flow = FLOW_HEADER.exec(header.text);
  if (flow) {
    const dir = flow[1] ?? "TB";
    const direction: FlowDirection =
      dir === "TD" ? "TB" : (dir as FlowDirection);
    return parseFlowchart(body, direction);
  }
  return {
    kind: "unsupported",
    reason: `${header.text.split(/\s/)[0]} diagrams are drawn by Mermaid`,
  };
}
