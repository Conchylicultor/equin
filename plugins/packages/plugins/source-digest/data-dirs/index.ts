import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * What the closure walk learned of each repo file — its bytes' sha256 and its
 * import specifiers — under the stamp the file had when it was read, one
 * SQLite database shared by every process on the host (each backend, central,
 * a build's adoption ask). A process's walk then reads only the files whose
 * stamp moved since any process last read them.
 *
 * @see plugins/packages/plugins/source-digest/shared/facts-store.ts
 */
export const sourceFactsDir = defineDataDir({
  kind: "cache",
  name: "source-facts",
  owner: "packages/source-digest",
  description:
    "Per-file facts of the source-digest closure walk (sha256 + import specifiers) keyed by path and inode stamp, shared by every process; rows unread for 14 days are dropped",
  reclaim: { kind: "safe" },
});

export default [sourceFactsDir];
