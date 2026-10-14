import type { ComponentType } from "react";
import type { WorkspaceCapability } from "@plugins/conversations/plugins/workspace/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export const Conversation = {
  // Size-owning: every action inherits `sm` density, so contributions omit `size`
  // and all controls (icon or text or chip) snap to one height.
  //
  // `requires`: what the conversation's workspace must offer (`[]`: any). The
  // host shows the action only where it does — a git action never shows on a
  // scratch conversation. Required, so a new action cannot forget to say.
  ActionBar: defineRenderSlot<{
    component: ComponentType;
    requires: readonly WorkspaceCapability[];
  }>({
    controlSize: "sm",
  }),
};
