import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";
import { realpathSync } from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "path";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  declaredSlotSources,
  settleSlotNaming,
  type SlotDeclaringPlugin,
  type SlotNaming,
  type SlotScope,
} from "@plugins/framework/plugins/slot-declaration/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  currentRecordStore,
  outsideFilesOf,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  evaluateBarrels,
  type BarrelRef,
  type BarrelRuntime,
  type CreatedSlot,
  type EvaluatedBarrels,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/evaluate/core";
import type {
  PluginNode,
  PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { buildBarrelFreeTree } from "./barrel-free-tree";
import { mainBundle } from "./main-bundle";
import type { CodegenPass } from "./codegen-pass";

/**
 * The build's barrels, EVALUATED: what importing each plugin barrel produced,
 * read from the shared evaluated records (`plugin-meta/plugin-records`) and
 * imported live only where a record missed. Every generator that used to
 * import barrels to read runtime values (the slot declarations, the theme and
 * app declarations, token groups, config descriptors, the enriched tree)
 * reads these instead — so a build that changed nothing imports no barrel.
 *
 * Two evaluations per process, in the order the codegen phases need them:
 *
 * - {@link evaluateWebBarrels}: every web barrel (plus web-sdk's core seed),
 *   right after the pre-barrel manifests are written. It settles the
 *   registry slot naming the orphan guard and the post-web manifests read.
 * - {@link evaluateAllBarrels}: every barrel of every runtime, after the
 *   post-web manifests are written (a server barrel reads them at load). It
 *   feeds the enriched tree and the config origins.
 *
 * Each reads its pass's phase set (`CodegenPass.phaseRepo`), taken when it
 * starts: in a build, re-taken after the earlier phase's writes, so a
 * generated file written by it is keyed by its new content; in a check run,
 * the run's one set.
 *
 * What the records hold is DATA: a contribution's component is a named
 * function stand-in, its slot a stand-in that {@link recordSlotNaming}
 * resolves. A reader needing a live value (a descriptor's zod schema) must
 * import the barrel itself.
 */

/** web-sdk declares its own root slots on its core barrel: it has no `web/index.ts`. */
const WEB_SDK_DIR = "plugins/framework/plugins/web-sdk";
const WEB_SDK_SEED = `${WEB_SDK_DIR}/core/index.ts`;

const RUNTIMES: readonly BarrelRuntime[] = [
  "web",
  "server",
  "machine",
  "central",
];

export interface BarrelEvaluation {
  tree: PluginTree;
  barrels: EvaluatedBarrels;
  /** Every evaluated barrel, in the order the declaration passes read them. */
  refs: readonly BarrelRef[];
  /** The evaluated barrels of one plugin, in runtime order (web-sdk's seed as its web). */
  modulesOf(node: PluginNode): {
    mod: Record<string, unknown>;
    runtime: BarrelRuntime;
  }[];
}

async function evaluate(
  pass: CodegenPass,
  runtimes: readonly BarrelRuntime[],
): Promise<BarrelEvaluation> {
  const { root } = pass;
  const tree = await buildBarrelFreeTree(pass);
  const snapshot = await pass.phaseRepo();
  const refs: BarrelRef[] = [];
  const byNode = new Map<string, BarrelRef[]>();
  const add = (node: PluginNode, ref: BarrelRef): void => {
    refs.push(ref);
    let list = byNode.get(node.dir);
    if (!list) byNode.set(node.dir, (list = []));
    list.push(ref);
  };
  const seedNode = tree.byDir.get(joinAppPath(root, WEB_SDK_DIR));
  const hasSeed = seedNode !== undefined && snapshot.has(WEB_SDK_SEED);
  // The seed first among web-sdk's modules, as the enriched tree always read it.
  if (hasSeed && runtimes.includes("web"))
    add(seedNode, {
      path: WEB_SDK_SEED,
      pluginId: seedNode.id,
      runtime: "web",
    });
  for (const runtime of runtimes) {
    for (const node of tree.byDir.values()) {
      if (!node.runtimes[runtime]) continue;
      add(node, {
        path: `${relative(root, node.dir)}/${runtime}/index.ts`,
        pluginId: node.id,
        runtime,
      });
    }
  }
  const realRoot = realpathSync(root);
  const barrels = await evaluateBarrels(
    {
      snapshot,
      store: currentRecordStore(),
      readOutside: outsideFilesOf(snapshot),
      realRoot,
    },
    refs,
  );
  return {
    tree,
    barrels,
    refs,
    modulesOf(node) {
      return (byNode.get(node.dir) ?? []).map((r) => ({
        mod: barrels.module(r.path),
        runtime: r.runtime,
      }));
    },
  };
}

/** Every web barrel, evaluated (memoized per pass). */
export const evaluateWebBarrels: (
  pass: CodegenPass,
) => Promise<BarrelEvaluation> = sharedMemo(
  "evaluated barrels",
  (pass) => evaluate(pass, ["web"]),
  { owner: (pass) => pass.repo },
);

/**
 * Every barrel of every runtime, evaluated — the declaration-dependent ones
 * (whose plugin fills its contributions from the whole declared set) resolved
 * against the full source-scope declaration (memoized per pass).
 */
export const evaluateAllBarrels: (
  pass: CodegenPass,
) => Promise<BarrelEvaluation> = sharedMemo(
  "evaluated barrels",
  async (pass) => {
    // The web phase first: its slot naming is what a later reader (and the
    // orphan guard) settled, and its records are hits for this one.
    await evaluateWebBarrels(pass);
    const all = await evaluate(pass, RUNTIMES);
    await all.barrels.resolveDeclarationDependent(all.refs);
    return all;
  },
  { owner: (pass) => pass.repo },
);

/** The slot naming of one scope over the evaluated records, per pass. */
function namingOf(
  scope: SlotScope,
): (pass: CodegenPass) => Promise<SlotNaming> {
  return sharedMemo(
    "slot naming",
    async (pass) => {
      const ev =
        scope === "registry"
          ? await evaluateWebBarrels(pass)
          : await evaluateAllBarrels(pass);
      return settleSlotNaming(declaringPlugins(ev, pass.root, scope), scope);
    },
    { owner: (pass) => pass.repo },
  );
}
const namings: Record<SlotScope, (pass: CodegenPass) => Promise<SlotNaming>> = {
  registry: namingOf("registry"),
  source: namingOf("source"),
};

/**
 * The slot naming over the evaluated records — the build's twin of a live
 * declaration pass (`declareSlotsFromBarrels`), through the same
 * `collectSlots` normalisation and the same refusals, but over the records'
 * slot stand-ins: the naming answers `idOf` for a contribution read from a
 * record, never for a live slot.
 *
 * `"registry"`: the bundled plugins' web barrels and web-sdk's seed, as the
 * browser loads them. `"source"`: every barrel of every plugin.
 */
export function recordSlotNaming(
  pass: CodegenPass,
  scope: SlotScope,
): Promise<SlotNaming> {
  return namings[scope](pass);
}

function declaringPlugins(
  ev: BarrelEvaluation,
  root: AppPath,
  scope: SlotScope,
): SlotDeclaringPlugin[] {
  const bundle = scope === "registry" ? mainBundle(ev.tree, root) : null;
  const out: SlotDeclaringPlugin[] = [];
  let seed: SlotDeclaringPlugin | null = null;
  for (const ref of ev.refs) {
    if (bundle !== null && !bundle.has(asPluginId(ref.pluginId))) continue;
    const slots = declaredSlotSources(ev.barrels.module(ref.path));
    if (!slots) continue;
    const plugin = { id: asPluginId(ref.pluginId), slots };
    // The registry pass has always read web-sdk's seed last.
    if (scope === "registry" && ref.path === WEB_SDK_SEED) seed = plugin;
    else out.push(plugin);
  }
  if (seed) out.push(seed);
  return out;
}

/**
 * The bundled web barrels (and web-sdk's seed): what the browser loads — of
 * the main composition, or of the composition whose `bundle` is passed.
 */
export async function bundledWebBarrels(
  pass: CodegenPass,
  of?: ReadonlySet<string>,
): Promise<{
  ev: BarrelEvaluation;
  refs: BarrelRef[];
  bundle: ReadonlySet<string>;
}> {
  const ev = await evaluateWebBarrels(pass);
  const bundle = of ?? mainBundle(ev.tree, pass.root);
  return {
    ev,
    bundle,
    refs: ev.refs.filter(
      (r) => r.path === WEB_SDK_SEED || bundle.has(asPluginId(r.pluginId)),
    ),
  };
}

/**
 * The slots the browser's modules create that no bundled plugin declares —
 * `created \ declared` over the records: what each bundled web barrel's
 * modules created (their evaluated records), minus what the registry naming
 * declares. Identities, so a factory used by ten panes cannot hide one
 * missing declaration behind another.
 */
export async function undeclaredSlots(
  pass: CodegenPass,
): Promise<CreatedSlot[]> {
  const { ev, refs } = await bundledWebBarrels(pass);
  const naming = await recordSlotNaming(pass, "registry");
  const declared = new Set<string>();
  for (const entry of naming.declarations()) {
    const id = ev.barrels.identityOf(entry.slot);
    if (id !== undefined) declared.add(id);
  }
  return ev.barrels
    .createdSlots(refs.map((r) => r.path))
    .filter((c) => !declared.has(c.identity));
}
