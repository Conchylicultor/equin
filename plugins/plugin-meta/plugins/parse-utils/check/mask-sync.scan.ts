import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";
import { maskSource } from "../core/mask-source";
import { maskDivergence, type MaskDivergence } from "./mask-sync";

// parse-utils:mask-sync's per-file work as a fold kept along the directory
// tree (`checks/core`'s `defineFoldCheck`): each file masked, parsed and
// compared on its own bytes, so a pass after an edit masks and parses only the
// edited files. Its records are keyed by this module's whole closure — the
// masker (`../core/mask-source`) and the oracle (`./mask-sync`) included — so
// an edit to the masker re-folds every file, which is what the check is for.

/** One file whose mask leaves sync with its parse, where it first does. */
export interface FileMaskDivergence extends MaskDivergence {
  rel: string;
}

/** The divergences of a set of files, in path order (empty when in sync — the usual answer). */
export type MaskSyncPart = FileMaskDivergence[];

export const maskSyncFold: FileFold<null, MaskSyncPart> = {
  url: import.meta.url,
  scan(src, rel) {
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
    const d = maskDivergence(ts, sf, src, maskSource(src));
    return d === null ? [] : [{ rel, ...d }];
  },
  combine: (parts) => parts.flat(),
};
