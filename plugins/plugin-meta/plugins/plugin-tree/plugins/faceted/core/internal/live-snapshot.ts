import {
  globPaths,
  listRepoMembers,
  loadRepoSnapshot,
  pathsUnder,
  repoFileReader,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { gitBlobId } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * A `RepoSnapshot` kept up to date by what changed, for a reader that lives
 * across edits (the faceted index): taken once whole (`loadRepoSnapshot`), then
 * told the paths a watcher saw. A refresh re-asks git about those paths only
 * and re-hashes the files whose content moved — O(changes), never a whole
 * listing.
 *
 * Membership is `loadRepoSnapshot`'s (`listRepoMembers` is its rule, scoped).
 * A re-hashed file's id is `gitBlobId` of its working-tree text — what
 * `git hash-object` answers for a text file; the ids that key records are all
 * of text files (sources, `package.json`, stylesheets).
 */
export interface LiveRepoSnapshot extends RepoSnapshot {
  /**
   * Bring the snapshot up to date (repo-relative paths). `paths`: anything
   * may have happened at or under each — re-asked of git. `edited`: files a
   * watcher saw updated — a member is only re-hashed; any other is handled as
   * one of `paths`. A `.gitignore` among either re-asks its folder. Not
   * re-entrant.
   */
  refresh(
    paths: readonly string[],
    edited: readonly string[],
  ): Promise<SnapshotChange>;
  /** Every member and its blob id, sorted by path — what `from` takes back. */
  entries(): [string, string][];
}

/** What a refresh moved (repo-relative paths). */
export interface SnapshotChange {
  /** Members added or removed. */
  membership: string[];
  /** Members whose blob id moved (an added one included). */
  ids: string[];
}

function lowerBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Drop nested regions: a path under another one is already covered. */
function regionsOf(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of [...new Set(paths)].sort()) {
    const last = out[out.length - 1];
    if (last !== undefined && (last === "" || p.startsWith(`${last}/`)))
      continue;
    out.push(p);
  }
  return out;
}

export interface OpenLiveSnapshotOptions {
  /** How many file reads the snapshot holds open at once. */
  readConcurrency: number;
  /**
   * Start from these members and blob ids (an earlier snapshot's
   * {@link LiveRepoSnapshot.entries}) instead of asking git for the whole
   * set. The caller then refreshes every path that may have changed since
   * they were taken.
   */
  from?: readonly (readonly [string, string])[];
}

export async function openLiveSnapshot(
  root: AppPath,
  opts: OpenLiveSnapshotOptions,
): Promise<LiveRepoSnapshot> {
  const blobs = new Map<string, string>();
  if (opts.from === undefined) {
    const cold = await loadRepoSnapshot(root, opts);
    for (const p of cold.all()) blobs.set(p, cold.blobOf(p));
  } else {
    let last: string | null = null;
    for (const [p, blob] of opts.from) {
      if (last !== null && p <= last)
        throw new Error(
          `openLiveSnapshot(${root}): the members it starts from are not sorted and unique (${JSON.stringify(last)} then ${JSON.stringify(p)}).`,
        );
      blobs.set(p, blob);
      last = p;
    }
  }
  const members = [...blobs.keys()];
  const memberSet = new Set(members);
  const read = repoFileReader(root, opts);

  const assertMember = (op: string, path: string): void => {
    if (!memberSet.has(path))
      throw new Error(
        `LiveRepoSnapshot.${op}(${JSON.stringify(path)}): not a file of the snapshot of ${root}.`,
      );
  };

  /** The members at or under `region`: the exact path, then its subtree. */
  const membersAt = (region: string): string[] =>
    memberSet.has(region)
      ? [region, ...pathsUnder(members, region)]
      : pathsUnder(members, region);

  return {
    root,
    all: () => members,
    has: (path) => memberSet.has(path),
    under: (dir) => pathsUnder(members, dir),
    glob: (pattern) => globPaths(members, pattern),
    read: async (path) => (memberSet.has(path) ? read(path) : null),
    blobOf(path) {
      assertMember("blobOf", path);
      return blobs.get(path)!;
    },
    entries: () => members.map((p) => [p, blobs.get(p)!]),
    async refresh(paths, edited) {
      const asked: string[] = [...paths];
      for (const p of [...paths, ...edited]) {
        if (p === ".gitignore" || p.endsWith("/.gitignore"))
          asked.push(p.slice(0, Math.max(0, p.lastIndexOf("/"))));
      }
      const rehash = new Set<string>();
      for (const p of edited) {
        if (memberSet.has(p)) rehash.add(p);
        else asked.push(p);
      }
      const regions = regionsOf(asked);
      const now = new Set(
        regions.length === 0 ? [] : await listRepoMembers(root, regions),
      );
      const before = new Set(regions.flatMap(membersAt));
      const membership: string[] = [];
      const ids: string[] = [];
      for (const m of before) {
        if (now.has(m)) continue;
        members.splice(lowerBound(members, m), 1);
        memberSet.delete(m);
        blobs.delete(m);
        rehash.delete(m);
        membership.push(m);
      }
      for (const m of now) {
        // A path named outright may have been rewritten (an atomic save is a
        // create); a member only inside a named folder kept its bytes.
        if (before.has(m) && !asked.includes(m)) continue;
        if (!before.has(m)) {
          members.splice(lowerBound(members, m), 0, m);
          memberSet.add(m);
          membership.push(m);
        }
        rehash.add(m);
      }
      await Promise.all(
        [...rehash].map(async (m) => {
          const text = await read(m);
          if (text === null) {
            // Gone since it was listed: the watcher's delete follows, and
            // re-asks it. Until then it stays a member with its last id.
            if (!blobs.has(m)) blobs.set(m, gitBlobId(""));
            return;
          }
          const id = gitBlobId(text);
          if (blobs.get(m) === id) return;
          blobs.set(m, id);
          ids.push(m);
        }),
      );
      return { membership, ids };
    },
  };
}
