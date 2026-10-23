// Namespace ownership: who may claim `worktrees/<ns>/`, and the provenance
// marker that records who did.
//
// A namespace is `<composition>.<checkout>` with both sentinels elided
// (`@plugins/infra/plugins/namespace/core`), so a SINGLE label is ambiguous:
// `foo` could be composition `foo` on main, or the main composition on checkout
// `foo`. That ambiguity is inherent to any encoding that preserves today's URLs,
// so it is PREVENTED here rather than decoded downstream.
//
// And it is not merely an ambiguous URL. Both claimants would resolve to the
// same spec dir, the same socket and the same Postgres database — a data
// collision. So the rule is SYMMETRIC refusal: whichever side tries to claim an
// already-occupied namespace fails loudly, composition or checkout. Neither wins.
//
// Single-sourced here (rather than inside the CLI bin) so the build-time
// compose-serve stage, the runtime reset endpoint and worktree creation all
// consume the exact same safety-critical logic; a marker-name or collision-rule
// change can never drift between them.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isNamespaceHostAlias,
  NAMESPACE_HOST_ALIASES,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";

export const COMPOSITION_MARKER_FILE = "composition.json";

export interface CompositionMarker {
  composition: string;
  /**
   * The checkout this namespace was composed from — `null` for the main
   * checkout, whose suffix elides.
   *
   * This field is why there is no `parseNamespace`. Decomposing `foo` back into
   * a (composition, checkout) pair would need the composition set at every
   * reader; recording the pair where it is MINTED cannot be ambiguous. Optional
   * because markers written before this field existed carry none — a reader
   * reports that as unknown rather than guessing.
   */
  checkout?: string | null;
  builtAt: string;
  buildId: string;
  /**
   * The commit the composing build ran from. Optional because markers written
   * before this field existed (and builds whose HEAD did not resolve) carry
   * none — a reader reports that as unknown rather than guessing.
   */
  commit?: string | null;
}

/** Who is asking for the namespace. The refusal rules differ by side. */
export type NamespaceClaimant =
  { kind: "composition"; id: string } | { kind: "checkout"; name: string };

export interface NamespaceProbe {
  specDirExists: boolean;
  hasCompositionMarker: boolean;
  gitWorktreeDirExists: boolean;
  branchExists: boolean;
  /** A manifest row already carries this id — the checkout-side collision. */
  compositionIdExists: boolean;
}

/**
 * Refuse to claim a namespace another owner already holds.
 *
 * Composition side (the arms that existed before): a dir is ours only if it
 * carries our `composition.json` marker; a same-named git worktree or branch
 * would collide the moment that worktree builds.
 *
 * Checkout side (the mirror): a checkout may not take a name the composition
 * manifest already uses, nor move into a dir a compose-serve namespace holds.
 * Agent worktrees are always `att-<ts>-<slug>`, so in practice this only ever
 * fires on a hand-named worktree — which is exactly the case that would
 * otherwise silently share a database with a composition.
 */
export function namespaceCollision(
  ns: Namespace,
  claimant: NamespaceClaimant,
  probe: NamespaceProbe,
): string | null {
  // Both sides: the gateway resolves an alias host before it looks a name up,
  // so a namespace spelled like one could never be reached.
  if (isNamespaceHostAlias(ns)) {
    return `"${ns}" is a host alias of the "${NAMESPACE_HOST_ALIASES[ns]}" namespace — the gateway would never route to it; pick another name.`;
  }
  if (claimant.kind === "composition") {
    if (probe.gitWorktreeDirExists) {
      return `a git worktree checkout named "${ns}" exists under .claude/worktrees/ — rename the composition.`;
    }
    if (probe.branchExists) {
      return `a git branch named "${ns}" exists — its worktree would collide with this namespace; rename the composition.`;
    }
    if (probe.specDirExists && !probe.hasCompositionMarker) {
      return (
        `the worktrees-registry dir for "${ns}" exists WITHOUT a ${COMPOSITION_MARKER_FILE} marker — ` +
        `it belongs to a git worktree or foreign namespace; refusing to overwrite.`
      );
    }
    return null;
  }

  if (probe.compositionIdExists) {
    return (
      `a composition named "${ns}" exists in the manifest — a checkout of that name would ` +
      `resolve to the same namespace, spec dir and database; rename the worktree.`
    );
  }
  if (probe.specDirExists && probe.hasCompositionMarker) {
    return (
      `the worktrees-registry dir for "${ns}" carries a ${COMPOSITION_MARKER_FILE} marker — ` +
      `it belongs to a served composition; refusing to create a checkout that would collide with it.`
    );
  }
  return null;
}

