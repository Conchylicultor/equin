import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The machine's shared named Buns: `bun-<version>/equin · <verb>` for the CLI
 * and `bun-<version>/processes/equin · agent` for the SDK agents, one APFS clone per
 * name and Bun version, shared by every checkout and backend.
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
    "One named APFS clone of Bun per name and Bun version (bun-<version>/equin · <verb> for the CLI, bun-<version>/processes/equin · agent for SDK agents), shared by every checkout so macOS scans each name once, not once per worktree or conversation",
  reclaim: { kind: "safe" },
});

export default [processNamesDir];
