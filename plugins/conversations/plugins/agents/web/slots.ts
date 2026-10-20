import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { ComponentType } from "react";
import type { Agent } from "../core";
import type { SystemAgentDescriptor } from "./system-agents";

export const Agents = {
  List: defineRenderSlot<{
    id: string;
    component: ComponentType;
  }>({ docLabel: (p) => p.id }),
  ListActions: defineRenderSlot<{
    id: string;
    component: ComponentType;
  }>({ docLabel: (p) => p.id }),
  View: defineRenderSlot<{
    id: string;
    title?: string;
    component: ComponentType<{ agentId: string }>;
  }>({ docLabel: (p) => p.title ?? p.id }),
  AgentActions: defineItemActions<Agent>(),
  SystemAgent: defineRenderSlot<SystemAgentDescriptor>({
    docLabel: (p) => p.name,
  }),
};
