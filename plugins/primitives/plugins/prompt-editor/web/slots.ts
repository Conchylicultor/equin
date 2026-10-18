import type { ComponentType } from "react";
import type { WorkspaceCapability } from "@plugins/conversations/plugins/workspace/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

export interface PromptEditorActionProps {
  /** Insert text at the caret (or the end when there is none). */
  insertText: (text: string) => void;
  /**
   * Insert text exactly as `insertText` does, then return the whole draft and
   * empty the editor — for an action that inserts and sends in one click.
   */
  takeDraftWith: (text: string) => string;
}

export const PromptEditorSlots = {
  // `requires`: what the conversation's workspace must offer (`[]`: any).
  // `PromptEditor` shows the action only where it does. Required, so a new
  // action must say.
  FloatingAction: defineRenderSlot<{
    component: ComponentType<PromptEditorActionProps>;
    alwaysActive?: boolean;
    requires: readonly WorkspaceCapability[];
  }>(),
};
