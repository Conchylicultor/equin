import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ComponentType } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export interface RowActionContribution {
  id: string;
  component: ComponentType<{ event: JsonlEvent }>;
}

export const JsonlRowActions = {
  Item: defineRenderSlot<RowActionContribution>({ docLabel: (p) => p.id }),
};
