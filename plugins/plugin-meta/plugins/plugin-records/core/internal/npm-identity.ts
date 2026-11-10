import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { lockfileNpmResolutions } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-resolutions/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

const keys = new WeakMap<RepoFiles, Promise<string>>();

/**
 * The npm code a record producer can run, as one key part: the hash of
 * `bun.lock`'s npm resolutions (`lockfileNpmResolutions` — the file minus its
 * workspaces section and every `@workspace:` line), or "-" for a set with no
 * lockfile.
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
      const text = await set.read("bun.lock");
      if (text === null)
        throw new Error("[plugin-records] cannot read bun.lock");
      return sha256Hex(lockfileNpmResolutions(text));
    })();
    keys.set(set, key);
  }
  return key;
}