function branchExists(root: string, name: string): boolean {
  const proc = Bun.spawnSync(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  );
  return proc.exitCode === 0;
}

/**
 * Gather the facts `namespaceCollision` judges.
 *
 * `compositionIds` is passed in rather than read here because the two callers
 * live in different worlds: compose-serve runs in the CLI and already holds the
 * manifest it read off disk, while worktree creation runs in a backend and reads
 * it through the config registry. One prober, two suppliers.
 */
export function probeNamespace(
  root: string,
  ns: Namespace,
  compositionIds: ReadonlySet<string>,
): NamespaceProbe {
  const specDir = join(worktreesDir(), ns);
  return {
    specDirExists: existsSync(specDir),
    hasCompositionMarker: existsSync(join(specDir, COMPOSITION_MARKER_FILE)),
    gitWorktreeDirExists: existsSync(join(root, ".claude", "worktrees", ns)),
    branchExists: branchExists(root, ns),
    compositionIdExists: compositionIds.has(ns),
  };
}

/**
 * Stamp the provenance marker for a compose-serve namespace, and PROVE it
 * landed. Idempotent — safe, and meant, to be called more than once per build.
 *
 * The writer lives here, next to the readers and next to the filename itself,
 * because it started life as a private copy inside the build CLI: one module
 * spelled the path to write it and another spelled the path to read it, which
 * is the drift this plugin exists to prevent. Nothing outside can name the file.
 *
 * ATOMIC (temp + rename). A torn marker reads as a foreign dir and would fail
 * the namespace-collision guard forever.
 *
 * VERIFIED. The write is followed by a read-back, and a marker that is not on
 * disk afterwards throws. A silent no-op here is not cosmetic: the marker is the
 * only proof the namespace is a served composition, so its absence makes the
 * next build of the same composition REFUSE the namespace (`namespaceCollision`
 * reads a marker-less dir as foreign), makes the Serve status report a live
 * composition as not served, and makes Reset refuse it. Missing provenance is a
 * permanently-stuck namespace, so it fails loudly at the instant it is written
 * rather than at the next build, in another process, a day later.
 *
 * CALL IT AGAIN AT THE COMMIT POINT. Claiming the namespace up front is not
 * enough on its own: a build spends most of its wall time waiting for a host CPU
 * grant, and the namespace dir is a shared-filesystem location that can be
 * removed while it waits — this is not hypothetical, it is what happened on
 * 2026-08-19 (dir created 19:42:38, gone before 19:57:31, recreated by the dist
 * compose). Every other artifact in that dir is (re)written at the end of the
 * build and so healed itself; the marker was written only in the prefix and did
 * not. So the marker is stamped twice: once to CLAIM the dir before anything
 * else writes into it, and once as part of the COMMIT that makes the namespace
 * live. The second write carries the same bytes, so in the normal case it
 * changes nothing.
 */
export function stampCompositionMarker(
  ns: Namespace,
  marker: CompositionMarker,
): void {
  const dir = join(worktreesDir(), ns);
  const path = join(dir, COMPOSITION_MARKER_FILE);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, path);
  const landed = readCompositionMarker(ns);
  if (landed === null || landed.composition !== marker.composition) {
    throw new Error(
      `composition marker for "${ns}" did not land at ${path} ` +
        `(read back: ${landed === null ? "absent" : `composition "${landed.composition}"`}). ` +
        `Without it the namespace cannot be re-served, reset, or reported as served.`,
    );
  }
}

/** True when `worktrees/<ns>/composition.json` exists — the namespace is compose-serve-owned. */
export function hasCompositionMarker(ns: Namespace): boolean {
  return existsSync(join(worktreesDir(), ns, COMPOSITION_MARKER_FILE));
}

/**
 * Read the provenance marker for a compose-serve namespace. Returns the parsed
 * marker, or `null` when the namespace carries no `composition.json` (not
 * compose-serve-owned).
 */
export function readCompositionMarker(ns: Namespace): CompositionMarker | null {
  const path = join(worktreesDir(), ns, COMPOSITION_MARKER_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CompositionMarker;
}
