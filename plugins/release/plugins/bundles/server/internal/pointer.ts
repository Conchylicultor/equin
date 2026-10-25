import { join } from "node:path";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { compositionReleaseDir } from "./out-dir";

/**
 * The ONE directory ship looks in for a composition's bundles, resolved once.
 *
 * **Which namespace it keys on, and why.** `releaseOutDir` roots every release
 * at `<EQUIN_DIR>/releases/<namespace>/<comp>-<target>/`, and the
 * namespace is a PARAMETER on both sides — the producer names it, the reader
 * names it, and they agree because each kind of process answers the same
 * question the same way:
 *
 * - **hand-run release + hand-run ship** — both mint the namespace from the
 *   CHECKOUT they were invoked from (`checkoutNamespace(root)`), so a release
 *   cut in a worktree is found by a ship run from that same worktree.
 * - **Studio-triggered release + UI-triggered ship** — both run inside the
 *   worktree backend, so both name that backend's runtime namespace.
 *
 * The remaining mismatch is the CROSS pair (a Studio release, then a hand-run
 * ship from a DIFFERENT checkout), and it is deliberately left as a loud miss:
 * this function is never called for more than one namespace, and every refusal
 * carries the absolute path it looked in. Searching both namespaces would make
 * "which bundle am I shipping?" ambiguous, which is strictly worse than a miss
 * you can read in one line.
 */
export function bundleRoot(
  namespace: Namespace,
  composition: string,
): { namespace: string; compDir: string } {
  return {
    namespace,
    compDir: compositionReleaseDir(namespace, composition, "web"),
  };
}

/**
 * The stable pointer a PACKED run claims: `latest-<platform>`, one per platform.
 *
 * Keyed by platform, not just by `<comp>-<target>`, because a host `--dev` run
 * and a `linux-x64` candidate of the same composition used to overwrite each
 * other's bare `latest` — after which `ship` resolved the wrong run and refused
 * on platform mismatch. With the platform in the NAME the clobber is
 * structurally impossible rather than a refusal.
 *
 * This function and `claimLatestPointer`'s caller in the release CLI are the
 * only two places the name is spelled; they change together.
 */
export function latestPointerName(platform: string): string {
  return `latest-${platform}`;
}

/** Whether `entry` is one of the pointer symlinks rather than a run dir. */
export function isPointerName(entry: string): boolean {
  return entry === "latest" || entry.startsWith("latest-");
}

/** Absolute path of the `latest-<platform>` pointer for a composition. */
export function latestPointerPath(compDir: string, platform: string): string {
  return join(compDir, latestPointerName(platform));
}
