import type { EditedFile } from "../../core/protocol";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { computeEditedFiles } from "./compute-edited-files";
import { editedFilesSignature } from "./edited-files-signature";

// ONE module-level memo, shared between the resource (machine/internal/edited-files-resource.ts —
// BOTH its `revalidate` and its `loader`) and the @parcel watcher
// (watch-edited-files.ts, the authoritative WRITER).
//
// The signature is the CONTENT signature (edited-files-signature.ts): headSha,
// merge-base, and each dirty file's (porcelain code, lstat mtime+size). It is a
// faithful function of every input `computeEditedFiles` reads, so it moves on an
// uncommitted save even though no SHA changed — the property that a pure git-SHA
// signature lacks, and the reason this file used to key on a watcher GENERATION
// COUNTER instead.
//
// The counter was never a fingerprint of git state, only of "how many times the
// watcher has run". `revalidate` probed git directly (instantly fresh) while the
// loader read the memo at the last completed watcher recompute (200ms debounce,
// 2s ceiling, behind withHeavyReadSlot) — so in that window a subscribe shipped
// (staleValue, freshEtag). This resource is `mode: "invalidate"`, so pushes carry
// no value: the client's next refetch matched the etag, got a 304, and kept the
// stale empty list FOREVER. It surfaced as "No edited files." plus a destructive
// "Drop & Close" over real changes.
//
// `createSignedMemo` binds signature and compute at construction: `memo.signature`
// feeds `revalidate`, `memo.get` feeds the `loader`, and they cannot drift because
// there is nothing to pass.
//
// Deleting the counter also deletes a hazard class. `evictEditedFiles` used to
// reset the worktree's counter to 0 alongside the cache entry, so a watcher
// recompute that started before `closeRoom` and landed after it wrote
// {generation: N, value} back into a freshly-reset namespace — where a new
// subscriber probing a low generation could hit that resurrected stale entry.
// Correctness depended on nobody writing across an evict. A content signature is
// self-validating: a late write-back stores {contentSig, value}, and any reader
// probes the CURRENT content signature, so a surviving entry is served only if it
// actually matches current git state. `evict` is now pure lifecycle cleanup.
//
// See research/2026-07-09-global-etag-value-coproduction.md and
// research/2026-06-19-global-incremental-git-loaders.md (Stage 4).
const memo = createSignedMemo<EditedFile[]>({
  name: "edited-files",
  signature: editedFilesSignature,
  compute: computeEditedFiles,
});

export const editedFilesMemo = memo;

/**
 * Write-through prime from the watcher (the authoritative writer): store the
 * freshly computed list under the signature the watcher captured BEFORE running
 * the compute, so the next `getEditedFiles` read is a pure cache hit.
 *
 * The signature-before-compute ordering is the memo's `prime` contract: a change
 * landing mid-compute leaves the stored signature older than the value, so the
 * next `get` re-probes, misses, and recomputes. Over-invalidates; never serves a
 * torn value under a matching signature.
 */
export function primeEditedFiles(
  worktreePath: string,
  signature: string,
  files: EditedFile[],
): void {
  memo.prime(worktreePath, signature, files);
}

export function evictEditedFiles(worktreePath: string): void {
  memo.evict(worktreePath);
}
