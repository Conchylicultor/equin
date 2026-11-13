import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { hasConflictMarker } from "@plugins/framework/plugins/cli/core";

// Which plugin CLAUDE.md files still carry a git conflict marker, as a fold
// kept along the directory tree: a file's answer is a function of its bytes,
// so a pass after an edit reads only the edited CLAUDE.md files — never the
// ~1.8k a whole-tree scan read on every pass.

/** The repo-relative paths, in path order, of the files holding a marker. */
export const claudeMdConflictsFold: FileFold<null, string[]> = {
  url: import.meta.url,
  scan: (src, rel) => (hasConflictMarker(src) ? [rel] : []),
  combine: (parts) => parts.flat(),
};
