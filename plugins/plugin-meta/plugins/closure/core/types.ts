import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { EntryPattern } from "./entry-pattern";

export type { EntryPattern } from "./entry-pattern";

/** How a cross-plugin dependency binds: a hard `import` (mandatory) or a soft
 *  slot `contribution` (prunable). */
export type EdgeKind = "hard" | "soft";

/**
 * Why a hard edge exists: `from` imports `to`; `from` styles with a token `to`'s
 * token group supplies; or `to` is a COMPANION of `from` — it contributes
 * `companion: true` to a slot `from` owns, so it ships wherever `from` does.
 * When several hold, import wins over token, and token over companion.
 */
export type HardEdgeVia = "import" | "token" | "companion";

/** One directed cross-plugin edge `from → to` of a given kind. */
export interface Edge {
  from: PluginId;
  to: PluginId;
  kind: EdgeKind;
  /** Set on hard edges. */
  via?: HardEdgeVia;
}

/**
 * The cross-plugin dependency graph, both directions, kind-separated and indexed.
 *
 * Every tree node is a key in all four maps (possibly with an empty array) so
 * callers never branch on `undefined`. The fixpoint reads only the maps; `edges`
 * is the derived flat list for explain/tests/future visualization.
 */
export interface EdgeGraph {
  /** A → barrels A hard-imports. */
  hardForward: Map<PluginId, PluginId[]>;
  /** B → who hard-imports B. */
  hardReverse: Map<PluginId, PluginId[]>;
  /** A → owners of the slot groups A contributes to. */
  softForward: Map<PluginId, PluginId[]>;
  /** B → contributors into the slot groups B owns. */
  softReverse: Map<PluginId, PluginId[]>;
  /**
   * Node → all descendant ids (its proper subtree). NOT a dependency edge:
   * containment is applied only at *entry seeding*, and only when opted into with a
   * `.**` entry pattern — writing `apps.website.**` ships its whole subtree, while a
   * bare `apps.website` seeds the node alone (its hard deps flow in via the closure).
   * Never a transitive import edge (importing an umbrella's barrel does not pull in
   * its children).
   */
  subtree: Map<PluginId, PluginId[]>;
  /** Flat derived list of every edge (hard then soft). */
  edges: Edge[];
}

/**
 * A named, conservative selection over the plugin space. `entryPoints` are the
 * explicitly-included plugins as {@link EntryPattern} globs: entrying a node means
 * *that node + its hard deps* — nothing more. Its whole subtree is opt-in via a
 * trailing `.**` (`apps.website.**`); a leading `!` removes its matches AND
 * everything that would break without them (descendants + transitive importers),
 * never an id this composition names explicitly — naming it is the opt-out.
 * `selectedContributors` are the soft contributors a human/agent has explicitly
 * opted IN — reviewed options pulled into the bundle. Default `[]` ⇒ the bundle
 * is the pure hard closure of the entries; NOTHING soft is included by default.
 *
 * `extends` names other compositions (typically **packs** — reusable, entry-less
 * contributor sets) whose `entryPoints` + `selectedContributors` are unioned into
 * this one, transitively, before resolution. Purely additive: a pack can only add
 * options, never replace or redirect — so composing remains a union/hard-closure
 * with no precedence. Resolve `extends` with {@link flattenManifest} BEFORE feeding
 * a manifest to {@link resolveComposition} / the causality queries; the engine core
 * always operates on an already-flattened (`extends: []`) manifest.
 */
export interface CompositionManifest {
  name: string;
  entryPoints: EntryPattern[];
  selectedContributors: PluginId[];
  /** Names of other compositions merged into this one, transitively. Optional;
   *  absent ⇒ `[]`. Cleared to `[]` once {@link flattenManifest} has merged them. */
  extends?: string[];
}

export type MembershipState =
  /** Explicitly in entryPoints. */
  | "entry"
  /** In hardClosure(entrySeeds) — locked, NOT removable. */
  | "required"
  /** A selected contributor that's in the bundle (not entry/required). */
  | "contributor"
  /** In the bundle only via a selected contributor's hard closure. */
  | "via-contributor"
  /** Not in the bundle, but soft-contributes to it — a reviewable option. */
  | "available"
  /** Not in the bundle and not a reviewable option. */
  | "excluded";

export interface Composition {
  bundle: Set<PluginId>;
  /** Total: every tree node maps to a state, default `"excluded"`. */
  membership: Map<PluginId, MembershipState>;
  /** The reviewable option frontier: ids not in the bundle that soft-contribute to
   *  some bundled member. Sorted, deduped. These carry membership `"available"`. */
  available: PluginId[];
  /** selectedContributors that are also entry/required → already locked in by hard
   *  edges, so the selection is a no-op worth surfacing. */
  redundantSelections: PluginId[];
  /**
   * The ids a negative entry pattern named DIRECTLY, after the opt-out
   * subtraction and before the importer cascade — what this composition's author
   * asserted must leave, not what leaving them cost.
   *
   * The distinction is the one a reader needs: a plugin in here was excluded on
   * purpose, and a plugin outside the bundle but outside this set left because
   * something in here took it (`removalClosure`). Docgen's `(excluded)` vs
   * `(excluded — cascade)` is exactly that question, and it reads the answer off
   * the same resolution that produced `bundle` — there is no second pattern
   * parse anywhere.
   *
   * A `Set` rather than a sorted array because every consumer asks membership,
   * the same reason `bundle` is one.
   */
  negatedTargets: Set<PluginId>;
  /**
   * Declared exclusions that did NOT take effect — **non-empty means the
   * composition does not mean what its manifest says.**
   *
   * A negative removes its targets and their removal closure from the seed set,
   * but an id this composition names explicitly is protected from that removal.
   * A protected node that IMPORTS a negated target therefore survives and drags
   * the target back in through the hard closure. Each entry names such a target
   * plus the import chain that re-added it.
   *
   * `composition-closure` fails on a non-empty list, codegen throws on one, and
   * Studio renders it. Required rather than optional so every consumer has to
   * see it: an optional field is one nobody reads.
   *
   * Sorted by target. Empty is the healthy answer, and the common one.
   */
  unsatisfiedExclusions: UnsatisfiedExclusion[];
}

/**
 * One declared exclusion that the resolved bundle contradicts: the excluded
 * plugin, and why it is in the bundle anyway.
 *
 * `path` is NOT nullable, unlike `explainInclusion`'s return. That function
 * answers about an arbitrary target, where "not bundled" is a legitimate `null`.
 * Here the target is in the bundle by construction — the list is
 * `negated ∩ bundle` — and `bundle` is the hard closure of the seeds, so a
 * backward chain to some seed or selected contributor always exists. Making the
 * field non-nullable is what stops the check message, codegen's throw and Studio
 * from each inventing a fallback string for a case that cannot happen;
 * `resolveComposition` throws instead if the engine ever contradicts itself.
 */
export interface UnsatisfiedExclusion {
  /** The negated id that is nevertheless bundled. */
  target: PluginId;
  /** The shortest chain that re-added it — same shape `explainInclusion` returns. */
  path: InclusionPath;
}

/** One hop in an inclusion explanation. */
export interface InclusionStep {
  from: PluginId;
  to: PluginId;
  kind: EdgeKind;
}

/** Why a given target plugin is in the bundle: the seed it originates from and
 *  the shortest chain of edges that pulls it in. */
export interface InclusionPath {
  target: PluginId;
  state: MembershipState;
  origin: PluginId;
  originKind: "entry" | "contributor";
  steps: InclusionStep[];
}
