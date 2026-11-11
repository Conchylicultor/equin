import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { bundledWebBarrels, recordSlotNaming } from "./evaluated-barrels";
import type { CodegenPass } from "./codegen-pass";

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
 * Generic: keyed on slot id, never naming a contributor. Bundle-scoped: a
 * plugin the composition does not bundle is not loaded by its browser, so its
 * contributions are not collected — the main composition's bundle by default,
 * or the `bundle` passed (a composition's own manifests). A stale slot id
 * throws (resolved up front) instead of matching nothing.
 */
export async function collectWebSlotContributions<S extends string>(
  pass: CodegenPass,
  slotIds: Record<S, string>,
  bundle?: ReadonlySet<string>,
): Promise<Record<S, WebSlotContribution[]>> {
  // The evaluated bundled web barrels, and the registry naming settled over
  // them — so each contribution's slot can be named, with no barrel imported
  // when nothing changed. The naming is the main registry's: the slots these
  // manifests read are declared by plugins every composition that paints
  // them bundles (theme-engine, apps-core), so a contribution's slot is named
  // the same whichever bundle it is collected for.
  const { ev, refs } = await bundledWebBarrels(pass, bundle);
  const naming = await recordSlotNaming(pass, "registry");
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
