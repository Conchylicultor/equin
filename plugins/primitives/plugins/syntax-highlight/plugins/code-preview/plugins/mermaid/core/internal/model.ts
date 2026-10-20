/**
 * The diagrams the native renderers draw, as plain data — what a Mermaid
 * source says, with none of how Mermaid draws it.
 */

// ── Sequence ────────────────────────────────────────────────────────────────

export interface SequenceParticipant {
  id: string;
  label: string;
  /** `actor` draws a person; `participant` a box. */
  kind: "participant" | "actor";
}

export interface SequenceMessage {
  kind: "message";
  from: string;
  to: string;
  text: string;
  /** `-->>` / `-->` / `--x` / `--)` are dashed: a reply, by convention. */
  line: "solid" | "dashed";
  head: "arrow" | "open" | "cross" | "async";
  /** `<<->>`: arrows at both ends. */
  bidirectional: boolean;
}

export interface SequenceNote {
  kind: "note";
  placement: "over" | "left" | "right";
  /** One participant, or two for a note spanning them (`over A,B`). */
  over: readonly string[];
  text: string;
}

export const SEQUENCE_BLOCK_TYPES = [
  "loop",
  "alt",
  "opt",
  "par",
  "critical",
  "break",
  "rect",
] as const;
export type SequenceBlockType = (typeof SEQUENCE_BLOCK_TYPES)[number];

export interface SequenceBlockSection {
  /** The condition / label after the keyword (or after `else` / `and`). */
  label: string;
  items: readonly SequenceItem[];
}

export interface SequenceBlock {
  kind: "block";
  type: SequenceBlockType;
  /** The first section is the block's own; each `else` / `and` / `option` opens another. */
  sections: readonly SequenceBlockSection[];
}

export type SequenceItem = SequenceMessage | SequenceNote | SequenceBlock;

export interface SequenceDiagram {
  title: string | null;
  participants: readonly SequenceParticipant[];
  items: readonly SequenceItem[];
}

// ── Flowchart ───────────────────────────────────────────────────────────────

export type FlowDirection = "TB" | "BT" | "LR" | "RL";

export type FlowNodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "database"
  | "circle"
  | "decision"
  | "hexagon";

export interface FlowNode {
  id: string;
  label: string;
  shape: FlowNodeShape;
  /** The subgraph that holds it, or null at the top level. */
  group: string | null;
  /**
   * The Mermaid classes the source gives it (`A:::key`, `class A,B key`), in
   * first-given order. The native renderer draws its own look, so a class only
   * says the author singled the node out — it is drawn as a key node.
   */
  classes: readonly string[];
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string | null;
  line: "solid" | "dotted" | "thick";
  head: "arrow" | "none" | "circle" | "cross";
  /** `<-->`: the head at both ends. */
  bidirectional: boolean;
}

export interface FlowGroup {
  id: string;
  label: string;
  /** The enclosing subgraph, or null at the top level. */
  parent: string | null;
}

export interface Flowchart {
  direction: FlowDirection;
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  groups: readonly FlowGroup[];
}

// ── Parse result ────────────────────────────────────────────────────────────

/**
 * What a Mermaid source is, for the native renderers. `unsupported` is not an
 * error: it says "this is not something drawn natively" (another diagram type, a
 * construct outside the modelled subset, or a line that does not read), and the
 * caller hands the source to Mermaid itself — which is also what reports a real
 * syntax error.
 */
export type MermaidParse =
  | { kind: "sequence"; diagram: SequenceDiagram }
  | { kind: "flowchart"; diagram: Flowchart }
  | { kind: "unsupported"; reason: string };
