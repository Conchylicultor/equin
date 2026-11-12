import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  npmClosureOf,
  parseBunLock,
  type BunLock,
} from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-closure/core";
import { lockfileNpmResolutions } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-resolutions/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

const keys = new WeakMap<RepoFiles, Promise<string>>();

/**
 * ALL the npm code a record producer can run, as one key part: the hash of
 * `bun.lock`'s npm resolutions (`lockfileNpmResolutions` — the file minus its
 * workspaces section and every `@workspace:` line), or "-" for a set with no
 * lockfile. For a producer that loads code no module graph can name (the
 * evaluator imports barrels; a facet runs whatever its harness loads); a
 * producer whose code is one module's closure keys on {@link npmCodeKey}.
 *
 * Never the lockfile's blob. Adding a plugin adds its workspace stanza to
 * `bun.lock` and changes no installed package, yet the blob moves — and every
 * producer (file facts, every file scan, every facet, the evaluator, the
 * drizzle verdict) keyed on it, so each new plugin re-keyed every record of
 * the shared store: 61 of the 64 lockfile edits on main from 2026-11-04 to
 * 11-10 were workspace-only, against 0–18 edits of any producer's own code
 * closure (the file-facts scan: 0), and the store reached 19M key rows for
 * ~480k distinct values (research/2026-11-10-global-plugin-records-store-growth.md).
 * An npm change — a version, an integrity, an override, a patch — still moves
 * it, and so every record: over-invalidation, never a stale key.
 *
 * Memoized per set (by identity): every producer of one build reads it once.
 */
export function npmResolutionsKey(set: RepoFiles): Promise<string> {
  let key = keys.get(set);
  if (key === undefined) {
    key = (async () => {
      if (!set.has("bun.lock")) return "-";
      return sha256Hex(lockfileNpmResolutions(await readLock(set)));
    })();
    keys.set(set, key);
  }
  return key;
}

async function readLock(set: RepoFiles): Promise<string> {
  const text = await set.read("bun.lock");
  if (text === null) throw new Error("[plugin-records] cannot read bun.lock");
  return text;
}

/**
 * A specifier the runtime answers itself (`node:fs`, `bun`, `bun:sqlite`): no
 * npm code. An unprefixed builtin (`fs`, `path`) is not told apart: the lock
 * holds no entry by that name, so it is keyed by name — stable, and right
 * should a package of that name ever be installed.
 */
function isBuiltin(pkg: string): boolean {
  return pkg === "bun" || pkg.startsWith("bun:") || pkg.startsWith("node:");
}

const locks = new WeakMap<RepoFiles, Promise<BunLock>>();
const codeKeys = new WeakMap<RepoFiles, Map<string, Promise<string>>>();

/**
 * The npm code a closure LOADS, as one key part: the lock entries of the
 * packages it imports by name (`ModuleGraph.packages`), closed over their
 * dependencies and peers (`npmClosureOf`), the bytes of every patch applied to
 * one of them, and each name the lockfile does not hold. "" when it imports
 * no npm package — then no lockfile change can move it.
 *
 * Derived, never listed: a producer whose code imports `typescript` keys on
 * typescript's entry and nothing else, so a bump of a package it never loads
 * (6 lockfile moves in 7 days, 2026-11-05 → 11-12, each re-keying ~110k file
 * records under the whole-lockfile key) leaves its records where they are.
 * Sound as far as its module graph sees the code it runs: a scan handed a
 * package by its caller would run code no import of its closure names — which
 * is why a scan is a module constant (`plugin-records/scan-module-constant`)
 * that imports its packages itself.
 *
 * A name the lockfile does not hold is keyed by name (its install then moves
 * the key); with no lockfile in the set, every name is. Memoized per set and
 * package list; the lockfile is parsed once per set.
 */
export function npmCodeKey(
  set: RepoFiles,
  packages: readonly string[],
): Promise<string> {
  const npm = [...new Set(packages)].filter((p) => !isBuiltin(p)).sort();
  if (npm.length === 0) return Promise.resolve("");
  let byList = codeKeys.get(set);
  if (!byList) codeKeys.set(set, (byList = new Map()));
  const listKey = npm.join("\0");
  let key = byList.get(listKey);
  if (key === undefined) {
    key = (async () => {
      if (!set.has("bun.lock")) return sha256Hex(`no-lock\0${listKey}`);
      let lock = locks.get(set);
      if (!lock) {
        lock = readLock(set).then(parseBunLock);
        locks.set(set, lock);
      }
      const closure = npmClosureOf(await lock, npm);
      const patches = await Promise.all(
        closure.patches.map(async (rel) => {
          const text = set.has(rel) ? await set.read(rel) : null;
          if (text === null)
            throw new Error(
              `[plugin-records] bun.lock applies the patch ${rel}, which the file set does not hold`,
            );
          return `${rel}\0${sha256Hex(text)}`;
        }),
      );
      return sha256Hex(
        [
          ...closure.entries,
          "patches",
          ...patches,
          "missing",
          ...closure.missing,
        ].join("\n"),
      );
    })();
    byList.set(listKey, key);
  }
  return key;
}
