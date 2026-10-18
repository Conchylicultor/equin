import {
  dataViewsManifestPath,
  renderDataViewsManifest,
} from "./data-views-gen";
import { writeGenerated } from "./write-generated";
import {
  reorderableSlotsManifestPath,
  renderReorderableSlotsManifest,
} from "./reorderable-slots-gen";
import {
  customUtilitiesManifestPath,
  renderCustomUtilities,
} from "./custom-utilities-gen";
import { spaceRampManifestPath, renderSpaceRamp } from "./space-ramp-gen";
import {
  fieldsEagerManifestPath,
  renderFieldsEagerManifest,
} from "./fields-eager-gen";
import { iconManifestPath, renderIconManifest } from "./icon-manifest-gen";
import {
  companionManifestPath,
  renderCompanionManifest,
} from "./companion-manifest-gen";
import {
  eagerTierManifestPath,
  renderEagerTierManifest,
} from "./eager-tier-gen";

/**
 * The single source of truth for the PRE-BARREL manifest set.
 *
 * A pre-barrel manifest is a `*.generated.ts` that a plugin barrel imports at
 * module-load (directly or transitively) to register config_v2 descriptors or
 * other load-time state. Bun's ESM cache freezes a module on the first
 * `import()` and a later disk write cannot invalidate it — so EVERY such
 * manifest MUST be regenerated (via a barrel-FREE tree walk) BEFORE the first
 * barrel import in a build run. Otherwise `generateConfigOrigins` re-imports
 * stale barrels, misses the new descriptor, and `pruneOrphanedConfigFiles`
 * deletes the freshly-authored override.
 *
 * Listing the set here (rather than hand-wiring each generator into the
 * pipeline) makes the invariant enforceable: the runtime guard
 * (`assertPreBarrelManifestsFresh`) and the static check
 * (`pre-barrel-manifests-complete`) both read THIS list, so adding a manifest
 * here is the one and only registration point.
 *
 * Membership rule: a manifest belongs here iff a barrel reaches it at
 * module-load AND its renderer is barrel-free (so regenerating it before the
 * first barrel import is sound):
 *   - dataViews: a barrel-free static scan (`skipBarrelImport`).
 *   - customUtilities: reads `app.css` by path only (no plugin tree); reachable
 *     at module-load via the ui-kit web barrel (`cn` → `lib/utils.ts` iterates
 *     `CUSTOM_UTILITY_REGISTRY` at top level).
 *   - spaceRamp: reads `app.css` by path only, same as customUtilities;
 *     reachable at module-load via the spacing web barrel (`<Stack>` resolves its
 *     gap class off `RAMP_CLASSES` at top level).
 *   - fieldsEager / eagerTier: barrel-free `skipBarrelImport` tree scans.
 *   - iconManifest: a plain source-file walk for `symbol("…")` / `brand("…")`
 *     literals; the icon sprites server barrel reaches it at module-load.
 *   - companionManifest: a barrel-free `skipBarrelImport` tree scan; the
 *     web-sdk core barrel reaches it at module-load.
 *
 * A manifest whose renderer NEEDS barrels cannot satisfy that rule and does not
 * belong here — see {@link postWebManifests}.
 */
export interface PreBarrelManifest {
  id: string;
  path: (root: string) => string;
  render: (root: string) => string | Promise<string>;
}

export const preBarrelManifests: readonly PreBarrelManifest[] = [
  {
    id: "dataViews",
    path: dataViewsManifestPath,
    render: renderDataViewsManifest,
  },
  {
    id: "customUtilities",
    path: customUtilitiesManifestPath,
    render: renderCustomUtilities,
  },
  {
    id: "spaceRamp",
    path: spaceRampManifestPath,
    render: renderSpaceRamp,
  },
  {
    // Side-effect imports of the fields storage server barrels. The
    // fields/server-capabilities-loader barrel imports it at module-load; its
    // renderer is a barrel-free `skipBarrelImport` tree scan, so regenerating it
    // pre-barrel is sound.
    id: "fieldsEager",
    path: fieldsEagerManifestPath,
    render: renderFieldsEagerManifest,
  },
  {
    // The deferred web plugin tier. The web-sdk core barrel reaches it at
    // module-load (`load-tiers.ts` imports `web-tiers.generated.ts`); its
    // renderer is a barrel-free `skipBarrelImport` tree scan, so regenerating
    // it pre-barrel is sound. Also generated earlier in
    // `regenerateRegistryCodegen` (sharing the registry context — one tree
    // walk, early reachability failure); this entry makes the pre-barrel
    // freshness guard + completeness check cover it, and the phase-2 write is
    // a no-op when phase 1 already ran.
    id: "eagerTier",
    path: eagerTierManifestPath,
    render: renderEagerTierManifest,
  },
  {
    // The icon names the code draws. The sprites server barrel reads it, and its
    // renderer is a barrel-free source walk, so regenerating it pre-barrel is
    // sound.
    id: "iconManifest",
    path: iconManifestPath,
    render: renderIconManifest,
  },
  {
    // Which plugin provides each companion, repo-wide. The web-sdk core barrel
    // reads it (to fail loudly on a companion missing at runtime), and its
    // renderer is a barrel-free tree scan, so regenerating it pre-barrel is
    // sound.
    id: "companionManifest",
    path: companionManifestPath,
    render: renderCompanionManifest,
  },
];

/**
 * Manifests written BETWEEN the web and the server import phases — after the web
 * barrels a renderer must import to see the truth, before the server barrels
 * that read the result.
 *
 * The rule that replaces "renderer must be barrel-free": **no WEB barrel may
 * reach one at module-load.** Bun's ESM cache freezes a module on first
 * `import()`, so a web barrel importing one of these would freeze the PREVIOUS
 * run's copy — the very failure the pre-barrel set exists to prevent, one phase
 * later. `pre-barrel-manifests-complete` enforces both halves: reachable from a
 * barrel ⇒ registered somewhere, and registered here ⇒ unreachable from web.
 *
 * The one entry: `reorderableSlots`, whose set is each plugin's own `slots`
 * declaration plus `meta.reorderable` — facts that exist only once the web
 * barrels have evaluated. Only `reorder/server` reads it (the server cannot see
 * web slots); the web runtime derives the same set from the slot objects.
 */
export const postWebManifests: readonly PreBarrelManifest[] = [
  {
    id: "reorderableSlots",
    path: reorderableSlotsManifestPath,
    render: renderReorderableSlotsManifest,
  },
];

/**
 * Regenerate one manifest if it drifted: render in-memory, then hand the bytes
 * to the shared generated-artifact funnel. Every `generateX` helper writes
 * through that same funnel, so routing a manifest through this is byte-identical
 * to generating it directly. Serves both lists above — the phase a manifest
 * belongs to is which list holds it, not how it is written.
 */
export async function writePreBarrelManifest(
  m: PreBarrelManifest,
  root: string,
): Promise<void> {
  await writeGenerated({ file: m.path(root), content: await m.render(root) });
}
