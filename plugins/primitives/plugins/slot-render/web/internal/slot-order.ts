import type {
  Contribution,
  SealContributions,
  Slot,
} from "@plugins/framework/plugins/web-sdk/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { SlotRender } from "./slots";

function useRegistrationOrder(
  _slot: SlotHandle,
  contributions: readonly Contribution[],
): readonly Contribution[] {
  return contributions;
}

/**
 * A render slot's contributions in its layout order — the order `.Render`
 * would draw them in — for a host that draws them itself from their data (a
 * report, a toolbar building triggers from metadata, a segmented control).
 *
 * This is how such a host is ordered: never by a number on the contribution
 * (`defineSlot` rejects one). The order is the slot's reorder layout
 * (`config/<plugin>/<slotId>.jsonc`, seeded by `./equin build`), applied by the
 * `SlotRender.Order` contribution — reorder's, a companion of this plugin, so
 * it ships wherever slots render. Without one (a test fixture that leaves it
 * out) the contributions keep registration order, as `.Render` does without
 * its list middleware. Draw each one through `renderAsContribution` so its row
 * still gets the item middlewares (isolation, lineage).
 */
export function useSlotOrder<P>(
  slot: Slot<P>,
): readonly SealContributions<P>[] {
  const contributions = slot.useContributions();
  const orders = SlotRender.Order.useContributions();
  if (orders.length > 1) {
    throw new Error(
      `slot-render: ${orders.length} SlotRender.Order contributions — a slot has one layout`,
    );
  }
  // Fixed for the page's lifetime: the one order is a companion of
  // slot-render, loaded with it, so this never switches between renders.
  const useOrder = orders[0]?.useOrder ?? useRegistrationOrder;
  // The sealed contributions carry `_pluginId` + `id`, all an order needs;
  // they lack `_slot`, so widen through `unknown` — and back.
  return useOrder(
    slot,
    contributions as unknown as readonly Contribution[],
  ) as unknown as readonly SealContributions<P>[];
}
