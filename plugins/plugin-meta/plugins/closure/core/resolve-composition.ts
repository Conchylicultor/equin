import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { classifyEdges } from "./classify-edges";
import { inclusionPathWithin } from "./inclusion-path";
import {
  allNodeIds,
  matchEntryPattern,
  parseEntryPattern,
} from "./entry-pattern";
import type {
  Composition,
  CompositionManifest,
  EdgeGraph,
  MembershipState,
  UnsatisfiedExclusion,
} from "./types";

/**
 * Transitive hard closure of a seed set over `hardForward`, plus every usage
 * rule (`graph.rules`) whose owner and one of whose users are in: the least
 * fixpoint — walk the edges, fire the rules that now hold, walk on from what
 * they added, until nothing fires. A rule's conclusion can satisfy another
 * rule, so one pass is not enough. The visited-set makes it cycle- and
 * self-edge-safe (a DAG is expected per the boundary rules; this is defensive,
 * not relied upon).
 */
export function hardClosure(
  seeds: Iterable<PluginId>,
  graph: EdgeGraph,
): Set<PluginId> {
  const out = new Set<PluginId>();
  const stack = [...seeds];
  let pending = graph.rules;
  for (;;) {
    while (stack.length) {
      const x = stack.pop()!;
      if (out.has(x)) continue;
      out.add(x);
      for (const t of graph.hardForward.get(x) ?? []) {
        if (!out.has(t)) stack.push(t);
      }
    }
    const waiting: typeof pending = [];
    for (const rule of pending) {
      if (out.has(rule.then)) continue;
      if (out.has(rule.owner) && rule.users.some((u) => out.has(u)))
        stack.push(rule.then);
      else waiting.push(rule);
    }
    if (stack.length === 0) return out;
    pending = waiting;
  }
}

/**
 * Given that these ids LEAVE the app, what else must leave with them.
 *
 * Not a mechanism's function — a statement about the graph. Removing a plugin
 * necessarily removes everything that would break without it: its DESCENDANTS
 * (`subtree` — a child makes no sense without its parent) and its transitive
 * IMPORTERS (`hardReverse` — they crash at module-eval when the imported barrel
 * is gone). This is the mirror of {@link hardClosure}, which walks `hardForward`
 * (what a plugin needs); here we walk the opposite direction (who needs this
 * plugin). The visited-set makes it cycle- and self-edge-safe.
 *
 * Used by the negative pass in {@link expandEntrySeeds}: writing `!X` on a
 * manifest means X leaves, and this is what that costs. Without the cascade a
 * negative would be silently undone — the seed set would lose X while X's
 * importers stayed seeded and dragged it straight back through
 * {@link hardClosure}.
 */
export function removalClosure(
  seeds: Iterable<PluginId>,
  graph: EdgeGraph,
): Set<PluginId> {
  const out = new Set<PluginId>();
  const stack = [...seeds];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue;
    out.add(x);
    for (const d of graph.subtree.get(x) ?? []) if (!out.has(d)) stack.push(d); // descendants
    for (const r of graph.hardReverse.get(x) ?? [])
      if (!out.has(r)) stack.push(r); // importers
  }
  return out;
}

/**
 * Expand a flattened manifest's entry patterns into the actual seed set under the
 * glob grammar (see {@link parseEntryPattern}). "Entry a node" means *that node
 * alone* — its hard dependencies are added later by {@link hardClosure}, never
 * seeded here. A whole subtree is opt-in via a trailing `.**`; the whole graph via
 * a bare `**`; a leading `!` removes ids.
 *
 * Takes the whole MANIFEST rather than just its entry points because the negative
 * pass has to see `selectedContributors` too — an explicitly selected plugin is a
 * local positive, and positives suppress negatives.
 *
 * Two passes:
 *  1. Positives (`!negate`): the exact `base` of every positive ID pattern goes
 *     into `named` (the set that classifies as `entry` and drives
 *     `redundantSelections`); every id the pattern matches (`base` ∪ its `.**`
 *     subtree, or every node for a root `**`) goes into `seeds`. A root `**`
 *     contributes NOTHING to `named` — see the comment at the loop.
 *  2. Negatives: see below — the targets, the opt-out, then the cascade.
 *
 * Unknown bases (no `subtree` entry) pass through inertly — the base itself is
 * still seeded/removed, it just contributes no descendants.
 */
