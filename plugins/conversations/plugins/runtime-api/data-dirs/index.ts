import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * One directory per SDK agent process (`<conversationId>/`): its append-only
 * `events.jsonl` (its command socket lives in the sockets dir). The events file is how a
 * restarted backend catches up, so it outlives the process; a conversation's
 * transcript (the CLI's own JSONL) remains the durable record.
 */
export const sdkAgentsDir = defineDataDir({
  kind: "state",
  name: "sdk-agents",
  owner: "conversations/runtime-api",
  description:
    "Per-conversation SDK agent process state: the numbered events.jsonl a backend replays from its cursor",
  reclaim: { kind: "ttl", ttlDays: 14 },
});

export default [sdkAgentsDir];
