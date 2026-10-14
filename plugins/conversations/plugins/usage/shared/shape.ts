import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * One conversation's usage totals — the conversation's own transcripts (every
 * session of its anchored chain) plus every sub-agent's, workflow agents
 * included. Stored in the `conversations_ext_usage` extension table
 * (`server/internal/tables.ts`), recomputed from the per-file scan state by
 * `syncConversationUsage`.
 *
 * - `costUsd` — priced with stats/cost's own price table (`priceBucket`).
 * - `tokens` — input + output + cache creation. Cache READS are kept apart
 *   (`cacheReadTokens`): they dwarf the rest and mostly measure context × turns.
 * - `agentCount` — the sub-agents the conversation launched.
 *
 * Token counts are floats (double precision), not ints: a long workflow's cache
 * reads pass the 32-bit integer range.
 *
 * Cost, tokens and agents are EXPOSED to every list whose rows are
 * conversations (`exposes`, `base`): each sorts and filters them server-side,
 * and a conversation not counted yet reads its declared default, 0 (the
 * table's defaults agree — `defineExtension` asserts it).
 */
export const conversationUsageShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    costUsd: floatField({ label: "Cost", default: 0 }),
    tokens: floatField({ label: "Tokens", default: 0 }),
    cacheReadTokens: floatField({ default: 0 }),
    agentCount: intField({ label: "Agents", default: 0 }),
  },
  exposes: {
    parent: conversationsEntityRef,
    name: "usage",
    fields: { costUsd: {}, tokens: {}, agentCount: {} },
  },
});
