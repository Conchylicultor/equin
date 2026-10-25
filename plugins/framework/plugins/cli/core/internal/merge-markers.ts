import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveGitDir } from "./git-dir";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * The marker kinds the `.gitattributes` merge drivers drop when they
 * auto-resolve a generated file during a merge/rebase.
 *
 * COUPLED TO THE DRIVER SCRIPTS: `../../scripts/regen-*.sh` `touch` these exact
 * filenames. Shell cannot import TypeScript, so the names live in both places —
 * this is the authoritative list, and each script's docblock points here.
 */
export const MERGE_MARKER_KINDS = ["generated", "migrations"] as const;

export type MergeMarkerKind = (typeof MERGE_MARKER_KINDS)[number];

export function mergeMarkerDir(root: string): string {
  return join(resolveGitDir(root), LEGACY_IDS.mergeMarkersDir);
}

/**
 * Which auto-resolves are still UNCONSUMED — i.e. a merge driver took the
 * upstream side of a generated file and no normalize pass has re-derived the
 * canonical content from the merged source tree since.
 *
 * A marker is dropped by the driver and cleared by whoever normalizes
 * (`normalizeGeneratedArtifacts`, or `build` once its codegen stage has
 * rewritten every artifact from source). A non-empty result therefore means the
 * checkout is carrying an artifact that does NOT match its own sources.
 */
export function readMergeMarkers(root: string): MergeMarkerKind[] {
  const dir = mergeMarkerDir(root);
  return MERGE_MARKER_KINDS.filter((kind) => existsSync(join(dir, kind)));
}

/** Consume every marker. Call only once the artifacts really are canonical. */
export function clearMergeMarkers(root: string): void {
  rmSync(mergeMarkerDir(root), { recursive: true, force: true });
}
