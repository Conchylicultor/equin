import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { formatTokensCompact } from "@plugins/stats/plugins/cost/core";
import { conversationUsageShape } from "../shared/shape";

export default {
  description:
    "Cost, Tokens and Agents fields on every conversation list whose rows are conversations (the usage extension's exposed fields), sorting and filtering server-side.",
  contributions: [
    FieldPresentation.Register({
      owner: conversationUsageShape.exposure,
      fields: {
        // The money type draws the amount; only the column's place is set here.
        costUsd: { width: "6rem" },
        tokens: { cell: formatTokensCompact, width: "6rem" },
        agentCount: { width: "5rem" },
      },
    }),
  ],
} satisfies PluginDefinition;
