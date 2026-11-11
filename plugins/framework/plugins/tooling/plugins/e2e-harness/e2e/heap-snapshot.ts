/**
 * V8 `.heapsnapshot` reading, for the tab-side leak test (`leak.ts`).
 *
 * A snapshot is one JSON document: `snapshot.meta` names the fields of the
 * flat `nodes` / `edges` integer arrays, and every name is an index into
 * `strings`. This module decodes it into typed arrays once and answers the
 * three questions a leak report asks:
 *
 * - **what is on the heap, by constructor** (`summary`) — count and self size
 *   per group, grouped the way DevTools' Summary view groups (an object by its
 *   constructor name, a closure as `(closure)`, every string kind as
 *   `(string)`, the rest by node type);
 * - **which DOM nodes are detached** — Blink stamps `detachedness` (2 =
 *   detached) on its wrappers; older snapshots spell it in the name
 *   (`Detached HTMLDivElement`), and both are read;
 * - **what keeps a given object alive** (`retainerPath`) — the shortest chain
 *   of strong edges from a GC root, the path DevTools' Retainers view opens
 *   with.
 *
 * Node ids are the isolate's heap object ids: an object keeps its id across
 * every snapshot of the same tab, and a new object gets a higher one. That is
 * what lets the leak test tell "allocated during the first run and still alive
 * after the second" without diffing object graphs.
 */
import { z } from "zod";

const SnapshotSchema = z.object({
  snapshot: z.object({
    meta: z.object({
      node_fields: z.array(z.string()),
      node_types: z.array(z.unknown()),
      edge_fields: z.array(z.string()),
      edge_types: z.array(z.unknown()),
    }),
    node_count: z.number(),
    edge_count: z.number(),
  }),
  // The three big arrays (tens of millions of entries) are checked for shape
  // only: a per-element zod pass would copy each of them.
  nodes: z.custom<number[]>(Array.isArray, "nodes is not an array"),
  edges: z.custom<number[]>(Array.isArray, "edges is not an array"),
  strings: z.custom<string[]>(Array.isArray, "strings is not an array"),
});

/** One constructor group of a snapshot: how many objects, how many bytes. */
export interface HeapGroup {
  name: string;
  count: number;
  size: number;
}

export interface HeapSummary {
  /** Sum of every node's self size, bytes. */
  totalSize: number;
  nodeCount: number;
  /** Highest heap object id in the snapshot: everything above it is newer. */
  maxId: number;
  /** Constructor groups, keyed by group name. */
  groups: Map<string, HeapGroup>;
  /** Detached DOM nodes, grouped by their DOM class. */
  detached: Map<string, HeapGroup>;
}

/** A decoded snapshot: the summary plus the graph, for retainer paths. */
export interface HeapGraph {
  summary: HeapSummary;
  /** Number of nodes. Node `i` is the i-th node, not its byte offset. */
  readonly size: number;
  id(node: number): number;
  group(node: number): string;
  name(node: number): string;
  isDetached(node: number): boolean;
  selfSize(node: number): number;
  /** Every node, as indices. */
  nodes(): Iterable<number>;
  /**
   * The shortest strong-edge chain from a GC root to `node`, as printable
   * steps (root first), or `null` when no strong path reaches it (only weak
   * edges retain it — it would go on the next GC).
   */
  retainerPath(node: number, maxDepth?: number): string[] | null;
}

/**
 * The inspector's own handles into the page — DevTools' and Playwright's
 * injected scripts. They reach the document and `performance` in fewer hops
 * than the app does, so a shortest path through them would name the tool, not
 * the app's retainer: retainer paths do not go through them.
 */
const TOOLING_ROOTS = new Set(["InjectedScript", "UtilityScript"]);

/** `system / …` objects that hold the app's data, not V8 bookkeeping. */
const APP_SYSTEM_NAMES = new Set([
  "system / Context",
  "system / JSArrayBufferData",
]);

const STRING_TYPES = new Set([
  "string",
  "concatenated string",
  "sliced string",
]);

/**
 * A node name short enough to read: Blink's C++ backing stores spell their
 * whole template (`blink::HeapVectorBacking<std::pair<cppgc::internal::…>>`),
 * cut to `blink::HeapVectorBacking<…>`; anything else is capped at 120 chars.
 */
function shortName(name: string): string {
  const lt = name.indexOf("<");
  const cut = lt > 0 && name.endsWith(">") ? `${name.slice(0, lt)}<…>` : name;
  return cut.length > 120 ? `${cut.slice(0, 119)}…` : cut;
}

