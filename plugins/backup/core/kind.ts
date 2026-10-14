/**
 * The backup arm's discriminator value.
 *
 * Spelled once because it is load-bearing in two places that must agree: the
 * kind of its `liveArm` (every wire name and row key prefix), and
 * the `run.kind` guard every field accessor makes before decoding a row as one
 * of this arm's.
 *
 * It lives in `backup/core` rather than in the arm's own `core/`, because both
 * sides of an import edge need it and the edge runs one way: `backup/web` names
 * a selected row with it (`{ kind, id }`) and opens the run-detail pane, while
 * `backup/runs-arm/web` needs that pane to open it from the merged list. With
 * the constant in the arm, those two edges close a cycle —
 * `backup → backup/runs-arm → backup` — which `plugin-boundaries` rejects at
 * plugin granularity, regardless of the runtimes involved. The parent's own
 * `core/` breaks it because `backup/web → backup/core` is intra-plugin and there
 * is no path back.
 *
 * **Do not re-export it from the arm's core to shorten an import.** Cross-plugin
 * re-exports are banned transitively, and it would put the edge straight back.
 */
export const BACKUP_RUN_KIND = "backup";
