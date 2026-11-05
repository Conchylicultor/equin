import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { recordKey } from "./keys";
import { currentRecordStore } from "./store";
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
   * `import.meta.url` of the module that defines the scan — its code IS the
   * scan, so its Merkle key keys the records and editing the scanner (or
   * anything it imports) rescans. Taken from the module itself, never typed
   * as a path, so a scan moved to another file cannot go on being keyed by
   * the file it left.
   */
  url: string;
  /** Parameters the scan reads besides the file (part of the key). */
  params?: readonly string[];
  scan(src: string, rel: string): T;
}

function isSnapshot(repo: RepoFiles): repo is RepoSnapshot {
  return typeof (repo as Partial<RepoSnapshot>).blobOf === "function";
}

const identities = new WeakMap<RepoFiles, Map<string, Promise<string>>>();

/**
 * The repo-relative path of the module at `url`: the longest of its path's
 * `plugins/…` suffixes that is a member of the set — so a checkout reached
 * through another spelling of its root (a symlink, a realpath) resolves the
 * same.
 */
export function repoModuleOf(repo: RepoFiles, url: string): string {
  const path = decodeURIComponent(new URL(url).pathname);
  for (
    let i = path.indexOf("/plugins/");
    i >= 0;
    i = path.indexOf("/plugins/", i + 1)
  ) {
    const rel = path.slice(i + 1);
    if (repo.has(rel)) return rel;
  }
  throw new Error(
    `[plugin-records] ${url} is not a module of the checkout at ${repo.root}: a scan's identity is its defining module`,
  );
}

function scannerIdentity(
  input: ModuleGraphInput & { snapshot: RepoSnapshot },
  url: string,
): Promise<string> {
  let byModule = identities.get(input.snapshot);
  if (!byModule) identities.set(input.snapshot, (byModule = new Map()));
  let id = byModule.get(url);
  if (!id) {
    const module = repoModuleOf(input.snapshot, url);
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
    byModule.set(url, id);
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
    scanner.url,
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

/**
 * `files` (members of `repo`) scanned as file records in the process's
 * installed store ({@link currentRecordStore}): the one-call form for a scan
 * whose scanner's closure is all in the set (a gitignored module it imports
 * throws, never reads the disk).
 */
export function scanRepoFiles<T>(
  repo: RepoFiles,
  files: readonly string[],
  scanner: FileScan<T>,
): Promise<T[]> {
  return scanFilesCached(
    { snapshot: repo, store: currentRecordStore(), readOutside: () => null },
    files,
    scanner,
  );
}
