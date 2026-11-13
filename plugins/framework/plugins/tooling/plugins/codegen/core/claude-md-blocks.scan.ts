import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { autogenFixedPoint } from "./autogen-block";

// Each plugin CLAUDE.md's generated block as it stands — the sha256 of its
// fixed point (`autogenFixedPoint`: the one block splicing leaves unchanged),
// or null when no block would — folded along the directory tree. A function of
// the file's bytes alone, so a check pass reads only the CLAUDE.md files an
// edit touched, never every plugin's.

/** Repo-relative CLAUDE.md path → sha256 of its fixed-point block, or null. */
export type ClaudeMdBlocks = Record<string, string | null>;

export const claudeMdBlocksFold: FileFold<null, ClaudeMdBlocks> = {
  url: import.meta.url,
  scan(src, rel) {
    const block = autogenFixedPoint(src);
    return { [rel]: block === null ? null : sha256Hex(block) };
  },
  combine: (parts) => Object.assign({}, ...parts) as ClaudeMdBlocks,
};
