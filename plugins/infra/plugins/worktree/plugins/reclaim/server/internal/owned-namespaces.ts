// Who owns a namespace — asked, never enumerated.
//
// `namespaceFor` mints `<composition>.<checkout>` with both sentinels elided, and
// `composition-namespace.ts` explains why there is deliberately no inverse: a
// single label is ambiguous, so decomposing a name back into a (composition,
// checkout) pair would need the composition set at every reader. The marker
// records the pair where it is MINTED, and these two readers are the queries that
// marker exists to answer.
//
// That is the structural half of the reclaim. A caller does not name the kinds of
// namespace a checkout might have left behind; it asks what the checkout owns and
// reclaims the answer. A namespace kind invented later is reclaimed with no edit
// to any caller.

import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import {
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import {
  readCompositionMarker,
  type CompositionMarker,
} from "@plugins/infra/plugins/worktree/server";

/** A namespace that carries a provenance marker, paired with what it says. */
export interface OwnedNamespace {
  ns: Namespace;
  marker: CompositionMarker;
}

/**
 * Every compose-serve-owned namespace on this host: one readdir of the gateway
 * registry dir, then one marker read per namespace-shaped dir.
 *
 * A missing registry dir (ENOENT) yields an empty list; any other readdir error
 * is surfaced loudly — mirroring `readRegistryNames` in the reaper, and for the
 * same reason `worktreeListPaths` states: callers read ABSENCE from this list as
 * meaning, so a failure that degraded to `[]` would read as "nothing is owned".
 *
 * A dir whose name is not a legal namespace is SKIPPED, not a failure: it cannot
 * be something this system minted, and the registry dir is a shared filesystem
 * location a human can drop anything into. A malformed `composition.json` inside
 * a namespace-shaped dir is the opposite — that dir WAS minted here, and an
 * unreadable marker is torn provenance, so it throws rather than making the
 * namespace silently invisible to every reclaim trigger.
 */
export async function listCompositionNamespaces(): Promise<OwnedNamespace[]> {
  let entries;
  try {
    entries = await readdir(worktreesDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }

  const out: OwnedNamespace[] = [];
  for (const entry of entries) {
    // The legacy flat `<name>.json` specs are files, and they never carried a
    // marker — only the subdir layout has one to read.
    if (!entry.isDirectory()) continue;
    if (!isNamespace(entry.name)) continue;
    const ns = asNamespace(entry.name);
    let marker: CompositionMarker | null;
    try {
      marker = readCompositionMarker(ns);
    } catch (err) {
      throw new Error(
        `namespace "${ns}" carries an unreadable provenance marker: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Its owner cannot be determined, so nothing may reclaim it.`,
      );
    }
    if (marker === null) continue;
    out.push({ ns, marker });
  }
  return out;
}

/**
 * The namespaces owned by one git checkout — what `reapAttempt` must reclaim
 * alongside the checkout's own namespace.
 *
 * An EXACT string match, which is what keeps the marker's three arms apart
 * structurally rather than by a rule someone has to remember: `checkout: null`
 * (owned by main) and `checkout: undefined` (a marker written before the field
 * existed, owner UNKNOWN) both fail `=== checkout` for every possible argument,
 * so neither can ever be swept by a checkout trigger. Guessing an owner here
 * drops a database.
 */
export async function namespacesOwnedByCheckout(
  checkout: string,
): Promise<OwnedNamespace[]> {
  const all = await listCompositionNamespaces();
  return all.filter((o) => o.marker.checkout === checkout);
}

/**
 * The namespaces one composition occupies, across every checkout that has served
 * it — what deleting the composition's manifest row must reclaim.
 *
 * Deliberately not filtered by checkout: `sonata` served from main and
 * `sonata.att-X` served from a worktree are two namespaces, two databases and two
 * config dirs, and deleting the composition strands both.
 */
export async function namespacesOwnedByComposition(
  id: string,
): Promise<OwnedNamespace[]> {
  const all = await listCompositionNamespaces();
  return all.filter((o) => o.marker.composition === id);
}
