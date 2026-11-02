import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
  defaultRandom,
} from "@plugins/infra/plugins/entities/server";
import {
  claudeCliCallHorizonEntityRef,
  claudeCliCallsEntityRef,
} from "../../core";

// Durable recent-call log for one-shot `claude --print` invocations. The table
// and the `ClaudeCliCall` wire schema both derive from the single
// `claudeCliCallFields` record (core, named by `claudeCliCallsEntityRef`), so a
// column/schema drift is unrepresentable. Trimmed to the most recent N rows
// after every insert.
const claudeCliCalls = defineEntity(claudeCliCallsEntityRef, {
  primaryKey: "id",
  columns: {
    id: { default: defaultRandom() },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [
    index("claude_cli_calls_created_at_idx").on(t.createdAt),
    // The correlation read ("which model calls produced THIS record?") is a
    // point lookup on a table the trim keeps at N rows but never shrinks below
    // it — without the index every such read is a 1000-row scan.
    index("claude_cli_calls_correlation_id_idx").on(t.correlationId),
  ],
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _claudeCliCalls = claudeCliCalls.table;

// The ring horizon: one row (`CLAUDE_CLI_RING_ID`) — the log's size and its
// oldest call — rewritten with every record and trim (`record-call.ts`).
const claudeCliCallHorizon = defineEntity(claudeCliCallHorizonEntityRef, {
  primaryKey: "id",
});
export const _claudeCliCallHorizon = claudeCliCallHorizon.table;
