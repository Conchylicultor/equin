import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  HOST_ROOTS,
  HOSTS,
  SHIPPED_RUNTIME_FOLDERS,
  asPluginId,
  type HostId,
  type PluginId,
  type RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import type { EdgeGraph, Edge, HardEdgeVia, UsageRule } from "./types";
import { collectCompanionSlots, slotGroupOwners } from "./companion-slots";

function pushUnique(
  map: Map<PluginId, PluginId[]>,
  key: PluginId,
  value: PluginId,
): void {
  const list = map.get(key)!;
  if (!list.includes(value)) list.push(value);
}

/**
 * Build the hard/soft cross-plugin dependency graph from facet data already
 * serialized into the tree. Pure and browser-safe — reads only `node.facets`.
 *
 * Hard edges come from `cross-refs.apiUses` imports, `cross-refs.tokenUses`
 * (styling with a token another plugin's group supplies) and companion
 * contributions (a slot owner → the contributor it cannot work without) — see below. Imports are unioned across the runtimes
 * that SHIP (`SHIPPED_RUNTIME_FOLDERS` — the deployed app's own folders; `e2e`,
 * `provision` and `cli` are developer surfaces and are not reasons to bundle
 * anything), self-edges dropped — precise & nested-aware after the cross-refs
 * rework. Note
 * these are *import* edges only: importing a parent umbrella's barrel does NOT
 * pull in its children (the barrel re-exports the umbrella's own symbols, not the
 * sub-plugins). Parent→child *containment* is therefore deliberately NOT a hard
 * edge; it is captured separately in `subtree` and applied only at entry seeding
 * (selecting an umbrella *as an entry* ships its subtree; merely importing it does
 * not).
 *
 * Soft edges come from slot ownership (`slots` facet, first-writer-wins per group,
 * `_runtimeOnly` slots skipped) crossed with each plugin's `contributions.static`
 * slots — exactly mirroring `contributions.relate()`, but keyed by `PluginId`
 * rather than `name`.
 */
