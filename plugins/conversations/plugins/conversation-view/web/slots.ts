import type { ComponentType } from "react";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import type { WorkspaceCapability } from "@plugins/conversations/plugins/workspace/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";

// Every contribution states what its conversation's workspace must offer
// (`requires`, `[]`: any workspace). The host renders it only where the
// workspace has every one — a git surface never shows on a scratch
// conversation. Required, so a new contribution cannot forget to say.
export const Conversation = {
  PromptBar: defineRenderSlot<{
    requires: readonly WorkspaceCapability[];
    section: string;
    sectionOrder?: number;
    component: ComponentType<{ conversation: ConversationRecord }>;
  }>({
    docLabel: (p) => p.section,
  }),
  PromptInput: defineRenderSlot<{
    requires: readonly WorkspaceCapability[];
    component: ComponentType<{ conversation: ConversationRecord }>;
  }>(),
  AbovePromptInput: defineRenderSlot<{
    requires: readonly WorkspaceCapability[];
    component: ComponentType<{ conversation: ConversationRecord }>;
  }>(),
};
