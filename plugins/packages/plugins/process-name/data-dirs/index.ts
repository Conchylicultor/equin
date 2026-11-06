import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The CLI's named Buns, shared by every checkout on the machine:
 * `bun-<version>/equin · <verb>`, one APFS clone per verb and Bun version.
 *
 * Machine-wide, not per checkout, because macOS scans a fresh executable on its
 * first exec (~1 s and two full reads of the 88 MB binary, by syspolicyd): one
 * clone per (verb × checkout) made every new worktree pay a dozen of them —
 * 37 GB of syspolicyd reads an hour on 2026-11-05, 28 % of the host's
 * attributed disk reads. Each checkout reaches it through a `verbs` symlink in
 * its own `CHECKOUT_BUN_DIR` (exec through a symlink is not a fresh file: no
 * scan, and the process is still listed under the clone's name). Keyed by
 * version so checkouts on two Buns do not re-clone each other's names.
 *
 * `cache`: deleted, the next run of each verb re-clones it (one scan each).
 */
export const processNamesDir = defineDataDir({
  kind: "cache",
  name: "process-names",
  owner: "packages/process-name",
  description:
    "One named APFS clone of Bun per CLI verb and Bun version (bun-<version>/equin · <verb>), shared by every checkout so macOS scans each name once, not once per worktree",
  reclaim: { kind: "safe" },
});

export default [processNamesDir];
