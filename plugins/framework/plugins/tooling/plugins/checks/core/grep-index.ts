// Content-addressed `git grep -l` selections for a check run.
//
// Every grep-based check narrows its candidates with `git grep -l <pattern>
// <tree> -- <pathspecs>`: ~99 of them per pass, each decompressing every blob
// under its pathspecs (~116 MB, ~2.5 CPU-s) — ~60 % of a pass's CPU on
// 2026-11-05, re-derived from scratch on every run in every worktree although
// almost every blob is one the host already grepped for that very pattern.
//
// Whether a blob matches a pattern is a pure function of (git's version, the
// pattern, -E/-F, the blob's bytes), and the blob id names the bytes. So the
// answer is recorded per blob, host-wide, and a selection costs only the blobs
// no run has asked about yet: O(changed files), shared by every worktree.
//
// git stays the only authority on both halves of a selection, so a selection
// read from the index is the one `git grep` would have printed:
//   - WHICH files a pathspec names: `git ls-files -s` over a scratch index of
//     the run's tree (git's own pathspec matcher, no file read);
//   - WHETHER one matches: `git grep -l` itself, run over the unknown blobs only
//     (by `:(literal)` path when they are few, else the whole query, whose
//     output is then checked to lie inside the domain).

import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { sliceCheckThread } from "./source-work";
import { listTreePathspec, type TreePathspecEntry } from "./tree-hash";

/** The host-wide answers: query → blob → matched. Opened by the check command. */
export interface GrepIndexStore {
  /** The recorded answers of `query` for `blobs` (a blob with none is absent). */
  answers(query: string, blobs: readonly string[]): Map<string, boolean>;
  /** Record answers; one already present keeps its value (it is the same). */
  record(
    query: string,
    answers: ReadonlyArray<readonly [blob: string, matched: boolean]>,
  ): void;
}

/** One run's selections over one tree. */
export interface GrepIndex {
  /** The checkout whose tree it selects from. */
  readonly root: string;
  /** `git grep -l` of `grepArg` over the run's tree, scoped by `pathspecs`. */
  select(
    grepArg: string,
    fixed: boolean,
    pathspecs: readonly string[],
  ): Promise<string[]>;
}

/** Blobs asked of the store per synchronous call (see `select`). */
const LOOKUP_SLICE = 1000;

/** Above this many unknown blobs, the whole query runs instead of a literal list. */
const LITERAL_LIMIT = 256;

type DomainEntry = TreePathspecEntry;

/**
 * The index of one run: `tree` (the run's tree hash, what every check scans) in
 * the checkout at `root`.
 */
export function createGrepIndex(opts: {
  root: AppPath;
  tree: string;
  store: GrepIndexStore;
  /** Runs a full `git grep -l` over the tree — the same plumbing every check uses. */
  grepTree: (
    grepArg: string,
    fixed: boolean,
    pathspecs: string[],
  ) => Promise<string[]>;
}): GrepIndex {
  const { root, tree, store, grepTree } = opts;
  const domains = new Map<string, Promise<DomainEntry[]>>();
  let version: Promise<string> | null = null;

  const domainOf = (pathspecs: readonly string[]): Promise<DomainEntry[]> => {
    const key = JSON.stringify(pathspecs);
    let pending = domains.get(key);
    if (!pending) {
      pending = listTreePathspec(root, tree, pathspecs);
      domains.set(key, pending);
    }
    return pending;
  };

  return {
    root,
    async select(grepArg, fixed, pathspecs) {
      version ??= gitVersion(root);
      const query = sha256Hex(
        JSON.stringify([await version, fixed ? "-F" : "-E", grepArg]),
      );
      const domain = await domainOf(pathspecs);
      const blobs = [...new Set(domain.map((e) => e.blob))];
      // The store is synchronous (SQLite) and a domain is ~11k blobs: asked in
      // slices, the check thread yields between them instead of being held
      // for the whole lookup (11.7 s held on a cold run before this).
      const known = new Map<string, boolean>();
      for (let i = 0; i < blobs.length; i += LOOKUP_SLICE) {
        await sliceCheckThread();
        for (const [blob, matched] of store.answers(
          query,
          blobs.slice(i, i + LOOKUP_SLICE),
        ))
          known.set(blob, matched);
      }
      const unknown = domain.filter((e) => !known.has(e.blob));
      if (unknown.length > 0) {
        const matchedPaths = new Set(
          unknown.length <= LITERAL_LIMIT
            ? await grepTree(
                grepArg,
                fixed,
                unknown.map((e) => `:(literal)${e.path}`),
              )
            : await grepWhole(grepArg, fixed, pathspecs, domain),
        );
        const fresh = new Map<string, boolean>();
        for (const e of unknown) {
          const matched = matchedPaths.has(e.path);
          // Two paths with one blob have one answer; a disagreement means the
          // selection is not a function of the bytes, and nothing here holds.
          const prior = fresh.get(e.blob);
          if (prior !== undefined && prior !== matched)
            throw new Error(
              `grep-index: blob ${e.blob} both matched and did not match ${JSON.stringify(grepArg)} (at ${e.path})`,
            );
          fresh.set(e.blob, matched);
          known.set(e.blob, matched);
        }
        const answers = [...fresh];
        for (let i = 0; i < answers.length; i += LOOKUP_SLICE) {
          await sliceCheckThread();
          store.record(query, answers.slice(i, i + LOOKUP_SLICE));
        }
      }
      await sliceCheckThread();
      return domain
        .filter((e) => known.get(e.blob) === true)
        .map((e) => e.path);
    },
  };

  async function grepWhole(
    grepArg: string,
    fixed: boolean,
    pathspecs: readonly string[],
    domain: readonly DomainEntry[],
  ): Promise<string[]> {
    const out = await grepTree(grepArg, fixed, [...pathspecs]);
    const inDomain = new Set(domain.map((e) => e.path));
    const outside = out.filter((p) => !inDomain.has(p));
    // `ls-files` and `grep <tree>` disagreeing on what a pathspec names would
    // make every recorded negative suspect — refuse rather than record them.
    if (outside.length > 0)
      throw new Error(
        `grep-index: git grep ${JSON.stringify(pathspecs)} matched ${outside.length} path(s) git ls-files does not list for the same pathspecs (first: ${outside[0]})`,
      );
    return out;
  }
}

async function gitVersion(root: string): Promise<string> {
  const result = await spawnCaptured(["git", "--version"], {
    cwd: root,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0)
    throw new Error(`git --version failed (exit ${result.exitCode})`);
  return result.stdout.trim();
}
