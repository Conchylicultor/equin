import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { relative } from "path";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  declarePluginSlots,
  declaredSlotSources,
  findUndeclaredSlots,
} from "@plugins/framework/plugins/slot-declaration/core";
import type {
  SlotDeclaringPlugin,
  SlotHandle,
  SlotNaming,
  SlotScope,
} from "@plugins/framework/plugins/slot-declaration/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { slotsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import { mainBundle } from "./main-bundle";
import { buildBarrelFreeTree } from "./barrel-free-tree";

/**
 * Load the web runtime the way the browser loads it, and run one declaration
 * pass over it — the build-time twin of what `PluginProvider` does on each
 * render pass, through the very same `declarePluginSlots`, so the two cannot
 * disagree about who owns a slot (or throw differently on a slot two plugins
 * claim).
 *
 * `scope` picks WHICH plugin set is modelled, and the two are not
 * interchangeable — a caller states the question it is asking:
 *
 * `"registry"` — THE REGISTRY, NOT THE FILESYSTEM. A plugin the app's composition
 * does not bundle is omitted from `web.generated.ts`, so the browser never loads
 * it, never creates its slots and never registers a config descriptor for them.
 * This pass therefore skips it too. Getting that wrong is not cosmetic: the
 * server's descriptors come from the reorderable-slots manifest, which is this
 * same set, so declaring a plugin the browser will not load makes the two
 * runtimes register different descriptor sets —
 * `config-v2:registrations-paired` fails, and the extra descriptor would own a
 * config file nothing on the web side can read. Skipping the IMPORT (not merely
 * the declaration) is what keeps that true: an imported barrel whose plugin this
 * pass does not declare would put its slots in the created-set with no owner,
 * which the orphan guard would then read as a slot nobody declares.
 *
 * The orphan guard consequently does not cover an excluded plugin's slots. That
 * is the honest scope: a plugin that ships nothing owes nothing. Bundling it
 * again puts its slots back in the created-set and the guard names any it forgot.
 *
 * `"source"` — EVERYTHING THE CHECKOUT DECLARES, excluded plugins included.
 * Here importing those barrels IS the point: a reader describing SOURCE asks
 * what the tree declares, not what the browser loads. `facets:render-complete`
 * checks the surface `review.plugin-changes.diff-renderer`, owned by
 * `review/plugins/plugin-changes` — which the `base-exclusions` row negates out
 * of every composition, so under registry scope it would read every facet as
 * missing its diff renderer. The created-set hazard above does
 * not follow here, because this scope DECLARES every barrel it imports: an
 * imported plugin's slots get an owner, so they never enter `created \ declared`
 * ownerless. What the orphan guard sees is a separate matter, settled at
 * {@link assertSlotsDeclared}.
 *
 * The registry pass is also the phase boundary the codegen ordering rests on:
 * after it, every web slot the browser will load exists and every owner is
 * stamped, and NO server barrel has been imported yet. Both the orphan guard and
 * the reorderable-slots manifest read that pass's result.
 *
 * Memoized per (scope, root) — NOT per root. The barrel imports are ESM-cache
 * hits on a second call, but each scope's declaration pass must run exactly once
 * per process, and the two scopes settle different sets: sharing one memo would
 * hand whichever caller arrived second the other's answer, silently.
 *
 * The two scopes therefore run as two independent passes, and the check runner
 * awaits every check under `Promise.all` — so both loops below can be in flight
 * at once. What makes that safe is `importBarrel` itself, which admits one
 * import at a time process-wide: overlapping loops would otherwise read a
 * `default` binding off a module the other loop is still evaluating. The memo
 * per root that preceded this one serialized them by accident; the lane states
 * it, for these two passes and for the five other loops in this process.
 */
const declaredByScopeAndRoot = new Map<string, Promise<SlotNaming>>();

export function declareSlotsFromBarrels(
  root: AppPath,
  scope: SlotScope,
): Promise<SlotNaming> {
  const key = `${scope}\0${root}`;
  let cached = declaredByScopeAndRoot.get(key);
  if (!cached) {
    cached = runDeclarationPass(root, scope);
    declaredByScopeAndRoot.set(key, cached);
  }
  return cached;
}

async function runDeclarationPass(
  root: AppPath,
  scope: SlotScope,
): Promise<SlotNaming> {
  const tree = await buildBarrelFreeTree(root);
  // `null` under `"source"` — NO membership filter at all, because an excluded
  // plugin's barrel is exactly what a source-scoped reader came for.
  //
  // `null` rather than an empty Set, and the difference is not stylistic: this
  // used to hold the DISABLED ids, an EXCLUSION set whose empty value correctly
  // meant "exclude nobody". A bundle is the opposite polarity — an INCLUSION set
  // whose empty value would exclude EVERY plugin, silently declaring nothing
  // under source scope. There is no empty value that means "no filter" here, so
  // the absence of a filter is spelled as an absence.
  const bundle = scope === "registry" ? mainBundle(tree, root) : null;
  registerBarrelStubs(root);

  const declaring: SlotDeclaringPlugin[] = [];
  for (const node of tree.byDir.values()) {
    // Registry scope only — see the two arms on `declareSlotsFromBarrels`: not
    // in the composition ⇒ not in the registry ⇒ not loaded ⇒ its slots do not
    // exist, and skipping the IMPORT (not just the declaration) is what keeps
    // the created-set free of ownerless slots the orphan guard would misread.
    if (bundle !== null && !bundle.has(node.id)) continue;
    // A plugin dir of this checkout.
    if (!node.runtimes.web) continue;
    const mod = await importBarrel(joinAppPath(node.dir, "web", "index.ts"));
    const sources = declaredSlotSources(mod);
    if (!sources) continue;
    declaring.push({ id: node.id, slots: sources });
  }

  // web-sdk has no `web/index.ts` — it IS the web runtime — and declares its own
  // root slots on its core barrel, which `buildPluginTree` also treats as its
  // web module. Same seed, so the two passes see the same set.
  const seedDir = joinAppPath(root, "plugins/framework/plugins/web-sdk");
  const seedBarrel = joinAppPath(seedDir, "core", "index.ts");
  const seedNode = tree.byDir.get(seedDir);
  if (seedNode && existsSync(seedBarrel)) {
    const sources = declaredSlotSources(await importBarrel(seedBarrel));
    if (sources) declaring.push({ id: seedNode.id, slots: sources });
  }

  // Throws on a slot two plugins claim; stamps the owner onto each slot object,
  // and returns the naming THIS pass settled (see `SlotNaming`: its answers are
  // its own, not a read of the process-global stamps). The scope travels with
  // the naming, so an `out-of-scope` answer can say what it is not in scope of.
  return declarePluginSlots(declaring, scope);
}