export function expandEntrySeeds(
  manifest: CompositionManifest,
  graph: EdgeGraph,
): { seeds: Set<PluginId>; named: Set<PluginId>; negated: Set<PluginId> } {
  const seeds = new Set<PluginId>();
  const named = new Set<PluginId>();
  const parsed = [...manifest.entryPoints].map(parseEntryPattern);
  for (const p of parsed) {
    if (p.negate) continue;
    // A root `**` seeds every id and NAMES NONE. `named` is the protected set the
    // negative pass below refuses to trim; if `**` named everything, `!x.**` could
    // never remove anything, and `composition-closure` would then reject every
    // such negative as dead. Root means "everything is in", NOT "everything is
    // explicitly demanded" — that distinction is what keeps `**` plus negatives a
    // usable way to spell "the whole app minus this branch".
    if (p.kind === "id") named.add(p.base);
    for (const id of matchEntryPattern(p, graph)) seeds.add(id);
  }

  // ── The negative pass ──────────────────────────────────────────────────────
  // The TARGETS are what the author asserted must leave: every id every negative
  // pattern matches.
  const selected = new Set<PluginId>(manifest.selectedContributors);
  const negated = new Set<PluginId>();
  for (const p of parsed) {
    if (!p.negate) continue;
    for (const t of matchEntryPattern(p, graph)) negated.add(t);
  }
  // THE OPT-OUT. A composition that names X explicitly — as an entry positive or
  // as a selected contributor — is asking for X, and that request wins: the
  // negative on X is suppressed ENTIRELY, so nothing cascades from it either.
  // This is how a composition takes back a plugin the inherited base-exclusions
  // row negates, and it is what keeps resolution a pure additive union (a
  // positive from anywhere in a flattened `extends` chain shields its id).
  for (const id of [...negated]) {
    if (named.has(id) || selected.has(id)) negated.delete(id);
  }

  // THE CASCADE. Removing X also removes X's descendants and everything that
  // transitively imports X (see {@link removalClosure}) — otherwise a surviving
  // importer would drag X straight back through `hardClosure` and the negative
  // would be silently inert.
  //
  // Note how the two rules differ, and that the difference is the point:
  //  - naming X suppresses the negative on X (above) — that is the opt-out;
  //  - naming an IMPORTER of X does not. Asking for an importer is not asking
  //    for X, so the importer survives this loop, drags X back in through
  //    `hardForward`, and `resolveComposition`'s `unsatisfiedExclusions`
  //    postcondition fires naming the exact import chain. The ambiguity is made
  //    LOUD rather than guessed at in either direction.
  for (const id of removalClosure(negated, graph)) {
    if (named.has(id) || selected.has(id)) continue; // protected — may leave a hole
    seeds.delete(id);
  }

  return { seeds, named, negated };
}

