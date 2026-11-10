import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { ReadPositionSchema } from "./read-position";

// The `conversations_ext_sdk_agent` row: what this backend applied of one SDK
// agent's events.jsonl (the cursor) and the projection it keeps of them
// (reducer.ts's `AgentProjection`), plus where the agent runs and where in its
// events file the cursor was read up to (`eventsPosition`). Written only under
// the agent's row lease (machine/internal/agent-row-lease.ts) — the consumer in
// ONE update per batch of lines, so the cursor never moves past a line whose
// projection was not written, and the position never disagrees with the
// cursor; a launch preparing the row or naming its session.
//
// The consumer's private checkpoint, so it is OUT of the change feed (the server
// barrel's `ExcludeFromChangeFeed`): it moves on every batch an agent writes —
// assistant text, tool calls — and nothing outside the lease reads it (the
// status reconciler asks the runtime's `inspect`, which reads the held row; the
// web reads the conversation row the reconciler updates). Through the feed, each
// batch cost a trigger, a changelog row, a NOTIFY and a routing pass that reached
// no reader (2026-11-08: ~6,500 changes/h on main, route
// `conversations_ext_sdk_agent` ~630 per 5 min). What a live surface does read of
// an agent — the API-error stop — is its own row below, written only when it
// changes.
const sdkAgentShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    worktreePath: textField(),
    cursorSeq: intField(),
    eventsPosition: nullable(jsonField({ schema: ReadPositionSchema })),
    sessionId: nullable(textField()),
    working: boolField(),
    backgroundTasks: intField(),
    statusAt: nullable(dateField()),
    cliVersion: nullable(textField()),
    agentPid: nullable(intField()),
    openRequestId: nullable(textField()),
    openToolUseId: nullable(textField()),
    lastPromptUuid: nullable(textField()),
    turnReplied: boolField(),
    lastAssistantUuid: nullable(textField()),
    rewindAnchorUuid: nullable(textField()),
    turnIds: boolField(),
    cliReady: boolField(),
  },
});

export const sdkAgents = defineExtension(
  _conversations,
  "sdk_agent",
  sdkAgentShape,
  // Rows written before the column existed hold no background task, an agent
  // started before turn ids, and no word of their CLI's initialize (read only
  // by a launch, of the process it just started).
  {
    columns: {
      backgroundTasks: { default: 0 },
      turnIds: { default: false },
      cliReady: { default: false },
    },
  },
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _sdkAgentsTable = sdkAgents.table;

// The `conversations_ext_sdk_agent_stop` row: the part of the projection a live
// surface reads — the runtime-sdk.error-stopped collection (the stop banner, the
// accounts pane) and auto-resume — kept apart from the per-batch checkpoint
// above so the change feed carries a write of it only when one of these moved
// (`STOP_FIELDS`, rows.ts: in the same statement as the batch's cursor). Absent
// until the agent's first `started` names its account.
const sdkAgentStopShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    /** When a failed model request last stopped the agent's turn (reducer.ts). */
    stoppedAt: nullable(dateField()),
    /** The CLI's kind of that failure. */
    stopError: nullable(textField()),
    /** The Claude account the agent runs on — the one a usage limit stopped. */
    account: nullable(textField()),
  },
});

export const sdkAgentStops = defineExtension(
  _conversations,
  "sdk_agent_stop",
  sdkAgentStopShape,
);
export const _sdkAgentStopsTable = sdkAgentStops.table;
