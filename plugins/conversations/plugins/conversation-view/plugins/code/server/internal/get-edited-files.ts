import type { EditedFile } from "../../core/protocol";
import { editedFilesMemo } from "./edited-files-cache";

// The READ path, through the watched memo (edited-files-cache.ts):
//   - WATCHED (a conversation on screen holds `watchEditedFiles`): the list the
//     last pass computed — no git spawn, no heavy slot. While the first pass
//     runs, it awaits that pass.
//   - UNWATCHED, or after a failed pass: one status scan (the facts) and the
//     content signature; a hit returns the cached list, a miss computes once
//     over those facts, single-flighted per signature — so concurrent reads
//     (the pages, the meta, plugin-changes) collapse onto one git batch.
//
// See research/2026-10-25-global-edited-files-paged-cost.md and
// research/2026-06-15-global-live-state-cascade-contention.md (Change 5).
export function getEditedFiles(worktreePath: string): Promise<EditedFile[]> {
  return editedFilesMemo.get(worktreePath);
}
