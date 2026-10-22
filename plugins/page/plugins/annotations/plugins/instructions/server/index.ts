import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { instructionsBlock } from "../core";

export { _pageInstructionsDeliveries } from "./internal/tables";
export {
  instructionsInScope,
  instructionsByIds,
  globalInstructions,
  type InstructionsRef,
} from "./internal/scope";
export {
  renderInstructions,
  renderForDelivery,
  markInstructionsDelivered,
  deliveredInstructionIds,
  forgetInstructionsDeliveries,
  instructionsContentHash,
  type RenderedInstructions,
  type InstructionsDelivery,
} from "./internal/delivery";

export default {
  portable: true,
  description:
    "Instructions: registers the card's `data` schema ({ global? }) at the server write boundary, and owns page_instructions_deliveries — which instructions each conversation has received, at which content hash — with the scope queries (instructionsInScope, globalInstructions) and the render-hash-compare delivery helpers the agent-facing page tools and the MCP connect-time instructions consume. Portable, so every host writes the card; the deliveries' nightly retention sweep is the machine half's.",
  contributions: [Editor.BlockData(instructionsBlock)],
} satisfies ServerPluginDefinition;
