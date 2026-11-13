import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { groupedByOwner, readGrouped } from "./grouped";
import { recordKey } from "./keys";
import { currentRecordStore } from "./store";
import { NO_OUTSIDE_FILES, type ModuleGraphInput } from "./module-graph";
import { codeIdentity } from "./code-identity";

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
   *
   * That module must be a `*.scan.ts` file holding the scan and the code it
   * runs, nothing else ({@link SCAN_MODULE_SUFFIX}): a scan defined inside
   * its consumer (a generator, a check) is keyed by the consumer's whole
   * closure — 300+ modules, re-keying every file's record on about one main
   * commit in four while the answers almost never change.
   */
  url: string;
  /**
   * Parameters the scan reads besides the file (part of the key). Each
   * distinct parameter list keeps its own record of every file, all re-keyed
   * together when the scan's closure moves — so never a parameter that only
   * selects PART of an answer (which kinds to report): scan for all of it and
   * let the caller filter. plugin-refs' scan took its kind set as one and
   * kept three records of each file, a third of the store's file records
   * (2026-11-12).
   */
  params?: readonly string[];
  scan(src: string, rel: string): T;
}

/**
 * The file name a scan's defining module ends with. A module of its own makes
 * the key as narrow as the scan's code; the suffix makes that module visible
 * to its next editor, who sees that whatever it imports keys every record.
 */
const SCAN_MODULE_SUFFIX = ".scan.ts";

export function assertScanModule(url: string): void {
  if (!new URL(url).pathname.endsWith(SCAN_MODULE_SUFFIX))
    throw new Error(
      `[plugin-records] a file scan is defined in ${url}: define it in a module of its own named *${SCAN_MODULE_SUFFIX}, holding only the scan and the code it runs — its records are keyed by that module's whole import closure, so a scan defined inside its consumer is re-keyed by every edit to the consumer's closure`,
    );
}

export function isSnapshot(repo: RepoFiles): repo is RepoSnapshot {
  return typeof (repo as Partial<RepoSnapshot>).blobOf === "function";
}

/**
 * A scan's (or fold's) identity: its defining module's code identity
 * (`codeIdentity`) — read from the checkout that module lives in, so a
 * fixture needs no copy of the scanner.
 */
export function scannerIdentity(
  input: ModuleGraphInput,
  url: string,
): Promise<string> {
  return codeIdentity(input, url, "scan");
}

/** Each of `files` (repo-relative members of the set) scanned, in order. Results must be JSON. */
export async function scanFilesCached<T>(
  input: ModuleGraphInput,
  files: readonly string[],
  scanner: FileScan<T>,
): Promise<T[]> {
  assertScanModule(scanner.url);
  const repo = input.snapshot;
  const read = async (rel: string): Promise<string> => {
    // Read to compute a record when the set has blob ids (the store's work,
    // shared host-wide), the caller's own read otherwise.
    const src = isSnapshot(repo)
      ? await sharedWork("plugin records", () => repo.read(rel))
      : await repo.read(rel);
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
  const identity = await scannerIdentity(input, scanner.url);
  const params = scanner.params ?? [];
  const keys = files.map((rel) =>
    recordKey(identity, ...params, rel, repo.blobOf(rel)),
  );
  const hits = await readGrouped(
    input.store,
    "file",
    groupedByOwner(files, keys),
  );
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
    {
      snapshot: repo,
      store: currentRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    },
    files,
    scanner,
  );
}
