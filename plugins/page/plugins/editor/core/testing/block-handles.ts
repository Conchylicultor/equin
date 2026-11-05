import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { join } from "path";
import {
  buildEnrichedTree,
  declareSlotsFromBarrels,
  type CodegenPass,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { type BlockHandle } from "../define-block";

// Canonical slot tokens for the two WEB block slots (see
// plugins/page/plugins/editor/web/slots.ts). Each contribution carries the block
// TYPE as its doc label — `docLabel: (c) => c.block?.type` — which is the join
// key every reader below and in `./index.ts` is built on.
export const WEB_BLOCK_SLOT = "page.editor.block"; // Editor.Block  (web dispatch slot id)
export const WEB_BLOCK_FRAME_SLOT = "page.editor.block-frame"; // Editor.BlockFrame (web dispatch slot id)

/**
 * The two web block SLOT OBJECTS, resolved once per call from the declaration
 * pass that named them, so every loop that reads a block contribution compares
 * by IDENTITY instead of against an id string.
 *
 * Identity is the point, not ergonomics. These loops used to read `c._slotId` —
 * a field that stopped existing when contributions moved to `_slot: SlotHandle`
 * — so the predicate was always true, `handles` was always empty, and two checks
 * verified nothing for as long as it took to notice. There is no field name and
 * no id string left in the loop to go stale: a wrong id fails HERE, at one named
 * line, and a wrong field is a type error.
 *
 * `"registry"` scope, and it costs nothing: every caller has already awaited
 * `buildEnrichedTree`, which awaits this very memoized pass. It is the DECLARING
 * plugin — the editor — that must be in scope, never the candidate plugin whose
 * barrel is read: a contribution carries the same slot OBJECT whether or not its
 * own plugin is disabled, so identity still catches a disabled block type.
 *
 * A miss returns `{ ok: false }` and never throws: the runner awaits every check
 * under `Promise.all` and rethrows, so one throw in here would kill every other
 * check's reporting.
 */
export async function resolveBlockSlots(
  pass: CodegenPass,
): Promise<
  | { ok: true; block: SlotHandle; frame: SlotHandle }
  | { ok: false; message: string }
> {
  const naming = await declareSlotsFromBarrels(pass, "registry");
  const block = naming.findSlot(WEB_BLOCK_SLOT);
  const frame = naming.findSlot(WEB_BLOCK_FRAME_SLOT);
  const missing = [
    block === undefined ? WEB_BLOCK_SLOT : null,
    frame === undefined ? WEB_BLOCK_FRAME_SLOT : null,
  ].filter((id): id is string => id !== null);
  if (block === undefined || frame === undefined) {
    return {
      ok: false,
      message:
        `No slot is declared under ${missing.map((id) => `"${id}"`).join(" / ")} in the ` +
        "registry-scoped declaration pass, so no block contribution could be recognized and " +
        "nothing was verified. An id derives from its declaring plugin's id plus its `slots` " +
        "key, so moving or renaming the editor renames it. This is a check/tooling failure, " +
        "not a clean pass.",
    };
  }
  return { ok: true, block, frame };
}

/**
 * Every registered block handle, with the plugin id that declared it.
 *
 * The handle-reading checks in `check/index.ts` (and `core/markdown.test.ts`) all need the same thing: import each web
 * barrel that contributes `Editor.Block` and read the handles off it. A static
 * source scan cannot recover a handle's fields from
 * `Editor.Block({ match: fooBlock.type, block: fooBlock })`, and ad-hoc marker
 * scanning is banned outright — so importing is the only way, and doing it once
 * is what keeps a new check from re-deriving "which dirs" and drifting on the
 * empty-set failure mode. Barrel modules are Bun-cached, so the repeat imports
 * across checks cost nothing.
 *
 * Fails (`{ ok: false }`) rather than returning an empty list — whether the block
 * slot could not be resolved, the facet yielded no candidate dirs, or those dirs
 * yielded no handles: a check that verified NOTHING must fail loudly rather than
 * pass vacuously. Each caller words the failure in its own terms and appends
 * `reason`, so the three degradations stay distinguishable instead of collapsing
 * into one message that names only the likeliest of them. A caller with no
 * report to write takes {@link loadBlockHandles}, which turns the same three
 * into a throw.
 */
export async function collectBlockHandles(
  pass: CodegenPass,
): Promise<
  | { ok: true; handles: { pluginId: string; handle: BlockHandle<unknown> }[] }
  | { ok: false; reason: string }
> {
  const { root } = pass;
  const tree = await buildEnrichedTree(pass);
  registerBarrelStubs(root);

  const slots = await resolveBlockSlots(pass);
  if (!slots.ok) return { ok: false, reason: slots.message };

  const candidateDirs = new Set<string>();
  for (const [dir, node] of tree.byDir) {
    const facet = getFacet(node, contributionsFacetDef);
    if (!facet) continue;
    for (const c of facet.runtime) {
      if (c.kind === "slot" && c.slotId === WEB_BLOCK_SLOT) {
        if (existsSync(join(dir, "web", "index.ts"))) candidateDirs.add(dir);
        break;
      }
    }
  }
  if (candidateDirs.size === 0) {
    return {
      ok: false,
      reason:
        "no plugin in the enriched tree contributes `Editor.Block` — the barrel-imported " +
        "contributions facet is empty.",
    };
  }

  const handles: { pluginId: string; handle: BlockHandle<unknown> }[] = [];
  for (const dir of candidateDirs) {
    const mod = await importBarrel(join(dir, "web", "index.ts"));
    const def = mod.default as { contributions?: unknown } | undefined;
    if (!Array.isArray(def?.contributions)) continue;
    for (const raw of def.contributions) {
      const c = raw as { _slot?: SlotHandle; block?: BlockHandle<unknown> };
      if (c._slot !== slots.block || !c.block) continue;
      handles.push({
        pluginId: tree.byDir.get(dir)?.id ?? dir,
        handle: c.block,
      });
    }
  }
  // An empty handle set is the SAME degradation as an empty candidate set, one
  // level down: the dirs were found but no contribution off them was recognized
  // as an `Editor.Block`, so the callers below would iterate nothing and report
  // a clean pass having verified nothing. (That is exactly what a stale field
  // read on the contribution did — silently, for as long as it took to notice.)
  if (handles.length === 0) {
    return {
      ok: false,
      reason:
        `${candidateDirs.size} candidate dir(s) were found, but no contribution off them was ` +
        "recognized as an `Editor.Block`.",
    };
  }
  return { ok: true, handles };
}

/**
 * The real block handles, or a THROW.
 *
 * The same enumeration {@link collectBlockHandles} does, for a caller that has
 * no report to write and so has nowhere to put a `{ ok: false }` — the markdown
 * round-trip suite, which must run against the registry the app ships rather
 * than against a hand-written copy of it. It throws with the collector's own
 * `reason` rather than returning an empty list, because a suite handed no
 * handles does not fail: every property over them becomes vacuously true, which
 * is the one outcome worse than a red test.
 *
 * Sorted by declaring plugin id so two runs see the same list. The order decides
 * nothing — `page.editor:block-prefixes-unique` keeps two types off one
 * conversion prefix, and the one real claim overlap (`to-do` over
 * `bulleted-list` on `- [ ] x`) is resolved by `markdown.precedence`, which
 * `claimersOf` sorts on — so this is for reproducibility, not correctness.
 */
export async function loadBlockHandles(
  pass: CodegenPass,
): Promise<BlockHandle<unknown>[]> {
  const collected = await collectBlockHandles(pass);
  if (!collected.ok) {
    throw new Error(
      `[page.editor] No block handles could be read: ${collected.reason}`,
    );
  }
  return collected.handles
    .slice()
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    .map((h) => h.handle);
}
