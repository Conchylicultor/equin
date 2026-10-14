import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { originPresentation } from "./internal/presentation";

export { AgentPageRowSchema } from "../shared/resources";
export type { AgentPageRow } from "../shared/resources";

export default {
  description:
    "Agent-origin provenance for pages: presents the exposed `origin` field (Private / Scratch) of the Pages sidebar DataView, so pages written by an automated session land in their own Scratch section of the sidebar.",
  contributions: [originPresentation],
} satisfies PluginDefinition;
