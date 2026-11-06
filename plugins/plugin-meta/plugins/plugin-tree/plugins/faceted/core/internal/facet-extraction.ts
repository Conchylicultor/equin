import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import type { Facet } from "@plugins/plugin-meta/plugins/facets/core";
import { loadFacets } from "@plugins/plugin-meta/plugins/facets/plugins/loader/core";
import {
  runWithFsSnapshot,
  type FsSnapshot,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildFsSnapshot } from "./fs-snapshot";

/**
 * The extraction HARNESS: everything that shapes a facet record's VALUE — the
 * strict snapshot of the missed plugins' files a facet reads, and the
 * extraction run over it. Its Merkle key is in every facet record of every
 * plugin, so it imports only what produces a value: computing keys, reading
 * and writing the store and scheduling the run on workers live in
 * `facet-records.ts`, which no record's key covers (a change there cannot
 * change a value — what a record's key misses, `--verify-records` catches).
 *
 * The extract runs under a STRICT snapshot: a facet reading a file its
 * record's key does not name throws, so a record can never silently depend on
 * something that will not invalidate it.
 */
export const FACET_EXTRACTION_URL = import.meta.url;

/** What the strict snapshot of a record's extraction covers, for its refusal message. */
const STRICT = "the files of the plugins whose records are being made";

/** One run of missed extractions: plain data, structured-cloned to a worker. */
export interface FacetJobRequest {
  root: AppPath;
  /** The strict snapshot of exactly these plugins' files. */
  files: [string, string][];
  dirs: [string, (readonly [name: string, isDir: boolean])[]][];
  plugins: { dir: AppPath; relDir: string; id: string; facets: string[] }[];
}

/** Per plugin, in request order: each extracted facet's record text. */
export type FacetJobReply = [facetId: string, text: string][][];

/** The request extracting `facetsOf(node)` of each node of `chunk`, under the strict snapshot of their files. */
export async function facetJobRequest(
  snapshot: RepoSnapshot,
  chunk: readonly PluginNode[],
  facetsOf: (node: PluginNode) => string[],
): Promise<FacetJobRequest> {
  const fs = await buildFsSnapshot(
    snapshot,
    chunk.map((n) => n.dir),
    { strict: STRICT },
  );
  return {
    root: snapshot.root,
    files: [...fs.files],
    dirs: [...fs.dirs].map(([dir, entries]) => [
      dir,
      entries.map((e) => [e.name, e.isDirectory()] as const),
    ]),
    plugins: chunk.map((node) => ({
      dir: node.dir,
      relDir: relDirOf(snapshot, node),
      id: node.id,
      facets: facetsOf(node),
    })),
  };
}

let facetsOnce: Promise<Facet[]> | undefined;

/**
 * Extract the missed facets of a run of plugins, then each batch facet over
 * the run — the same calls in a worker as in this process. A batch facet's
 * pass is per plugin (each plugin's result is a function of its own files and
 * the batch's named inputs, which key its record), so splitting the plugins
 * across workers cannot change a record.
 */
export async function extractFacets(
  req: FacetJobRequest,
): Promise<FacetJobReply> {
  const facets = await (facetsOnce ??= loadFacets());
  const byId = new Map(facets.map((f) => [f.def.id, f]));
  const fs: FsSnapshot = {
    files: new Map(req.files),
    dirs: new Map(
      req.dirs.map(([dir, entries]) => [
        dir,
        entries.map(([name, isDir]) => ({
          name,
          isFile: () => !isDir,
          isDirectory: () => isDir,
        })),
      ]),
    ),
    strict: STRICT,
  };
  const extracted: Map<string, unknown>[] = [];
  const slice = createTimeSlicer();
  for (const p of req.plugins) {
    const data = new Map<string, unknown>();
    for (const facetId of p.facets) {
      const f = byId.get(facetId);
      if (!f) throw new Error(`[plugin-tree] no facet "${facetId}"`);
      data.set(
        facetId,
        runWithFsSnapshot(fs, () =>
          f.extract({ dir: p.dir, relDir: p.relDir, pluginId: p.id, fs }),
        ),
      );
      await slice();
    }
    extracted.push(data);
  }
  for (const f of facets) {
    if (!f.extractBatch) continue;
    const plugins = req.plugins.flatMap((p, i) => {
      const data = extracted[i]!.get(f.def.id);
      return data === undefined ? [] : [{ dir: p.dir, data }];
    });
    if (plugins.length > 0)
      await f.extractBatch.run({ root: req.root, fs, plugins });
  }
  return extracted.map((data) =>
    [...data].map(([facetId, value]) => [facetId, JSON.stringify(value)]),
  );
}

/** A plugin's folder relative to the repo root — what a facet sees as `relDir`, and part of its record key. */
export function relDirOf(snapshot: RepoSnapshot, node: PluginNode): string {
  const root = snapshot.root.endsWith("/")
    ? snapshot.root
    : `${snapshot.root}/`;
  if (!node.dir.startsWith(root))
    throw new Error(`[plugin-tree] ${node.dir} is not under ${snapshot.root}`);
  return node.dir.slice(root.length);
}
