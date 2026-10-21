import {
  defineDataDir,
  relativeToDataRoot,
} from "@plugins/infra/plugins/paths/core";

/**
 * The user layer of the three-layer config model: one `<worktree>/` subtree per
 * namespace, holding the propagated `<name>.origin.jsonc` files and the user's
 * own `<name>.jsonc` overrides (plus `.ancestor.jsonc` conflict snapshots).
 *
 * A worktree's subtree is forked from main's on create (the worktree
 * workspace's `forkConfigDir`) and reaped
 * with the worktree (`debug/worktree-cleanup`), so consumers name a namespace
 * through `.file(name)` rather than re-deriving the layout.
 */
export const configDir = defineDataDir({
  kind: "state",
  name: "config",
  owner: "config_v2",
  description:
    "The user config layer: per-worktree propagated origins plus the user's own JSONC overrides and conflict ancestors",
  // The override files are the user's own edits — hand-written or made through
  // Settings — and exist nowhere else. Deleting them silently reverts every
  // customization to the committed defaults.
  reclaim: {
    kind: "never",
    reason:
      "the user's own config overrides live here and exist nowhere else; deleting them silently reverts every customization",
  },
});

/**
 * Where the user config layer sits *relative to a data root* —
 * `"state/config"`.
 *
 * For the callers that must place this directory under a root that is NOT this
 * process's own: a release bundle's seeded defaults are copied into a freshly
 * installed app's data dir, which is not the dev root. They cannot use
 * `configDir.path`, but they must not spell the directory a second time — a
 * hand-written copy would go on naming the old spot after the layout migration
 * moved the real one, so the seed would land where nothing reads it and the
 * released app would silently fall back to hardcoded schema defaults.
 *
 * Derived from the declaration rather than written out, so the two cannot drift.
 * Same shape (and same reason) as `assetMirrorRelativeToRoot()`.
 */
export function userConfigRelativeToRoot(): string {
  return relativeToDataRoot(configDir);
}

export default [configDir];
