import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { recordKey } from "./keys";
import { buildModuleGraph, type ModuleGraphInput } from "./module-graph";

/**
 * A per-file scan as FILE RECORDS: what a reader takes out of one file (the
 * icon names it draws, the platform APIs it needs, the imports it makes) is a
 * function of that file's bytes, its path, the scan's own parameters and the
 * scanner's code — so it is stored under exactly that, and a build reads only
 * the files whose blob it has not scanned yet. Every other file's answer is a
 * lookup.
 *
 * A scanner that throws stores nothing, so the error repeats on every run
 * until the file is fixed. From a file set with no blob ids (a check pass's),
 * every file is read and scanned — spelled through JSON all the same, so both
 * paths hand back the same values.
 */
export interface FileScan<T> {
  /**
   * The repo-relative module whose code IS the scan — its Merkle key keys the
   * records, so editing the scanner (or anything it imports) rescans.
   */
  module: string;
  /** Parameters the scan reads besides the file (part of the key). */
  params?: readonly string[];
  scan(src: string, rel: string): T;
}

function isSnapshot(repo: RepoFiles): repo is RepoSnapshot {
  return typeof (repo as Partial<RepoSnapshot>).blobOf === "function";
}

const identities = new WeakMap<RepoFiles, Map<string, Promise<string>>>();

function scannerIdentity(
  input: ModuleGraphInput & { snapshot: RepoSnapshot },
  module: string,
): Promise<string> {
  let byModule = identities.get(input.snapshot);
  if (!byModule) identities.set(input.snapshot, (byModule = new Map()));
  let id = byModule.get(module);
  if (!id) {
    id = buildModuleGraph(input, [module]).then((graph) =>
      recordKey(
        "scan",
        module,
        graph.keyOf(module),
        input.store.environment,
        input.snapshot.has("bun.lock")
          ? input.snapshot.blobOf("bun.lock")
          : "-",
      ),
    );
    byModule.set(module, id);
  }
  return id;
}

/** Each of `files` (repo-relative members of the set) scanned, in order. Results must be JSON. */
export async function scanFilesCached<T>(
  input: ModuleGraphInput,
  files: readonly string[],
  scanner: FileScan<T>,
): Promise<T[]> {
  const repo = input.snapshot;
  const read = async (rel: string): Promise<string> => {
    const src = await repo.read(rel);
    if (src === null)
      throw new Error(`[plugin-records] cannot read ${rel} to scan it`);
    return src;
  };
  const spell = (value: T): string => JSON.stringify(value);
  if (!isSnapshot(repo)) {
    return Promise.all(
      files.map(
        async (rel) =>
          JSON.parse(spell(scanner.scan(await read(rel), rel))) as T,
      ),
    );
  }
  const identity = await scannerIdentity(
    { ...input, snapshot: repo },
    scanner.module,
  );
  const params = scanner.params ?? [];
  const keys = files.map((rel) =>
    recordKey(identity, ...params, rel, repo.blobOf(rel)),
  );
  const hits = input.store.getMany("file", keys);
  const fresh: [string, string][] = [];
  const out = await Promise.all(
    files.map(async (rel, i) => {
      const hit = hits.get(keys[i]!);
      if (hit !== undefined) return JSON.parse(hit) as T;
      const text = spell(scanner.scan(await read(rel), rel));
      fresh.push([keys[i]!, text]);
      return JSON.parse(text) as T;
    }),
  );
  if (fresh.length > 0) input.store.putMany("file", fresh);
  return out;
}
