// Reclaiming ONE namespace: the second half of what `reapAttempt` used to do
// inline, split out so it can be asked for by name.
//
// A namespace is four things — a Postgres database, a config dir, the gateway
// registry dir (which also holds the dist and the provenance marker), and the
// gitignored filtered registries inside whatever checkout composed it. Removing a
// checkout and reclaiming a namespace were one fused function; they are two jobs,
// and only the second one is here.
//
// This lives in its own sub-plugin rather than in `infra/worktree` because five
// CLI command files import that barrel, so anything added to it joins the CLI
// PROCESS's static import closure. Reclaiming reaches `database/admin`, and
// through it the DB pool — a large closure to graft onto a barrel the CLI freezes at load, and
// exactly the surface `cli:codegen-manifests-not-frozen` guards.

import { rm } from "node:fs/promises";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  databaseExists,
  dropDatabase,
} from "@plugins/database/plugins/admin/server";
import { listNamedCompositionRegistries } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  ensureMainWorktreeRoot,
  hasCompositionMarker,
  readCompositionMarker,
  removeWorktreeSpec,
  worktreePathFor,
  type CompositionMarker,
} from "@plugins/infra/plugins/worktree/server";
import { assertServableCompositionNamespace } from "@plugins/plugin-meta/plugins/composition/core";

/** A refused reclaim — a guard rejected the target before anything was touched. */
export class NamespaceReclaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespaceReclaimError";
  }
}

/**
 * Which checkout a namespace's filtered registries live in. All three marker arms
 * are represented; none collapses onto another.
 *
 * A discriminated result rather than a nullable string because "the marker
 * predates the `checkout` field" is a legitimate answer, not a failure, and it
 * must stay distinguishable from a resolved root. The marker's own docblock sets
 * the precedent: a reader reports an absent field as unknown rather than
 * guessing, and guessing here would delete a generated file out of an unrelated
 * checkout.
 */
type CheckoutRoot =
  { known: true; root: string } | { known: false; reason: string };

async function checkoutRootFor(
  marker: CompositionMarker,
): Promise<CheckoutRoot> {
  if (marker.checkout === undefined) {
    return {
      known: false,
      reason:
        "its provenance marker was written before the checkout field existed",
    };
  }
  // `null` is main's checkout — the suffix elides, so the namespace is the bare
  // composition id. Resolved through the SAME accessor `worktreePathFor` derives
  // from, so the two arms cannot name different repo roots.
  if (marker.checkout === null) {
    return { known: true, root: await ensureMainWorktreeRoot() };
  }
  return { known: true, root: await worktreePathFor(marker.checkout) };
}

/**
 * Reclaim every artifact of one compose-serve namespace: database → config dir →
 * registry dir → the composing checkout's filtered registries.
 *
 * ALL guards pass before anything is touched, else it throws
 * `NamespaceReclaimError` having changed nothing. A reclaim that cannot prove
 * ownership must fail loudly: this drops a database.
 *
 * `onStep` lets a streaming delete handler surface per-step progress without
 * duplicating the sequence; a background job passes nothing.
 */
export async function reclaimNamespace(
  ns: Namespace,
  onStep?: (step: "database" | "config" | "registry") => void,
): Promise<void> {
  // Guard 1 — the decisive provenance signal. A registry dir with no
  // `composition.json` belongs to a git checkout of the same name, and reclaiming
  // it is `reapAttempt`'s job, never this function's. Same guard, same reason, as
  // `resetCompositionData`'s.
  if (!hasCompositionMarker(ns)) {
    throw new NamespaceReclaimError(
      `reclaim "${ns}": no composition marker — the namespace is not a served ` +
        `composition, so it belongs to a git checkout; refusing to touch it.`,
    );
  }
  const marker = readCompositionMarker(ns);
  if (marker === null) {
    // Guard 1 just saw the marker, so this is a marker removed between the two
    // reads — a concurrent reclaim or an external delete. Refuse rather than
    // proceed on provenance we no longer hold.
    throw new NamespaceReclaimError(
      `reclaim "${ns}": its composition marker disappeared mid-check — ` +
        `another reclaim is running, or something removed it; refusing to proceed.`,
    );
  }

  // Guard 2 — the explicit "never main/central" gate. `central`, the main namespace
  // and `main` can never be served as a composition, so a marker claiming one of
  // them is corrupt provenance, and acting on it would drop the main app's
  // database.
  try {
    assertServableCompositionNamespace(marker.composition);
  } catch (err) {
    throw new NamespaceReclaimError(
      `reclaim "${ns}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolved BEFORE anything is destroyed, so a git failure while locating the
  // composing checkout aborts the reclaim intact rather than half-done.
  const checkout = await checkoutRootFor(marker);

  onStep?.("database");
  // The database may already be gone — an earlier reclaim dropped it, or a
  // legacy registry-only entry never had one — so the drop runs only when it
  // exists.
  if (await databaseExists(ns)) {
    await dropDatabase(ns);
  }

  onStep?.("config");
  // This namespace's subtree of config_v2's declared user-config directory — read
  // from that plugin's own declaration, so the two halves of the
  // fork-here/reclaim-there pair can never name different directories.
  await rm(configDir.file(ns), { recursive: true, force: true });

  onStep?.("registry");
  // Deleting the registry entry is how the gateway deregisters (its fsnotify
  // Remove handler calls `registry.remove()`, which stops the backend and cleans
  // its sockets) and frees the namespace's fsnotify watch. `removeWorktreeSpec`
  // takes the whole namespace dir with it, so the dist and the `composition.json`
  // marker are reclaimed by the step that deregisters — there is no separate
  // "dist" step to forget.
  await removeWorktreeSpec(ns);
  await removeFilteredRegistries(marker.composition, checkout);
}

/**
 * The fourth artifact, and the only one living inside a CHECKOUT rather than the
 * shared data dir: the composition's gitignored
 * `<dir>.composition.<id>.generated.ts` registries. Nothing has swept them since
 * the compose-serve deactivation stage was deleted, so they accumulate in every
 * checkout that has ever served something — gitignored, but `tsc` input.
 *
 * Ordered AFTER the spec removal by its caller, and that order is load-bearing:
 * the spec is what stops the backend, and the backend reads this file at spawn.
 * Removing it first leaves a window in which a respawn boots against a missing
 * registry and throws.
 *
 * ENUMERATED, never named. `listNamedCompositionRegistries` is the same sweep
 * input the deleted deactivation stage used, so `web`, `server` and `prewarm` are
 * all reclaimed together and a fourth filtered runtime added later is reclaimed
 * with no edit here. It walks the checkout's plugin tree, which is why it is the
 * last thing this does rather than something on a hot path — and why a vanished
 * checkout costs one failed `readdir`, not a walk. A vanished checkout is the
 * NORMAL case: the usual trigger is the checkout itself disappearing.
 */
async function removeFilteredRegistries(
  composition: string,
  checkout: CheckoutRoot,
): Promise<void> {
  // A legacy marker genuinely does not say which checkout composed this
  // namespace. Every other artifact is reclaimed by name, and deleting a
  // generated file out of a GUESSED checkout is the one irreversible thing an
  // unknown owner could cause here — so the unknown arm does nothing. Stated as a
  // decision, not an oversight: `checkout.reason` carries why.
  if (!checkout.known) return;
  for (const registry of listNamedCompositionRegistries(checkout.root)) {
    if (registry.name !== composition) continue;
    await rm(registry.file, { force: true });
  }
}