/**
 * The created-vs-declared guard: every slot constructed in this process must be
 * declared by exactly one plugin (`PluginDefinition.slots`).
 *
 * WHY HERE. Both sets are complete only where module loading is complete, and
 * this process is the one place that holds: {@link declareSlotsFromBarrels}
 * imports every web barrel. In the browser, web plugins load in TIERS
 * (`web-sdk/core/load-tiers.ts`), so mid-boot `created` and `declared` are both
 * partial and a slot created by an eager module but declared by a deferred
 * plugin would false-positive. The build is the guarantee, not a backstop.
 *
 * WHY IT CANNOT BE FORGOTTEN. `defineSlot` is the single funnel every slot
 * constructor calls, and it appends to the created-set at construction — so this
 * sees every slot that exists, whatever file, factory or nesting depth produced
 * it, with no registry to keep in sync.
 *
 * WHY IT RUNS BEFORE THE REST OF CODEGEN. An undeclared slot is a slot missing
 * from the reorderable-slots manifest, and a missing manifest row is a config
 * descriptor that never registers — which `pruneOrphanedConfigFiles` would read
 * as an orphaned config file and DELETE. Failing here, before any config origin
 * is generated, is what keeps a declaration mistake from costing authored files.
 *
 * WHY `"registry"`, AND WHY THAT IS NOT AN OMISSION TO "COMPLETE". The guard is
 * registry-scoped ON PURPOSE: a disabled plugin ships nothing and owes nothing,
 * so its slots are outside what this guard is asking about. Switching it to
 * `"source"` would look like widening the net and would instead import every
 * disabled barrel ahead of the freeze point this phase boundary defines, and
 * demand declarations from plugins that register no descriptors — which is the
 * `config-v2:registrations-paired` divergence the registry scope exists to
 * prevent. Re-enabling a plugin puts its slots back in the created-set and the
 * guard names any it forgot; that is the whole coverage story.
 */
export async function assertSlotsDeclared(root: AppPath): Promise<void> {
  // Runs (and memoizes) the registry declaration pass; the stamps it writes are
  // what the guard reads back off each created slot.
  await declareSlotsFromBarrels(root, "registry");
  const orphans = findUndeclaredSlots();
  if (orphans.length === 0) return;
  throw new Error(await renderOrphanReport(root, orphans));
}

/**
 * How many slots each plugin directory constructed, from the barrel-free tree's
 * static parse. Built lazily, only on failure.
 *
 * It can no longer be a slotId → dir map: an orphan is precisely a slot with NO
 * id (an id is derived from the declaration this slot is missing), so there is
 * no key to look one up by. The directories that constructed slots are still
 * exactly where an author has to go, so that is what the report names.
 */
async function slotBearingDirs(root: AppPath): Promise<string[]> {
  const tree = await buildBarrelFreeTree(root);
  const dirs: string[] = [];
  for (const node of tree.byDir.values()) {
    const slots = getFacet(node, slotsFacetDef) ?? [];
    if (slots.length > 0) dirs.push(relative(root, node.dir));
  }
  return dirs.sort();
}

async function renderOrphanReport(
  root: AppPath,
  orphans: readonly SlotHandle[],
): Promise<string> {
  const byKind = new Map<string, number>();
  for (const slot of orphans) {
    byKind.set(slot.meta.kind, (byKind.get(slot.meta.kind) ?? 0) + 1);
  }
  const lines = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, n]) => `  ${n} × ${kind}`);
  const dirs = await slotBearingDirs(root);

  return [
    `[slots] ${orphans.length} slot(s) exist that no plugin declares.`,
    "",
    "An undeclared slot has no id to name it by — an id is DERIVED from the",
    "declaration it is missing — so they are listed by kind:",
    ...lines,
    "",
    "Add each one under a KEY in the `slots: {…}` record of the plugin that owns",
    "it — the exact sibling of `contributions` in that plugin's `web/index.ts`.",
    "The key NAMES the slot: its id becomes `<pluginId>.<key>`. A value may be a",
    "slot or an object whose own values are slots, so",
    "`slots: { ...Shell, storyDetail: storyDetailPane }` covers a slot group",
    "(whose own keys name its slots) and a pane in one line.",
    "",
    `Slot-constructing plugin directories (${dirs.length}); the culprit is one`,
    "whose `slots` record you just changed:",
    ...dirs.slice(0, 40).map((d) => `  ${d}`),
    ...(dirs.length > 40 ? [`  … ${dirs.length - 40} more`] : []),
  ].join("\n");
}