export function classifyEdges(tree: PluginTreeData): EdgeGraph {
  const hardForward = new Map<PluginId, PluginId[]>();
  const hardReverse = new Map<PluginId, PluginId[]>();
  const softForward = new Map<PluginId, PluginId[]>();
  const softReverse = new Map<PluginId, PluginId[]>();
  const subtree = new Map<PluginId, PluginId[]>();

  // Why each hard edge exists, first writer wins: the blocks below run in
  // precedence order (import, token, companion), so an edge two of them derive
  // carries the stronger reason. Every hard edge goes through `addHard`, so the
  // flat list below can never meet one without a reason.
  //
  // Each edge also gathers the folders of `from` it holds through (every
  // reason's, whatever won `via`), which is what a host view filters on.
  const via = new Map<string, HardEdgeVia>();
  const runtimes = new Map<string, Set<RuntimeFolder>>();
  const addHard = (
    from: PluginId,
    to: PluginId,
    why: HardEdgeVia,
    rt: RuntimeFolder,
  ) => {
    pushUnique(hardForward, from, to);
    pushUnique(hardReverse, to, from);
    const k = `${from}\0${to}`;
    if (!via.has(k)) via.set(k, why);
    let set = runtimes.get(k);
    if (!set) runtimes.set(k, (set = new Set()));
    set.add(rt);
  };

  // Seed every node as a key so callers never branch on undefined.
  for (const node of tree.byDir.values()) {
    hardForward.set(node.id, []);
    hardReverse.set(node.id, []);
    softForward.set(node.id, []);
    softReverse.set(node.id, []);
    subtree.set(node.id, []);
  }

  // ── Containment: node → all descendant ids (its proper subtree) ────────
  for (const node of tree.byDir.values()) {
    const descendants = subtree.get(node.id)!;
    const stack = [...node.children];
    while (stack.length) {
      const child = stack.pop()!;
      descendants.push(child.id);
      stack.push(...child.children);
    }
  }

  // ── Hard edges: union apiUses across the SHIPPED runtimes, drop self ───
  //
  // Only the runtimes some host executes (`SHIPPED_RUNTIME_FOLDERS`), each
  // edge tagged with the importing folders so a host view keeps only those it
  // runs (a `machine/` import is a desktop edge, never a browser one).
  // This loop used to walk `Object.values(apiUses)` — every runtime — which made
  // an import written in a developer-only folder a reason to bundle its target:
  // `reorder/e2e` imports the shared Playwright harness, whose `provision/`
  // imports `browser-fetch`, so every composition's backend closure contained
  // Playwright and the website release failed to compile on a `chromium-bidi`
  // require inside playwright-core that nothing ever executes.
  for (const node of tree.byDir.values()) {
    const crossRefs = getFacet(node, crossRefsFacetDef);
    if (!crossRefs) continue;
    for (const rt of SHIPPED_RUNTIME_FOLDERS) {
      for (const use of crossRefs.apiUses[rt]) {
        if (use.plugin === node.id) continue; // self-edge
        if (!hardForward.has(use.plugin)) continue; // unknown target — inert
        addHard(node.id, use.plugin, "import", rt);
      }
    }
  }

  // ── Hard edges from token use: P paints with a var G's token group supplies ─
  //
  // The var exists on the page only once G's `web/` registers the group, and
  // nothing imports that half: a Tailwind class or a `var(--x)` names the token,
  // not the plugin. As an import-less dependency it used to drop out of every
  // served bundle unless hand-listed in `served-baseline` (equin.ai shipped
  // blank app tiles and an unpainted headline that way). Deriving it here makes
  // the bundle carry every group its members paint with, by construction.
  for (const node of tree.byDir.values()) {
    const crossRefs = getFacet(node, crossRefsFacetDef);
    if (!crossRefs) continue;
    for (const use of crossRefs.tokenUses) {
      if (use.plugin === node.id) continue; // self-edge
      if (!hardForward.has(use.plugin)) continue; // unknown target — inert
      // The var is painted on the page, whatever folder names it.
      addHard(node.id, use.plugin, "token", "web");
    }
  }

  // ── Soft edges: slot-group ownership × static contributions ───────────
  // groupName → owning PluginId. Skip `_runtimeOnly` slots; first-writer-wins.
  const groupOwner = slotGroupOwners(tree);

  const hostProviders = new Map<PluginId, string[]>();
  for (const node of tree.byDir.values()) {
    const data = getFacet(node, contributionsFacetDef);
    if (!data) continue;
    if (data.hostServiceProvides.length > 0)
      hostProviders.set(node.id, [...data.hostServiceProvides]);
    // Collect the distinct slot groups this plugin contributes to.
    const groups = new Set<string>();
    for (const contribution of data.static) {
      const head = contribution.slot.split(".")[0];
      if (head) groups.add(head);
    }
    for (const group of groups) {
      const owner = groupOwner.get(group);
      if (!owner || owner === node.id) continue;
      pushUnique(softForward, node.id, owner);
      pushUnique(softReverse, owner, node.id);
    }
  }

  // ── Hard edges from companions: the slot's OWNER needs the contributor ──
  //
  // A contribution flagged `companion: true` (accepted only by a slot declared
  // `companions: true`) is one its slot's owner cannot work without, though it
  // never imports it — usually because it cannot: the sprite sheet `<Icon>`
  // draws from sits above `ui.icons`, so the import would be a cycle. The edge
  // runs owner → contributor, the reverse of the soft contribution edge (which
  // stays): a bundle holding the owner holds its companions. Every other
  // contribution to the same slot remains an opt-in option.
  //
  // A KEYED slot's companion (`companions: { key, space }`) is no edge but a
  // `UsageRule`: required only while used. The date cell ships with the
  // data-view primitive AND a plugin referencing field type `date` — a
  // bundle without dates carries no date cell, and one with dates can no
  // longer ship without it (the hand-listed `data-views` pack this replaces
  // missed six of them).
  //
  // A `plugin`-space key is a plugin's own id, referenced by that plugin alone
  // (see `KeySpace`): no facet spells it, every node uses itself.
  const usersOf = new Map<string, PluginId[]>();
  for (const node of tree.byDir.values())
    usersOf.set(`plugin\0${node.id}`, [node.id]);
  for (const node of tree.byDir.values())
    for (const ref of getFacet(node, crossRefsFacetDef)?.keyRefs ?? []) {
      const k = `${ref.space}\0${ref.key}`;
      const list = usersOf.get(k);
      if (list) list.push(node.id);
      else usersOf.set(k, [node.id]);
    }
  const rules: UsageRule[] = [];
  for (const slot of collectCompanionSlots(tree, groupOwner)) {
    for (const companion of slot.companions) {
      if (!slot.keyed) {
        addHard(slot.owner, companion.plugin, "companion", slot.runtime);
        continue;
      }
      const key = companion.key!;
      rules.push({
        then: companion.plugin,
        owner: slot.owner,
        users: [...new Set(usersOf.get(`${slot.keyed.space}\0${key}`) ?? [])]
          .filter((u) => u !== companion.plugin)
          .sort(),
        space: slot.keyed.space,
        key,
      });
    }
  }
  rules.sort(
    (a, b) => a.then.localeCompare(b.then) || a.key.localeCompare(b.key),
  );

  // ── Host roots: what each host's process root runs, in every bundle ───
  //
  // A root (server-core's `bin/` on the desktop) is imported by no barrel, so
  // no edge reaches it or what it imports — yet every composition booted on
  // its host runs it. Its plugin and each plugin its root folder imports are
  // seeded into every composition on the host (`expandEntrySeeds`); their
  // own hard closures follow from there. A root plugin missing from the tree
  // contributes nothing, like an unknown edge target (a synthetic test tree);
  // the real tree's roots are pinned by `closure.test.ts`. A root whose facet
  // never read its folder throws.
  const byId = new Map([...tree.byDir.values()].map((n) => [n.id, n]));
  const hostRoots = new Map<HostId, PluginId[]>();
  for (const host of HOSTS) {
    const ids = new Set<PluginId>();
    for (const root of HOST_ROOTS[host]) {
      const node = byId.get(asPluginId(root.plugin));
      if (!node) continue;
      ids.add(node.id);
      const crossRefs = getFacet(node, crossRefsFacetDef);
      if (!crossRefs) continue; // a tree without the facet (synthetic)
      const rootFolder = crossRefs.rootUses.find(
        (r) => r.folder === root.folder,
      );
      // The facet read the root's folder, or it is broken: a root whose
      // imports went unread would silently drop what it runs out of every
      // composition again — the bug this map exists for.
      if (!rootFolder)
        throw new Error(
          `closure: host root ${root.plugin}/${root.folder} (${host}) has no rootUses in its cross-refs facet — the facet did not read the root's folder.`,
        );
      for (const use of rootFolder.uses)
        if (hardForward.has(use.plugin)) ids.add(use.plugin);
    }
    hostRoots.set(host, [...ids].sort());
  }

  // ── Derived flat edge list ────────────────────────────────────────────
  const edges: Edge[] = [];
  for (const [from, tos] of hardForward)
    for (const to of tos)
      edges.push({
        from,
        to,
        kind: "hard",
        via: via.get(`${from}\0${to}`)!,
        runtimes: [...runtimes.get(`${from}\0${to}`)!].sort(),
      });
  for (const [from, tos] of softForward)
    for (const to of tos) edges.push({ from, to, kind: "soft" });

  return {
    hardForward,
    hardReverse,
    softForward,
    softReverse,
    subtree,
    edges,
    rules,
    hostProviders,
    hostRoots,
  };
}
