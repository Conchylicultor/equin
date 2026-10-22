import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

// The `conversations_ext_sdk_agent` row: what this backend applied of one SDK
// agent's events.jsonl (the cursor) and the projection it keeps of them
// (reducer.ts's `AgentProjection`), plus where the agent runs. Written by the
// consumer in ONE upsert per batch of lines, so the cursor never moves past a
// line whose projection was not written. Server-only: the status reconciler
// reads it through the runtime's `inspect`, the web through the conversation
// row it updates.
const sdkAgentShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    worktreePath: textField(),
    cursorSeq: intField(),
    sessionId: nullable(textField()),
    working: boolField(),
    backgroundTasks: intField(),
    statusAt: nullable(dateField()),
    cliVersion: nullable(textField()),
    agentPid: nullable(intField()),
    openRequestId: nullable(textField()),
    openToolUseId: nullable(textField()),
    lastPromptUuid: nullable(textField()),
    lastPromptText: nullable(textField()),
    turnReplied: boolField(),
    lastAssistantUuid: nullable(textField()),
    rewindAnchorUuid: nullable(textField()),
    account: nullable(textField()),
    limitHitAt: nullable(dateField()),
  },
});

export const sdkAgents = defineExtension(
  _conversations,
  "sdk_agent",
  sdkAgentShape,
  // Rows written before the column existed hold no background task.
  { columns: { backgroundTasks: { default: 0 } } },
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _sdkAgentsTable = sdkAgents.table;
