import type {
  FlowDirection,
  FlowEdge,
  FlowGroup,
  FlowNode,
  FlowNodeShape,
  MermaidParse,
} from "./model";
import { cleanLabel } from "./text";

// Openers longest first: `([` must win over `(`, `[[` over `[`.
const SHAPES: ReadonlyArray<{
  open: string;
  close: string;
  shape: FlowNodeShape;
}> = [
  { open: "(((", close: ")))", shape: "circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "database" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "rect" },
  { open: "[/", close: "\\]", shape: "rect" },
  { open: "[\\", close: "\\]", shape: "rect" },
  { open: "[\\", close: "/]", shape: "rect" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "decision" },
  { open: ">", close: "]", shape: "rect" },
];

const NODE_ID =
  /^[\p{L}\p{N}_$]+(?:[-.](?![-.>=ox](?:[\s>]|$))[\p{L}\p{N}_$]+)*/u;
// `A -- text --> B`, `A -. text .-> B`, `A == text ==> B` (the label inside the link).
const TEXT_LINKS: ReadonlyArray<{ re: RegExp; line: FlowEdge["line"] }> = [
  { re: /^(<)?--(?![-.>]|[ox]\s)\s*(.+?)\s*--+(>|o|x)?/, line: "solid" },
  { re: /^(<)?-\.(?![-.>])\s*(.+?)\s*\.-+(>|o|x)?/, line: "dotted" },
  { re: /^(<)?==(?![=>])\s*(.+?)\s*==+(>|o|x)?/, line: "thick" },
];
// `-->`, `---`, `-.->`, `-.-`, `==>`, `===`, `--o`, `--x`, `<-->`, `~~~`.
const PLAIN_LINK = /^(<|o|x)?(-{2,}|={2,}|-\.+-|~{3,})(>|o|x)?/;
const PIPE_LABEL = /^\s*\|([^|]*)\|/;
// Styling and interaction: the native renderer draws its own look.
const IGNORED =
  /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

const HEADS: Record<string, FlowEdge["head"]> = {
  ">": "arrow",
  o: "circle",
  x: "cross",
};

export function parseFlowchart(
  lines: ReadonlyArray<{ line: number; text: string }>,
  direction: FlowDirection,
): MermaidParse {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const groups: FlowGroup[] = [];
  const stack: string[] = [];

  // `class A,B name` may come before or after the nodes it names.
  const assigned: Array<{ ids: string[]; cls: string }> = [];
  const reference = (
    id: string,
    label?: string,
    shape?: FlowNodeShape,
    cls?: string,
  ) => {
    const existing = nodes.get(id);
    const classes = existing?.classes ?? [];
    // A top-level node a subgraph mentions moves into it; a node already in a
    // subgraph stays where it was first placed.
    const group = existing?.group ?? stack.at(-1) ?? null;
    nodes.set(id, {
      id,
      // The last definition wins, as in Mermaid; a bare mention keeps it.
      label: label ?? existing?.label ?? id,
      shape: shape ?? existing?.shape ?? "rect",
      group,
      classes: cls && !classes.includes(cls) ? [...classes, cls] : classes,
    });
  };

  for (const { line, text: raw } of lines) {
    for (const text of splitStatements(raw)) {
      const cls = /^class\s+([^\s]+)\s+([\w-]+)$/.exec(text);
      if (cls) {
        assigned.push({ ids: cls[1]!.split(","), cls: cls[2]! });
        continue;
      }
      if (IGNORED.test(text)) continue;
      const sub = /^subgraph\s+(.+)$/.exec(text);
      if (sub) {
        const head = sub[1]!.trim();
        const m = /^([\p{L}\p{N}_$-]+)\s*\[(.*)\]$/u.exec(head);
        const id = m ? m[1]! : head;
        const label = cleanLabel(m ? m[2]! : head);
        groups.push({ id, label, parent: stack.at(-1) ?? null });
        stack.push(id);
        continue;
      }
      if (text === "end") {
        if (stack.pop() === undefined) {
          return {
            kind: "unsupported",
            reason: `line ${line}: end without subgraph`,
          };
        }
        continue;
      }
      if (!parseChain(text, reference, edges)) {
        return { kind: "unsupported", reason: `line ${line}: ${text}` };
      }
    }
  }

  if (stack.length > 0)
    return { kind: "unsupported", reason: "unclosed subgraph" };
  const groupIds = new Set(groups.map((g) => g.id));
  // An edge to a subgraph (`A --> sg`) is not modelled — Mermaid draws it.
  if (edges.some((e) => groupIds.has(e.from) || groupIds.has(e.to))) {
    return { kind: "unsupported", reason: "edge to a subgraph" };
  }
  for (const id of groupIds) nodes.delete(id);
  for (const { ids, cls } of assigned) {
    for (const id of ids) {
      const node = nodes.get(id);
      if (node && !node.classes.includes(cls)) {
        nodes.set(id, { ...node, classes: [...node.classes, cls] });
      }
    }
  }
  if (nodes.size === 0) return { kind: "unsupported", reason: "no nodes" };
  return {
    kind: "flowchart",
    diagram: { direction, nodes: [...nodes.values()], edges, groups },
  };
}

/** `;` separates statements on one line, outside quotes and node brackets. */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && "[({".includes(c)) depth++;
    else if (!quoted && "])}".includes(c)) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && c === ";") {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== "");
}

