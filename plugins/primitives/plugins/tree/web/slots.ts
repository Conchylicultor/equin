import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { TreeDisclosureProps } from "../core";

export interface TreeDisclosureContribution {
  component: ComponentType<TreeDisclosureProps>;
}

/**
 * Slot a UI plugin contributes the icon-bearing row's leading disclosure into.
 * `tree` renders the single contributed disclosure directly (which internally
 * dispatches to its own active variant), so this is a plain `defineSlot` — not
 * a render slot: the disclosure needs structural props (icon/hasChildren/…)
 * the `.Render` map-each pattern can't pass. With no contribution, `tree` falls
 * back to its inline default column disclosure (`TreeColumnDisclosure`).
 */
export const Tree = {
  Disclosure: defineSlot<TreeDisclosureContribution>({
    docLabel: () => "Disclosure",
  }),
};
