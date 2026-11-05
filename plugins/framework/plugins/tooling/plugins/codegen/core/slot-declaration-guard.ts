import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { relative } from "path";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  declarePluginSlots,
  declaredSlotSources,
} from "@plugins/framework/plugins/slot-declaration/core";
import type {
  SlotDeclaringPlugin,
  SlotNaming,
  SlotScope,
} from "@plugins/framework/plugins/slot-declaration/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { slotsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import { mainBundle } from "./main-bundle";
import { buildBarrelFreeTree } from "./barrel-free-tree";
import { undeclaredSlots } from "./evaluated-barrels";
import type { CreatedSlot } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { CodegenPass } from "./codegen-pass";

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
 * The LIVE pass, for readers that hold live slot objects — checks importing
 * barrels themselves (`config-v2:registrations-paired`, the page and
 * active-data checks). The build's generators never run it: they read the
 * evaluated records and the naming settled over them (`recordSlotNaming`,
 * `evaluated-barrels.ts`), whose slots are stand-ins this naming cannot name.
 *
 * Memoized per (scope, pass) — NOT per pass. The barrel imports are ESM-cache
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
const declaredByPass = new WeakMap<
  CodegenPass,
  Map<SlotScope, Promise<SlotNaming>>
>();

export function declareSlotsFromBarrels(
  pass: CodegenPass,
  scope: SlotScope,
): Promise<SlotNaming> {
  let byScope = declaredByPass.get(pass);
  if (!byScope) declaredByPass.set(pass, (byScope = new Map()));
  let cached = byScope.get(scope);
  if (!cached) {
    cached = runDeclarationPass(pass, scope);
    byScope.set(scope, cached);
  }
  return cached;
}

async function runDeclarationPass(
  pass: CodegenPass,
  scope: SlotScope,
): Promise<SlotNaming> {
  const { root } = pass;
  const tree = await buildBarrelFreeTree(pass);
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
 * The created-vs-declared guard: every slot the browser's modules construct
 * must be declared by exactly one plugin (`PluginDefinition.slots`).
 *
 * WHY OVER RECORDS. Both sets come from the build's evaluated records
 * (`evaluated-barrels.ts`): each module's record lists the slots its top-level
 * evaluation created, by identity (module + ordinal), and the registry naming
 * over the bundled web barrels' records says which of them a plugin declares.
 * So the guard sees every slot that exists, whatever file, factory or nesting
 * depth produced it — a factory used by ten panes yields ten identities — and
 * reads it without importing a barrel when nothing changed.
 *
 * WHY IT RUNS BEFORE THE REST OF CODEGEN. An undeclared slot is a slot missing
 * from the reorderable-slots manifest, and a missing manifest row is a config
 * descriptor that never registers — which `pruneOrphanedConfigFiles` would read
 * as an orphaned config file and DELETE. Failing here, before any config origin
 * is generated, is what keeps a declaration mistake from costing authored files.
 *
 * WHY `"registry"`, AND WHY THAT IS NOT AN OMISSION TO "COMPLETE". The guard is
 * registry-scoped ON PURPOSE: a disabled plugin ships nothing and owes nothing,
 * so its slots are outside what this guard is asking about — the created set is
 * the bundled web barrels' modules only. Switching it to `"source"` would
 * demand declarations from plugins that register no descriptors — which is the
 * `config-v2:registrations-paired` divergence the registry scope exists to
 * prevent. Re-enabling a plugin puts its modules back in the set and the guard
 * names any slot it forgot; that is the whole coverage story.
 */
export async function assertSlotsDeclared(pass: CodegenPass): Promise<void> {
  const orphans = await undeclaredSlots(pass);
  if (orphans.length === 0) return;
  throw new Error(await renderOrphanReport(pass, orphans));
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
async function slotBearingDirs(pass: CodegenPass): Promise<string[]> {
  const tree = await buildBarrelFreeTree(pass);
  const dirs: string[] = [];
  for (const node of tree.byDir.values()) {
    const slots = getFacet(node, slotsFacetDef) ?? [];
    if (slots.length > 0) dirs.push(relative(pass.root, node.dir));
  }
  return dirs.sort();
}

async function renderOrphanReport(
  pass: CodegenPass,
  orphans: readonly CreatedSlot[],
): Promise<string> {
  const byKind = new Map<string, number>();
  for (const slot of orphans) {
    byKind.set(slot.meta.kind, (byKind.get(slot.meta.kind) ?? 0) + 1);
  }
  const modules = [...new Set(orphans.map((o) => o.module))].sort();
  const lines = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, n]) => `  ${n} × ${kind}`);
  const dirs = await slotBearingDirs(pass);

  return [
    `[slots] ${orphans.length} slot(s) exist that no plugin declares.`,
    "",
    "An undeclared slot has no id to name it by — an id is DERIVED from the",
    "declaration it is missing — so they are listed by kind:",
    ...lines,
    "",
    "Created by these modules (at their top level, through any factory):",
    ...modules.map((m) => `  ${m}`),
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
