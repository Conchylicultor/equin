import type { ControlSize } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  defineRenderSlot,
  SlotRender,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import { subscribeSlotsDeclared } from "@plugins/framework/plugins/slot-declaration/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { PaneHeaderItem } from "./components/pane-header-item";
import { PaneTitleItem } from "./components/pane-title";
import { paneTitleSlotGuard } from "./components/pane-title-guard";

/**
 * A pane header: ONE reorderable render slot of {@link PaneHeaderItem}, rendered
 * by `PaneChrome` as the header row's overflow-collapsing `AdaptiveBar`.
 */
export type PaneHeaderSlot = RenderSlot<PaneHeaderItem>;

export interface PaneHeaderSlotOptions {
  /**
   * Override the slot-level control density. The pane header's `<Bar>` host
   * already supplies the `sm` baseline, so contributions inherit `sm`
   * automatically; pass this only to override that baseline for every
   * contribution in this header (`RenderSlotConfig.controlSize`; innermost
   * wins).
   */
  controlSize?: ControlSize;
}

// Every header slot this factory has minted, mapped from the runtime-erased
// handle a declaration pass hands back. A Map rather than a Set so the pass's
// `SlotHandle` becomes the typed slot again with no cast — the value IS the
// object the key erased.
const headerSlots = new Map<SlotHandle, PaneHeaderSlot>();

/**
 * Define a pane header slot to be SHARED by several panes:
 * `Pane.define({ actions: WebsiteHeader })` makes that pane's `Actions` be this
 * slot rather than one of its own, so five panes wear one nav from one
 * contribution list and one config directive.
 *
 * Declare it exactly once, in the `slots:` record of the plugin that owns it —
 * and do NOT also list the panes that borrow it, or the declaration pass throws
 * (one slot, two names). A pane with its own auto-minted header is declared the
 * usual way, through the pane: `slots: { canvas: canvasPane }`.
 *
 * The `docLabel` and the control density live here, so a shared header and an
 * auto-minted one are the same kind of slot — `Pane.define` mints through this
 * same factory.
 */
export function definePaneHeaderSlot(
  options?: PaneHeaderSlotOptions,
): PaneHeaderSlot {
  const slot = defineRenderSlot<PaneHeaderItem>({
    docLabel: (p) => p.label ?? p.id,
    controlSize: options?.controlSize,
  });
  headerSlots.set(slot, slot);
  return slot;
}

/**
 * One `title` contribution per DISTINCT pane header — this plugin's own
 * `contributions` array, which `web/index.ts` exposes.
 *
 * A STABLE array rewritten in place on every declaration pass, exactly as
 * `reorder`'s per-slot config registrations are (`reorder/web/internal/
 * config-registrations.ts`), and for the same two reasons: the set is not
 * knowable at module eval (`Pane.define` runs at the module scope of each pane's
 * own plugin, and web plugins load in deferred tiers), and a slot is only NAMED
 * by a declaration pass — which runs inside the plugin registry immediately
 * before it reads every plugin's `contributions`, so re-deriving there is
 * exactly in time, every time.
 *
 * Each header's title item is minted ONCE and reused by every later pass: the
 * registry keeps a slot's list (and spares its readers a re-render) only when
 * its contributions are the same objects as before.
 *
 * De-duped by slot identity, so a header borrowed by five panes gets exactly one
 * title item rather than five.
 *
 * Order: the registry keeps each slot's list in topo-sorted plugin order, and a plugin can only
 * contribute to a pane's header by importing the plugin that owns the pane,
 * which imports this one — so `pane` is always visited first and the title lands
 * FIRST in every header's natural (unconfigured) order, which is where a pane
 * title goes. Anything else is the user's reorder config, as it should be.
 *
 * Built here (not in the barrel) so `web/index.ts` stays loop-free per the
 * barrel-purity rule.
 */
export const paneHeaderContributions: Contribution[] = [];

// The runtime half of "the pane header is ONE slot": a render slot mounted
// inside the title cell throws (see `pane-title-guard.tsx`). It lives in the
// same live array, first, because that array IS this plugin's contributions.
// Not a companion of slot-render: the guard only matters where panes exist,
// and it ships with them.
const titleGuard = SlotRender.ItemMiddleware(paneTitleSlotGuard);

const titleItems = new Map<PaneHeaderSlot, Contribution>();

subscribeSlotsDeclared((naming) => {
  paneHeaderContributions.length = 0;
  paneHeaderContributions.push(titleGuard);
  const seen = new Set<PaneHeaderSlot>();
  for (const entry of naming.declarations()) {
    const header = headerSlots.get(entry.slot);
    if (header === undefined || seen.has(header)) continue;
    seen.add(header);
    let title = titleItems.get(header);
    if (!title) {
      title = header({ id: "title", component: PaneTitleItem, cell: "yield" });
      titleItems.set(header, title);
    }
    paneHeaderContributions.push(title);
  }
});