export function resolveComposition(
  graph: EdgeGraph,
  manifest: CompositionManifest,
): Composition;
export function resolveComposition(
  tree: PluginTree,
  manifest: CompositionManifest,
): Composition;
export function resolveComposition(
  graphOrTree: EdgeGraph | PluginTree,
  manifest: CompositionManifest,
): Composition {
  const graph = isTree(graphOrTree) ? classifyEdges(graphOrTree) : graphOrTree;

  // Entry seeds under the glob grammar: each positive pattern seeds its exact base
  // (hard deps flow in via hardClosure below), plus its whole subtree when written
  // `.**`; negatives remove their targets AND everything that would break without
  // them (descendants + transitive importers), except ids this composition names
  // explicitly. `named` is the set of exact positive bases — it drives `entry`
  // membership and `redundantSelections`, so a `.**` base is `entry` while its
  // implicit descendants are `required`. A root `**` names nothing, so under it NO
  // node classifies `entry` and every bundled node is `required` — correct:
  // "everything" demands no particular plugin. `negated` is what the author
  // asserted must leave, kept for the postcondition at the end of this function.
  const {
    seeds: entrySeeds,
    named,
    negated,
  } = expandEntrySeeds(manifest, graph);

  // `required` = hard closure of the entry seeds ALONE — the locked set, unchanged.
  const required = hardClosure(entrySeeds, graph);

  // Conservative, single-pass bundle: NO fixpoint, NO auto-activation. The bundle is
  // exactly the hard closure of (entry seeds ∪ the explicitly selected contributors).
  const bundle = hardClosure(
    [...entrySeeds, ...manifest.selectedContributors],
    graph,
  );

  // `available` = the reviewable option frontier: ids NOT in the bundle that
  // soft-contribute to some bundled member. Use softReverse over the bundle, minus
  // the bundle itself. Sorted + deduped.
  const availableSet = new Set<PluginId>();
  for (const id of bundle) {
    for (const c of graph.softReverse.get(id) ?? []) {
      if (!bundle.has(c)) availableSet.add(c);
    }
  }
  const available = [...availableSet].sort();

  // Classification (precedence for in-bundle nodes: entry > required > contributor >
  // via-contributor). The `contributor` set is the selected contributors that landed
  // in the bundle (not already entry/required). `available` is assigned only to
  // out-of-bundle nodes in the available set; everything else defaults to `excluded`.
  const entrySet = named;
  const selectedSet = new Set(manifest.selectedContributors);
  const membership = new Map<PluginId, MembershipState>();
  for (const id of allNodeIds(graph)) membership.set(id, "excluded");
  for (const id of availableSet) membership.set(id, "available");
  for (const id of bundle) {
    membership.set(
      id,
      entrySet.has(id)
        ? "entry"
        : required.has(id)
          ? "required"
          : selectedSet.has(id)
            ? "contributor"
            : "via-contributor",
    );
  }

  // Selections already locked in by hard edges (entry/required) — a no-op selection.
  const redundantSelections = manifest.selectedContributors.filter(
    (x) => required.has(x) || entrySet.has(x),
  );

  // THE POSTCONDITION. A declared exclusion that did not take effect is a VALUE
  // in the result, never silence. The negative pass removes its targets and their
  // cascade from the SEED set, but a protected node (an explicitly named positive
  // or selected contributor that imports a target) survives that removal and
  // re-adds the target through `hardForward`. When that happens the composition
  // does not mean what its manifest says, so the target is reported along with
  // the exact import chain that put it back — which is also the repair
  // instruction. `composition-closure` fails on a non-empty list, codegen throws
  // on one, and Studio renders it.
  const unsatisfiedExclusions: UnsatisfiedExclusion[] = [...negated]
    .filter((t) => bundle.has(t))
    .sort()
    .map((t) => {
      const path = inclusionPathWithin(
        graph,
        {
          bundle,
          membership,
          entrySeeds,
          selectedContributors: manifest.selectedContributors,
        },
        t,
      );
      if (!path) {
        // Unreachable, and loud if it ever stops being. `t` is in `bundle`, and
        // `bundle` is `hardClosure(entrySeeds ∪ selectedContributors)` — so a
        // backward chain from `t` to one of those seeds must exist and the BFS
        // must find it. Reaching here means the graph and the closure disagree,
        // which is an engine bug, not a manifest the author can fix. Throwing
        // beats handing every consumer a `null` they can only render as a
        // shrug.
        throw new Error(
          `closure: "${t}" is in composition "${manifest.name}"'s bundle but no ` +
            `inclusion path back to the seed frontier could be built. The bundle is ` +
            `the hard closure of the seeds, so this should be impossible — the edge ` +
            `graph and the resolved bundle disagree.`,
        );
      }
      return { target: t, path };
    });

  return {
    bundle,
    membership,
    available,
    redundantSelections,
    negatedTargets: negated,
    unsatisfiedExclusions,
  };
}

function isTree(x: EdgeGraph | PluginTree): x is PluginTree {
  return (x as PluginTree).byDir instanceof Map;
}
