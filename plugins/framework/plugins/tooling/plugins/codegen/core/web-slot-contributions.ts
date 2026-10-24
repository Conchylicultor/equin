import { existsSync } from "fs";
import { join } from "path";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { importBarrel } from "@plugins/plugin-meta/plugins/barrel-import/core";
import { buildBarrelFreeTree } from "./barrel-free-tree";
import { declareSlotsFromBarrels } from "./slot-declaration-guard";
import { mainBundle } from "./main-bundle";

/** One web contribution as its barrel exported it (slot plumbing included). */
export type WebSlotContribution = Record<string, unknown> & {
  _slot?: SlotHandle;
};

/**
 * Every contribution the bundled web barrels make to the named slots, grouped
 * by section — the read a post-web manifest (theme declarations, app
 * declarations) projects into data for the SERVER, which cannot see web slots.
 *
 * Generic: keyed on slot id, never naming a contributor. Registry-scoped, like
 * the declaration pass it rides: a plugin the app's composition does not
 * bundle is not loaded by the browser, so its contributions are not collected.
 * A stale slot id throws (resolved up front) instead of matching nothing.
 */
export async function collectWebSlotContributions<S extends string>(
  root: string,
  slotIds: Record<S, string>,
): Promise<Record<S, WebSlotContribution[]>> {
  const tree = await buildBarrelFreeTree(root);
  // The one registry declaration pass — it imports every bundled web barrel and
  // stamps every slot's owner, so each contribution's slot can be named.
  const naming = await declareSlotsFromBarrels(root, "registry");
  const bundle = mainBundle(tree, root);
  const sectionBySlotId = new Map<string, S>(
    (Object.entries(slotIds) as [S, string][]).map(([s, id]) => {
      naming.slotNamed(id);
      return [id, s];
    }),
  );
  const out = Object.fromEntries(
    (Object.keys(slotIds) as S[]).map((s) => [s, []]),
  ) as unknown as Record<S, WebSlotContribution[]>;
  for (const node of tree.byDir.values()) {
    if (!bundle.has(node.id)) continue;
    const webIndex = join(node.dir, "web", "index.ts");
    if (!existsSync(webIndex)) continue;
    // An ESM-cache hit: the declaration pass above imported it.
    const mod = await importBarrel(webIndex);
    const def = mod.default as
      { contributions?: WebSlotContribution[] } | undefined;
    for (const c of def?.contributions ?? []) {
      if (c._slot === undefined) continue;
      const lookup = naming.idOf(c._slot);
      if (lookup.kind !== "named") continue;
      const section = sectionBySlotId.get(lookup.id);
      if (section === undefined) continue;
      out[section].push(c);
    }
  }
  return out;
}
