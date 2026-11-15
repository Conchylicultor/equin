import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const SupervisorsList = {
  /**
   * What the Supervisors list shows above its entries (the spend glance,
   * `supervisor-roles/spend`) — contributed, so the list names none of them.
   */
  Head: defineRenderSlot<{
    label: string;
    component: ComponentType;
  }>({ docLabel: (p) => p.label }),
};
