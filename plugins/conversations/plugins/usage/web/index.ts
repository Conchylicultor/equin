import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import {
  formatTokensCompact,
  formatUsd,
} from "@plugins/stats/plugins/cost/core";
import { conversationUsageShape } from "../shared/shape";

export default {
  description:
    "Cost, Tokens and Agents fields on every conversation list whose rows are conversations (the usage extension's exposed fields), sorting and filtering server-side.",
  contributions: [
    FieldPresentation.Register({
      owner: conversationUsageShape.exposure,
      fields: {
        costUsd: { cell: formatUsd, width: "6rem", align: "end" },
        tokens: { cell: formatTokensCompact, width: "6rem", align: "end" },
        agentCount: { width: "5rem", align: "end" },
      },
    }),
  ],
} satisfies PluginDefinition;
