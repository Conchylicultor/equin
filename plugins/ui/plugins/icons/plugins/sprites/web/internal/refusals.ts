import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";

/*
 * What a refused content-addressed read (`icons.sprite`,
 * `icons.runtime-symbols`) means to the host reading it.
 *
 * Every such tuple carries the hash the tab holds — the resident value's
 * `manifestHash` / `symbolsHash`, or a scope's `icons.sprite-hash`. A server
 * that restarted with another manifest (any deploy adding a `symbol("…")`), or
 * whose saved-name list moved (a user picked a new icon), refuses the old hash
 * (`stale-manifest` / `stale-symbols`). That is not a fault: the value the hash
 * comes from is pushed again with the new one, and the reads re-key off it
 * (their tuples are built from it at render). Meanwhile the sheet keeps the
 * sprites it holds, so the icons stay drawn. Thrown, it took the whole sheet
 * down — every icon of the page blank until a reload.
 *
 * Any other refusal (an unknown key or name, an unsorted batch) is a contract
 * fault no new hash fixes: thrown, into the host's error boundary.
 */

/** The refusals that mean the tab's hash is behind the server's. */
const HASH_BEHIND: ReadonlySet<string> = new Set([
  "stale-manifest",
  "stale-symbols",
]);

/** One tuple's read: only its error arm is looked at. */
type ReadLike =
  | { readonly status: "error"; readonly error: ResourceError }
  | { readonly status: "loading" | "ready" | "unavailable" };

/**
 * Throw `read`'s error when it is a refusal no newer hash answers; a
 * hash-behind refusal (and every other state) passes — the read re-keys when
 * the hash it carries is pushed again.
 */
export function throwContractRefusal(read: ReadLike | undefined): void {
  if (read?.status !== "error" || read.error.kind !== "refused") return;
  if (read.error.code !== undefined && HASH_BEHIND.has(read.error.code)) return;
  throw read.error;
}
