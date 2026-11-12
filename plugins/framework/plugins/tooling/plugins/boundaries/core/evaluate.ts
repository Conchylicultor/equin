import {
  VERIFYING_FOLDERS,
  type PluginFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import type { BoundaryConfig, Edge } from "./types";
import type { Resolved } from "./resolve";
import { matchZone } from "./match";

export type EdgeResult = "allow" | "deny" | "default-deny";

export function evaluateEdges(
  edges: Edge[],
  sourceZone: string,
  targetZone: string,
): EdgeResult {
  for (const edge of edges) {
    if (
      matchZone(edge.source, sourceZone) &&
      matchZone(edge.target, targetZone)
    ) {
      return edge.kind;
    }
  }
  return "default-deny";
}

export function checkRuntime(
  folders: BoundaryConfig["folders"],
  source: PluginFolder,
  target: PluginFolder,
): boolean {
  // Widened so a leaf target is a legal argument (and always false).
  const allowed: readonly PluginFolder[] = folders[source];
  return allowed.includes(target);
}

export function isRuntimeException(
  exceptions: ReadonlySet<string>,
  sourceZone: string,
  source: PluginFolder,
  targetZone: string,
  target: PluginFolder,
): boolean {
  return exceptions.has(`${sourceZone}.${source}\0${targetZone}.${target}`);
}

type InFolder = Extract<Resolved, { kind: "folder" }>;

/** What the folder rules say about one import between two plugin folders. */
export type ImportVerdict =
  /** Allowed, and inside one plugin: nothing else to ask. */
  | { kind: "ok" }
  /** Allowed by the folder rules, across plugins: the zone edges decide next. */
  | { kind: "cross-plugin" }
  /** Code that ships reaching test code. */
  | { kind: "test-code" }
  /** The source folder's row does not list the target folder. */
  | { kind: "runtime" };

/**
 * The folder rules for one import, in order:
 *
 * 1. Test code is importable only by code that verifies — test code itself,
 *    or a folder in `VERIFYING_FOLDERS`. This runs BEFORE the own-folder
 *    exemption, so `core/x.ts` reaching its own `./testing` fails too.
 * 2. A folder's own files are always reachable (a leaf row cannot list its
 *    own folder, yet `check/index.ts` must reach `./my-check`).
 * 3. A declared runtime exception.
 * 4. The source folder's row. Test code follows its folder's row, so this is
 *    also what limits WHICH `testing` barrels a test may reach.
 */
export function judgeImport(
  folders: BoundaryConfig["folders"],
  exceptions: ReadonlySet<string>,
  source: InFolder,
  target: InFolder,
): ImportVerdict {
  const samePlugin = source.zone === target.zone;
  const verifies = source.test || VERIFYING_FOLDERS.includes(source.folder);
  if (target.test && !verifies) return { kind: "test-code" };

  const allowed =
    (samePlugin && source.folder === target.folder) ||
    isRuntimeException(
      exceptions,
      source.zone,
      source.folder,
      target.zone,
      target.folder,
    ) ||
    checkRuntime(folders, source.folder, target.folder);
  if (!allowed) return { kind: "runtime" };
  return samePlugin ? { kind: "ok" } : { kind: "cross-plugin" };
}

export function detectCycle(
  edges: { from: string; to: string }[],
): string[] | null {
  const adj = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const { from, to } of edges) {
    nodes.add(from);
    nodes.add(to);
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const node of nodes) {
    if (color.get(node) !== undefined) continue;
    const stack: { node: string; iter: Iterator<string> }[] = [
      { node, iter: (adj.get(node) ?? new Set<string>()).values() },
    ];
    color.set(node, GRAY);

    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const step = top.iter.next();
      if (step.done) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const nxt = step.value;
      const col = color.get(nxt) ?? WHITE;
      if (col === GRAY) {
        const path = [top.node];
        let cur = top.node;
        while (cur !== nxt) {
          const par = parent.get(cur);
          if (par === undefined) break;
          path.push(par);
          cur = par;
        }
        path.push(nxt);
        path.reverse();
        return path;
      }
      if (col === WHITE) {
        color.set(nxt, GRAY);
        parent.set(nxt, top.node);
        stack.push({
          node: nxt,
          iter: (adj.get(nxt) ?? new Set<string>()).values(),
        });
      }
    }
  }

  return null;
}
