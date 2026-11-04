import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The plugin-record store: one SQLite file of content-addressed records (file
 * facts, facet extracts, evaluated barrels, module facts), shared by every
 * worktree — a record's key is the hash of its inputs, so any build of any
 * checkout reads what another computed.
 *
 * @see plugins/plugin-meta/plugins/plugin-records/cli/internal/sqlite-store.ts
 */
export const pluginRecordsDir = defineDataDir({
  kind: "cache",
  name: "plugin-records",
  owner: "plugin-meta/plugin-records",
  description:
    "Content-addressed plugin records (per-file import facts, per-plugin facet extracts, evaluated barrels) in one SQLite file, shared across worktrees",
  reclaim: { kind: "safe" },
});

export default [pluginRecordsDir];