/**
 * One statement: node groups (`A & B`) joined by links, each link connecting
 * every node of the group before it to every node of the group after it.
 * Returns false when the statement does not read.
 */
function parseChain(
  text: string,
  reference: (
    id: string,
    label?: string,
    shape?: FlowNodeShape,
    cls?: string,
  ) => void,
  edges: FlowEdge[],
): boolean {
  let rest = text;
  const group = (): string[] | null => {
    const ids: string[] = [];
    for (;;) {
      const node = readNode(rest);
      if (!node) return null;
      reference(node.id, node.label, node.shape, node.cls);
      ids.push(node.id);
      rest = node.rest.trimStart();
      if (!rest.startsWith("&")) return ids;
      rest = rest.slice(1).trimStart();
    }
  };

  let left = group();
  if (!left) return false;
  while (rest !== "") {
    const link = readLink(rest);
    if (!link) return false;
    rest = link.rest.trimStart();
    const right = group();
    if (!right) return false;
    for (const from of left) {
      for (const to of right) {
        edges.push({ from, to, ...link.edge });
      }
    }
    left = right;
  }
  return true;
}

function readNode(text: string): {
  id: string;
  label?: string;
  shape?: FlowNodeShape;
  cls?: string;
  rest: string;
} | null {
  const idMatch = NODE_ID.exec(text);
  if (!idMatch) return null;
  const id = idMatch[0];
  let rest = text.slice(id.length);
  let label: string | undefined;
  let shape: FlowNodeShape | undefined;
  for (const s of SHAPES) {
    if (!rest.startsWith(s.open)) continue;
    const body = rest.slice(s.open.length);
    let end: number;
    if (body.trimStart().startsWith('"')) {
      const q0 = body.indexOf('"');
      const q1 = body.indexOf('"', q0 + 1);
      if (q1 < 0) return null;
      end = body.indexOf(s.close, q1 + 1);
    } else {
      end = body.indexOf(s.close);
    }
    if (end < 0) continue;
    label = cleanLabel(body.slice(0, end));
    shape = s.shape;
    rest = body.slice(end + s.close.length);
    break;
  }
  // `:::className` singles the node out (see FlowNode.classes).
  const cls = /^:::([\w-]+)/.exec(rest);
  if (cls) rest = rest.slice(cls[0].length);
  return { id, label, shape, cls: cls?.[1], rest };
}

function readLink(
  text: string,
): { edge: Omit<FlowEdge, "from" | "to">; rest: string } | null {
  for (const { re, line } of TEXT_LINKS) {
    const m = re.exec(text);
    if (!m) continue;
    const head = m[3] ? HEADS[m[3]]! : "none";
    return {
      edge: {
        label: cleanLabel(m[2]!),
        line,
        head,
        bidirectional: !!m[1] && head !== "none",
      },
      rest: text.slice(m[0].length),
    };
  }
  const m = PLAIN_LINK.exec(text);
  if (!m) return null;
  const body = m[2]!;
  const line: FlowEdge["line"] = body.startsWith("=")
    ? "thick"
    : body.includes(".") || body.startsWith("~")
      ? "dotted"
      : "solid";
  const head = m[3] ? HEADS[m[3]]! : "none";
  let rest = text.slice(m[0].length);
  let label: string | null = null;
  const pipe = PIPE_LABEL.exec(rest);
  if (pipe) {
    label = cleanLabel(pipe[1]!);
    rest = rest.slice(pipe[0].length);
  }
  return {
    edge: { label, line, head, bidirectional: !!m[1] && head !== "none" },
    rest,
  };
}
