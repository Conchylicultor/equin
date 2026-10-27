// Deleting a composition: what does it own, and giving it back.
//
// Deleting a manifest row used to be one line of config — and the namespaces it
// was serving survived it forever AND became invisible at the same moment,
// because every composition-aware surface is keyed off the row that just
// vanished. These two reads/writes are what lets the delete name what it will
// destroy and then actually destroy it.
//
// NOT scoped to this backend's checkout, unlike `reset.ts` next door. A reset
// acts on the one namespace THIS checkout serves; a delete removes the
// composition itself, so it must reach every namespace the composition occupies
// — `sonata` from main and `sonata.att-x` from three worktrees are four
// namespaces, four databases and four config dirs. `namespacesOwnedByComposition`
// is a marker scan across every namespace on the host, and it can be: all of it
// lives in the shared `~/.equin/` tree, so one backend reclaims namespaces
// composed by other checkouts.

import { databaseExists } from "@plugins/database/plugins/admin/server";
import {
  namespaceHost,
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  NamespaceReclaimError,
  namespacesOwnedByComposition,
  reclaimNamespace,
  type OwnedNamespace,
} from "@plugins/infra/plugins/worktree/plugins/reclaim/server";
import { assertServableCompositionNamespace } from "@plugins/plugin-meta/plugins/composition/core";
import type {
  OwnedNamespaceInfo,
  ReclaimOutcome,
} from "../../shared/endpoints";

/** The marker's `checkout` field, all three arms kept apart. */
function builtBy(owned: OwnedNamespace): OwnedNamespaceInfo["builtBy"] {
  const { checkout } = owned.marker;
  if (checkout === undefined) return { kind: "unknown" };
  if (checkout === null) return { kind: "main" };
  return { kind: "checkout", checkout };
}

/**
 * Every namespace `id` occupies right now, described so a confirm dialog can
 * name what it is about to destroy: the address that stops working, which
 * checkout composed it, and whether a database really sits behind it.
 *
 * A pure read — no guard beyond what the marker scan already implies. Asking
 * what a never-servable id owns is a legitimate question with an honest answer
 * (nothing: no serve build ever wrote a marker naming it), and refusing to
 * answer it would only turn a truthful empty list into an error.
 */
export async function ownedNamespacesFor(
  id: string,
): Promise<OwnedNamespaceInfo[]> {
  const owned = await namespacesOwnedByComposition(id);
  return Promise.all(
    owned.map(async (o) => ({
      namespace: o.ns,
      host: namespaceHost(o.ns),
      url: namespaceUrl(o.ns),
      hasDatabase: await databaseExists(o.ns),
      builtBy: builtBy(o),
    })),
  );
}

/**
 * Reclaim every namespace `id` owns, one at a time, reporting each individually.
 *
 * ## Which of `resetCompositionData`'s four guards apply here
 *
 * 1. `assertServableCompositionNamespace` — **applies**, twice over. Once here
 *    on the requested id (an id that can never be served can never legitimately
 *    own a namespace, so a marker claiming one is corrupt provenance and acting
 *    on it would drop the main app's database), and again inside
 *    `reclaimNamespace` on each marker's own `composition` field.
 * 2. `hasCompositionMarker` — **applies**, and is enforced inside
 *    `reclaimNamespace`. It is also how the target set was found in the first
 *    place: a marker-less dir belongs to a git checkout and is invisible to the
 *    scan.
 * 3. `namespaceCollision` — **deliberately not applied.** It answers "may this
 *    owner CLAIM this name?", and it is enforced symmetrically at both claim
 *    sites: a serve build refuses a composition whose name a git worktree or
 *    branch already holds, and `setupWorktree` refuses a checkout whose name a
 *    marked namespace already holds. So a marked namespace and a same-named
 *    checkout cannot coexist, and the one remaining arm (a spec dir with no
 *    marker) is guard 2's job. Re-running it at reclaim time would mean refusing
 *    to give back a name a collision made unreachable — backwards — at the cost
 *    of a manifest read and a `git show-ref` spawn per namespace.
 * 4. **"its `serve` mode must not be `off`" — must NOT apply.** You
 *    delete a composition precisely when its serve intent is already off, and
 *    deactivating is deliberately never a reclaim trigger, so the namespaces
 *    most in need of reclaiming are exactly the ones that guard would refuse.
 *    Carrying it over would make the delete strand the data it exists to free.
 *
 * A failure on one namespace does not abort the others: each is an independent
 * set of artifacts, and one undroppable database must not strand the rest.
 * Nothing is swallowed — every outcome is reported, and the caller treats
 * anything short of all-reclaimed as failure.
 */
export async function reclaimCompositionData(
  id: string,
): Promise<{ namespace: Namespace; outcome: ReclaimOutcome }[]> {
  assertServableCompositionNamespace(id);

  const owned = await namespacesOwnedByComposition(id);
  const results: { namespace: Namespace; outcome: ReclaimOutcome }[] = [];
  for (const { ns } of owned) {
    results.push({ namespace: ns, outcome: await reclaimOne(ns) });
  }
  return results;
}

async function reclaimOne(ns: Namespace): Promise<ReclaimOutcome> {
  try {
    await reclaimNamespace(ns);
    return { kind: "reclaimed" };
  } catch (err) {
    // A refusal is a guard rejecting the target having touched nothing; anything
    // else is a reclaim that broke partway. Two different things to act on, so
    // they stay two arms rather than one "it didn't work".
    if (err instanceof NamespaceReclaimError) {
      return { kind: "refused", reason: err.message };
    }
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