/** Parse a `.heapsnapshot` document. Heavy: one pass over every node and edge. */
export function parseHeapSnapshot(json: string): HeapGraph {
  const doc = SnapshotSchema.parse(JSON.parse(json));
  const meta = doc.snapshot.meta;
  const nf = meta.node_fields.length;
  const ef = meta.edge_fields.length;
  const field = (fields: string[], name: string, required = true): number => {
    const i = fields.indexOf(name);
    if (i < 0 && required)
      throw new Error(
        `heap snapshot has no "${name}" field (${fields.join(", ")})`,
      );
    return i;
  };
  const N_TYPE = field(meta.node_fields, "type");
  const N_NAME = field(meta.node_fields, "name");
  const N_ID = field(meta.node_fields, "id");
  const N_SIZE = field(meta.node_fields, "self_size");
  const N_EDGES = field(meta.node_fields, "edge_count");
  const N_DETACHED = field(meta.node_fields, "detachedness", false);
  const E_TYPE = field(meta.edge_fields, "type");
  const E_NAME = field(meta.edge_fields, "name_or_index");
  const E_TO = field(meta.edge_fields, "to_node");
  const nodeTypes = z.array(z.string()).parse(meta.node_types[N_TYPE]);
  const edgeTypes = z.array(z.string()).parse(meta.edge_types[E_TYPE]);
  const { nodes, edges, strings } = doc;
  const count = nodes.length / nf;
  if (!Number.isInteger(count) || count !== doc.snapshot.node_count)
    throw new Error(
      `heap snapshot: ${nodes.length} node values is not node_count ${doc.snapshot.node_count} × ${nf} fields`,
    );
  if (edges.length !== doc.snapshot.edge_count * ef)
    throw new Error(
      `heap snapshot: ${edges.length} edge values is not edge_count ${doc.snapshot.edge_count} × ${ef} fields`,
    );

  const typeOf = (n: number) => nodeTypes[nodes[n * nf + N_TYPE]!] ?? "?";
  const nameOf = (n: number) => strings[nodes[n * nf + N_NAME]!] ?? "?";
  const idOf = (n: number) => nodes[n * nf + N_ID]!;
  const sizeOf = (n: number) => nodes[n * nf + N_SIZE]!;
  const detachedOf = (n: number): boolean => {
    if (N_DETACHED >= 0 && nodes[n * nf + N_DETACHED] === 2) return true;
    return typeOf(n) === "native" && nameOf(n).startsWith("Detached ");
  };
  const groupOf = (n: number): string => {
    const type = typeOf(n);
    if (type === "object" || type === "native") {
      const name = nameOf(n).replace(/^Detached /, "");
      // V8 internals spelled as objects (`system / PropertyArray`): DevTools'
      // (system) row.
      // Closure contexts and ArrayBuffer backing stores keep their own rows:
      // they are the app's memory (a leaked closure scope, a canvas buffer).
      if (name.startsWith("system / "))
        return APP_SYSTEM_NAMES.has(name) ? name : "(system)";
      // A DOM element is named by its tag and attributes (`<div class=…>`):
      // grouped by tag, or every element would be a group of its own.
      const tag = /^<([A-Za-z][\w-]*)/.exec(name);
      return tag ? `<${tag[1]}>` : shortName(name);
    }
    if (type === "closure") return "(closure)";
    if (STRING_TYPES.has(type)) return "(string)";
    return `(${type})`;
  };

  // First edge of each node (edges are stored in node order).
  const firstEdge = new Int32Array(count + 1);
  for (let n = 0; n < count; n += 1)
    firstEdge[n + 1] = firstEdge[n]! + nodes[n * nf + N_EDGES]! * ef;

  const groups = new Map<string, HeapGroup>();
  const detached = new Map<string, HeapGroup>();
  let totalSize = 0;
  let maxId = 0;
  const add = (map: Map<string, HeapGroup>, name: string, size: number) => {
    const g = map.get(name);
    if (g) {
      g.count += 1;
      g.size += size;
    } else map.set(name, { name, count: 1, size });
  };
  for (let n = 0; n < count; n += 1) {
    const size = sizeOf(n);
    totalSize += size;
    maxId = Math.max(maxId, idOf(n));
    add(groups, groupOf(n), size);
    if (detachedOf(n)) add(detached, groupOf(n), size);
  }

  // Shortest strong-edge distance from the root (node 0), lazily: only a
  // retainer-path question pays for the BFS and the reverse index.
  const weak = edgeTypes.indexOf("weak");
  const shortcut = edgeTypes.indexOf("shortcut");
  let distance: Int32Array | null = null;
  let retainersStart: Int32Array | null = null;
  let retainerEdges: Int32Array | null = null; // edge offsets, grouped by target
  let edgeOwner: Int32Array | null = null; // edge index / ef → source node
  const strong = (e: number) => {
    const t = edges[e + E_TYPE];
    return t !== weak && t !== shortcut;
  };
  const index = () => {
    if (distance) return;
    const edgeCount = edges.length / ef;
    edgeOwner = new Int32Array(edgeCount);
    for (let n = 0; n < count; n += 1)
      for (let e = firstEdge[n]!; e < firstEdge[n + 1]!; e += ef)
        edgeOwner[e / ef] = n;
    const inbound = new Int32Array(count + 1);
    for (let e = 0; e < edges.length; e += ef)
      inbound[edges[e + E_TO]! / nf + 1]! += 1;
    for (let n = 0; n < count; n += 1)
      inbound[n + 1] = inbound[n + 1]! + inbound[n]!;
    retainersStart = inbound;
    retainerEdges = new Int32Array(edgeCount);
    const fill = inbound.slice(0, count);
    for (let e = 0; e < edges.length; e += ef) {
      const to = edges[e + E_TO]! / nf;
      retainerEdges[fill[to]!] = e;
      fill[to] = fill[to]! + 1;
    }
    distance = new Int32Array(count).fill(-1);
    distance[0] = 0;
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    while (head < tail) {
      const n = queue[head++]!;
      if (TOOLING_ROOTS.has(nameOf(n))) continue;
      for (let e = firstEdge[n]!; e < firstEdge[n + 1]!; e += ef) {
        if (!strong(e)) continue;
        const to = edges[e + E_TO]! / nf;
        if (distance[to] !== -1) continue;
        distance[to] = distance[n]! + 1;
        queue[tail++] = to;
      }
    }
  };

  const edgeLabel = (e: number): string => {
    const type = edgeTypes[edges[e + E_TYPE]!] ?? "?";
    const raw = edges[e + E_NAME]!;
    if (type === "element" || type === "hidden") return `[${raw}]`;
    const name = strings[raw] ?? String(raw);
    if (type === "context") return `->${name}`;
    if (type === "internal") return `{${name}}`;
    return `.${name}`;
  };
  const describe = (n: number): string => {
    const name = nameOf(n);
    const type = typeOf(n);
    const label =
      type === "closure"
        ? `${name || "(anonymous)"}()`
        : type === "object" || type === "native"
          ? shortName(name.replace(/^Detached /, ""))
          : groupOf(n);
    return `${detachedOf(n) ? "Detached " : ""}${label} @${idOf(n)}`;
  };

  return {
    summary: { totalSize, nodeCount: count, maxId, groups, detached },
    size: count,
    id: idOf,
    group: groupOf,
    name: nameOf,
    isDetached: detachedOf,
    selfSize: sizeOf,
    *nodes() {
      for (let n = 0; n < count; n += 1) yield n;
    },
    retainerPath(node, maxDepth = 24) {
      index();
      const dist = distance!;
      if (dist[node] === -1) return null;
      const steps: string[] = [describe(node)];
      let at = node;
      while (dist[at]! > 0 && steps.length <= maxDepth) {
        let best = -1;
        for (
          let i = retainersStart![at]!;
          i < retainersStart![at + 1]!;
          i += 1
        ) {
          const e = retainerEdges![i]!;
          if (!strong(e)) continue;
          const from = edgeOwner![e / ef]!;
          if (TOOLING_ROOTS.has(nameOf(from))) continue;
          if (dist[from] === dist[at]! - 1) {
            best = e;
            break;
          }
        }
        if (best < 0) break;
        const from = edgeOwner![best / ef]!;
        steps.unshift(`${describe(from)} ${edgeLabel(best)}`);
        at = from;
      }
      // Cut short of a root (maxDepth): say so, the path no longer starts at one.
      if (dist[at]! > 0)
        steps.unshift(`… ${dist[at]} more step(s) to a GC root`);
      // The root itself (node 0) and its synthetic children say nothing.
      while (
        steps.length > 1 &&
        /^\((?:synthetic|GC roots)|^\(?Document DOM trees/.test(steps[0]!)
      )
        steps.shift();
      return steps;
    },
  };
}
