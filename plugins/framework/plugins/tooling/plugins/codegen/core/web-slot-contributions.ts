import { type AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { bundledWebBarrels, recordSlotNaming } from "./evaluated-barrels";

/** One web contribution as its barrel exported it (slot plumbing included). */
export type WebSlotContribution = Record<string, unknown> & {
  _slot?: SlotHandle;
};

/**
 * Every contribution the bundled web barrels make to the named slots, grouped
 * by section, as the build's evaluated records hold them (data: a function is a
 * named stand-in, dropped by `JSON.stringify` like the real one) — the read a post-web manifest (theme declarations, app
 * declarations) projects into data for the SERVER, which cannot see web slots.
 *
 * Generic: keyed on slot id, never naming a contributor. Registry-scoped, like
 * the declaration pass it rides: a plugin the app's composition does not
 * bundle is not loaded by the browser, so its contributions are not collected.
 * A stale slot id throws (resolved up front) instead of matching nothing.
 */
export async function collectWebSlotContributions<S extends string>(
  root: AppPath,
  slotIds: Record<S, string>,
): Promise<Record<S, WebSlotContribution[]>> {
  // The evaluated bundled web barrels, and the registry naming settled over
  // them — so each contribution's slot can be named, with no barrel imported
  // when nothing changed.
  const { ev, refs } = await bundledWebBarrels(root);
  const naming = await recordSlotNaming(root, "registry");
  const sectionBySlotId = new Map<string, S>(
    (Object.entries(slotIds) as [S, string][]).map(([s, id]) => {
      naming.slotNamed(id);
      return [id, s];
    }),
  );
  const out = Object.fromEntries(
    (Object.keys(slotIds) as S[]).map((s) => [s, []]),
  ) as unknown as Record<S, WebSlotContribution[]>;
  for (const ref of refs) {
    const def = ev.barrels.module(ref.path).default as
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
