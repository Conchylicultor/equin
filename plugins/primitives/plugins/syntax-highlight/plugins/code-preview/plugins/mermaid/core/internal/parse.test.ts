import { describe, expect, test } from "bun:test";
import { parseMermaid } from "./parse";
import type { Flowchart, MermaidParse, SequenceDiagram } from "./model";

function sequence(src: string): SequenceDiagram {
  const r = parseMermaid(src);
  if (r.kind !== "sequence")
    throw new Error(`expected sequence, got ${JSON.stringify(r)}`);
  return r.diagram;
}
function flowchart(src: string): Flowchart {
  const r = parseMermaid(src);
  if (r.kind !== "flowchart")
    throw new Error(`expected flowchart, got ${JSON.stringify(r)}`);
  return r.diagram;
}
function kind(src: string): MermaidParse["kind"] {
  return parseMermaid(src).kind;
}

describe("parseMermaid — sequence", () => {
  test("participants, aliases, arrows and notes", () => {
    const d = sequence(`sequenceDiagram
      autonumber
      participant CLI as CLI (claude)
      actor U as User
      %% a comment
      CLI->>SDK: tool_use AskUserQuestion
      Note over SDK: canUseTool() parks
      SDK-->>CLI: allow<br/>answers
      SDK-)question-relay: async
      U-xCLI: lost
      Note over CLI,SDK: spans both`);
    expect(d.participants.map((p) => [p.id, p.label, p.kind])).toEqual([
      ["CLI", "CLI (claude)", "participant"],
      ["U", "User", "actor"],
      ["SDK", "SDK", "participant"],
      ["question-relay", "question-relay", "participant"],
    ]);
    expect(
      d.items.map((i) =>
        i.kind === "message"
          ? [i.from, i.to, i.line, i.head, i.text]
          : [i.kind],
      ),
    ).toEqual([
      ["CLI", "SDK", "solid", "arrow", "tool_use AskUserQuestion"],
      ["note"],
      ["SDK", "CLI", "dashed", "arrow", "allow\nanswers"],
      ["SDK", "question-relay", "solid", "async", "async"],
      ["U", "CLI", "solid", "cross", "lost"],
      ["note"],
    ]);
    const last = d.items.at(-1);
    expect(last?.kind === "note" && last.over).toEqual(["CLI", "SDK"]);
  });

  test("activation suffixes are dropped from the target", () => {
    const d = sequence("sequenceDiagram\nA->>+B: go\nB-->>-A: back");
    expect(d.participants.map((p) => p.id)).toEqual(["A", "B"]);
  });

  test("blocks nest with their sections", () => {
    const d = sequence(`sequenceDiagram
      loop every minute
        A->>B: ping
        alt ok
          B-->>A: pong
        else timeout
          A->>A: retry
        end
      end`);
    expect(d.items).toHaveLength(1);
    const loop = d.items[0]!;
    if (loop.kind !== "block") throw new Error("expected block");
    expect(loop.type).toBe("loop");
    expect(loop.sections[0]!.label).toBe("every minute");
    const alt = loop.sections[0]!.items[1]!;
    if (alt.kind !== "block") throw new Error("expected nested block");
    expect(alt.sections.map((s) => s.label)).toEqual(["ok", "timeout"]);
  });

  test("unmodelled constructs and unread lines fall back", () => {
    expect(kind("sequenceDiagram\nbox Aqua Group\nparticipant A\nend")).toBe(
      "unsupported",
    );
    expect(kind("sequenceDiagram\nA->>B hello")).toBe("unsupported");
    expect(kind("sequenceDiagram\nloop x\nA->>B: y")).toBe("unsupported");
  });
});

describe("parseMermaid — flowchart", () => {
  test("shapes, labels and link kinds", () => {
    const d = flowchart(`flowchart LR
      A[Start] --> B(Round) -.-> C{Decide?}
      C -->|yes| D[(DB)]
      C -- no --> E([Stadium])
      E ==> F((Circle))
      F --- G{{Hex}}
      G --o H["quoted [label]"]
      H <--> I[[Sub]]`);
    expect(d.direction).toBe("LR");
    expect(
      Object.fromEntries(d.nodes.map((n) => [n.id, [n.label, n.shape]])),
    ).toEqual({
      A: ["Start", "rect"],
      B: ["Round", "round"],
      C: ["Decide?", "decision"],
      D: ["DB", "database"],
      E: ["Stadium", "stadium"],
      F: ["Circle", "circle"],
      G: ["Hex", "hexagon"],
      H: ["quoted [label]", "rect"],
      I: ["Sub", "subroutine"],
    });
    expect(
      d.edges.map((e) => [
        e.from,
        e.to,
        e.line,
        e.head,
        e.label,
        e.bidirectional,
      ]),
    ).toEqual([
      ["A", "B", "solid", "arrow", null, false],
      ["B", "C", "dotted", "arrow", null, false],
      ["C", "D", "solid", "arrow", "yes", false],
      ["C", "E", "solid", "arrow", "no", false],
      ["E", "F", "thick", "arrow", null, false],
      ["F", "G", "solid", "none", null, false],
      ["G", "H", "solid", "circle", null, false],
      ["H", "I", "solid", "arrow", null, true],
    ]);
  });

  test("graph TD, & fan-out, ; separators, dashed ids and styling are read", () => {
    const d = flowchart(`graph TD
      a-1 & b --> c; c --> d:::hot
      classDef hot fill:#f00
      style c stroke:#333`);
    expect(d.direction).toBe("TB");
    expect(d.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      "a-1>c",
      "b>c",
      "c>d",
    ]);
  });

  test("a node's classes are kept, from `:::` and `class` statements", () => {
    const d = flowchart(`flowchart TB
      class a,b key
      a --> b:::hot --> c
      class b key`);
    expect(Object.fromEntries(d.nodes.map((n) => [n.id, n.classes]))).toEqual({
      a: ["key"],
      b: ["hot", "key"],
      c: [],
    });
  });

  // As in Mermaid: a top-level node a subgraph mentions moves into it; one
  // already in a subgraph stays in that one.
  test("subgraphs own the nodes they mention", () => {
    const d = flowchart(`flowchart TB
      X --> Y
      subgraph api [API layer]
        Y --> Z
        subgraph db
          Z --> W
        end
      end`);
    expect(d.groups).toEqual([
      { id: "api", label: "API layer", parent: null },
      { id: "db", label: "db", parent: "api" },
    ]);
    expect(Object.fromEntries(d.nodes.map((n) => [n.id, n.group]))).toEqual({
      X: null,
      Y: "api",
      Z: "api",
      W: "db",
    });
  });

  test("other diagram types and edges to subgraphs fall back", () => {
    expect(kind("gantt\ntitle x")).toBe("unsupported");
    expect(kind("flowchart TB\nsubgraph s\nA\nend\nB --> s")).toBe(
      "unsupported",
    );
    expect(kind("flowchart TB\nA -->")).toBe("unsupported");
  });
});
