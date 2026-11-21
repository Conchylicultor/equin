import { describe, expect, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  declarePluginSlots,
  type SlotHandle,
} from "@plugins/framework/plugins/slot-declaration/core";
import {
  reorderDescriptorEntries,
  syncReorderDescriptors,
} from "./descriptors";

// A slot stood up by hand (the `isSlot` contract: a callable carrying `meta`
// and `useContributions`), so the test controls the order slots are made in.
function makeSlot(reorderable = true): SlotHandle {
  const slot = (() => null) as unknown as SlotHandle & {
    useContributions: () => void;
  };
  slot.meta = { kind: "render", reorderable };
  slot.useContributions = () => {};
  return slot;
}

const entriesNow = () =>
  reorderDescriptorEntries.map((e) => ({
    slotId: e.slotId,
    pluginId: e.pluginId,
    name: e.descriptor.name,
  }));

describe("syncReorderDescriptors", () => {
  // plugin-records.verify: the build evaluated the reorder barrel in a process
  // that had already loaded (and declared) other closures, a fresh check did
  // not, and the declared record listed the registrations in another order —
  // a slot keyed `block` stored where a fresh evaluation had one keyed `item`.
  test("the entries are a function of the declared set, not of creation order or earlier passes", () => {
    // Process A: `item` made first, the pass declares in plugin order.
    const itemA = makeSlot();
    const blockA = makeSlot();
    const naming = declarePluginSlots(
      [
        { id: asPluginId("zz.bar"), slots: { item: itemA } },
        { id: asPluginId("aa.editor"), slots: { block: blockA } },
      ],
      "source",
    );
    syncReorderDescriptors(naming);
    const a = entriesNow();

    // Process B: `block` made first, an earlier wider pass stamped a slot this
    // pass does not declare, and the plugins come in the other order.
    const blockB = makeSlot();
    const stray = makeSlot();
    const itemB = makeSlot();
    const notReorderable = makeSlot(false);
    declarePluginSlots(
      [{ id: asPluginId("mm.stray"), slots: { row: stray } }],
      "source",
    );
    syncReorderDescriptors(
      declarePluginSlots(
        [
          { id: asPluginId("aa.editor"), slots: { block: blockB } },
          {
            id: asPluginId("zz.bar"),
            slots: { item: itemB, plain: notReorderable },
          },
        ],
        "source",
      ),
    );
    const b = entriesNow();

    expect(a).toEqual([
      {
        slotId: "aa.editor.block",
        pluginId: asPluginId("aa.editor"),
        name: "block",
      },
      { slotId: "zz.bar.item", pluginId: asPluginId("zz.bar"), name: "item" },
    ]);
    expect(b).toEqual(a);
  });
});
