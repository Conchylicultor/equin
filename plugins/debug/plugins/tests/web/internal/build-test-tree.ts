import { Rank } from "@plugins/primitives/plugins/rank/web";
import {
  TEST_STATUSES,
  worstStatus,
  type TestFileStatusRow,
  type TestStatus,
} from "../../core";

/** Files per status. */
export type StatusCounts = Record<TestStatus, number>;

export function emptyCounts(): StatusCounts {
  return Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

export function countStatuses(
  rows: readonly TestFileStatusRow[],
): StatusCounts {
  const c = emptyCounts();
  for (const r of rows) c[r.status]++;
  return c;
}

interface TreeRowBase {
  id: string;
  parentId: string | null;
  rank: Rank;
  /** What the tree's label shows. */
  name: string;
  /** Ancestors' names too, so searching a plugin keeps its subtree. */
  searchText: string;
}

/** A plugin: its whole subtree's files, by status. */
export interface PluginRow extends TreeRowBase {
  kind: "plugin";
  pluginId: string;
  counts: StatusCounts;
  fileCount: number;
  /** The worst status of any file below it. */
  status: TestStatus;
}

/** A test file, as the status collection has it. */
export interface FileRow extends TreeRowBase {
  kind: "file";
  file: TestFileStatusRow;
  status: TestStatus;
}

export type TestTreeRow = PluginRow | FileRow;

const OUTSIDE = "(outside plugins)";

/** The file's path below its plugin's folder (`core/internal/x.test.ts`). */
export function fileLabel(path: string, pluginId: string | null): string {
  if (pluginId === null) return path;
  const dir = `plugins/${pluginId.split(".").join("/plugins/")}/`;
  return path.startsWith(dir) ? path.slice(dir.length) : path;
}

/**
 * The plugin tree over test files, as flat rows for the DataView table:
 * every plugin on the way to a file (`a`, `a.b`, `a.b.c`) is a row carrying
 * its subtree's counts and worst status (failing > flaky > stale > passing >
 * never); under a plugin, its child plugins come first, then its own files,
 * each group by name.
 */
export function buildTestTree(
  files: readonly TestFileStatusRow[],
): TestTreeRow[] {
  interface Node {
    id: string;
    name: string;
    children: Map<string, Node>;
    files: TestFileStatusRow[];
    counts: StatusCounts;
    fileCount: number;
    status: TestStatus | null;
  }
  const node = (id: string, name: string): Node => ({
    id,
    name,
    children: new Map(),
    files: [],
    counts: emptyCounts(),
    fileCount: 0,
    status: null,
  });
  const root = node("", "");
  for (const f of files) {
    const segs = f.pluginId === null ? [OUTSIDE] : f.pluginId.split(".");
    let at = root;
    const chain: Node[] = [];
    segs.forEach((seg, i) => {
      const id = segs.slice(0, i + 1).join(".");
      let next = at.children.get(seg);
      if (!next) at.children.set(seg, (next = node(id, seg)));
      chain.push(next);
      at = next;
    });
    at.files.push(f);
    for (const n of chain) {
      n.counts[f.status]++;
      n.fileCount++;
      n.status = n.status === null ? f.status : worstStatus(n.status, f.status);
    }
  }

  const out: TestTreeRow[] = [];
  const walk = (n: Node, parentId: string | null, ancestors: string): void => {
    let prev: Rank | null = null;
    const nextRank = (): Rank => (prev = Rank.between(prev, null));
    for (const child of [...n.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const searchText = `${ancestors} ${child.name}`.trim();
      out.push({
        kind: "plugin",
        id: `plugin:${child.id}`,
        parentId,
        rank: nextRank(),
        name: child.name,
        searchText,
        pluginId: child.id,
        counts: child.counts,
        fileCount: child.fileCount,
        status: child.status ?? "never",
      });
      walk(child, `plugin:${child.id}`, searchText);
    }
    for (const f of [...n.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push({
        kind: "file",
        id: `file:${f.path}`,
        parentId,
        rank: nextRank(),
        name: fileLabel(f.path, f.pluginId),
        searchText: `${ancestors} ${f.path}`,
        file: f,
        status: f.status,
      });
    }
  };
  walk(root, null, "");
  return out;
}
