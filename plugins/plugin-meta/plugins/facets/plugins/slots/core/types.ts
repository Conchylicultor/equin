import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { SlotCompanions } from "@plugins/framework/plugins/slot-declaration/core";

export interface SlotDef {
  memberName: string;
  slotId: string;
  groupName: string;
  /**
   * Which slot factory defined this slot — `SlotMeta.kind`, read off the slot
   * object itself when barrels are imported. `"render"` for `defineRenderSlot`,
   * `"mount"` for `defineMountSlot`, `"dispatch"` for `defineDispatchSlot`,
   * `"ordered-dispatch"` for `defineOrderedDispatchSlot`, `"wrap"` for
   * `defineWrapperSlot`, `"slot"` for `defineSlot`. In the barrel-free
   * (`skipBarrelImport`) mode it is inferred from the constructor's name in
   * source text, which cannot see `"ordered-dispatch"`.
   */
  kind?: "render" | "mount" | "dispatch" | "ordered-dispatch" | "wrap" | "slot";
  /**
   * The slot accepts companion contributions (`SlotMeta.companions`): `true`,
   * or keyed `{ key, space }` — required only when used. Read off the slot
   * object when barrels are imported, else from the literal `companions:`
   * option at the constructor call, which is all the closure engine (a
   * barrel-free tree) ever sees: a keyed slot whose option it cannot read would
   * leave its companions silently unshipped, so the parse throws instead.
   */
  companions?: SlotCompanions;
  /**
   * Full plugin ids (e.g. `apps/story/pages-integration`) of every plugin that
   * contributes to this specific slot — a per-slot reverse index populated by
   * this facet's `relate()` from the contributions facet's extract data. Empty
   * until `relate()` runs; deduped and sorted.
   */
  contributors: string[];
}

export const slotsFacetDef = defineFacet<SlotDef[]>("slots");
