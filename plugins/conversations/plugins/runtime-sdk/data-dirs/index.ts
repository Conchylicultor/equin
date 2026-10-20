import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * One directory per SDK agent process, under the namespace of the backend that
 * launched it (`<namespace>/<conversationId>/`): its launch options, its
 * append-only `events.jsonl` and its `agent.log` (its command socket lives in
 * the sockets dir). The events file is how a restarted backend catches up, so
 * it outlives the process; a conversation's transcript (the CLI's own JSONL)
 * remains the durable record.
 */
export const sdkAgentsDir = defineDataDir({
  kind: "state",
  name: "sdk-agents",
  owner: "conversations/runtime-sdk",
  description:
    "Per-conversation SDK agent process state, per launching namespace: the numbered events.jsonl a backend replays from its cursor, the launch options and the agent's log",
  reclaim: { kind: "ttl", ttlDays: 14 },
});

/**
 * Each running SDK agent's pid file, `<namespace>/<conversationId>.pid`,
 * written by the agent itself and removed when it exits. Kept apart from
 * {@link sdkAgentsDir} so one watch of this tree hears only agents starting
 * and exiting (never an events append) — what the running-agents count, every
 * namespace's, is recomputed from.
 */
export const sdkAgentPidsDir = defineDataDir({
  kind: "locks",
  name: "sdk-agents",
  owner: "conversations/runtime-sdk",
  description:
    "One pid file per running SDK agent process, per launching namespace — the running-agents count reads them",
  // A pid means nothing once its process is gone; a live agent's file is
  // re-checked against its pid at every read.
  reclaim: { kind: "restart" },
});

export default [sdkAgentsDir, sdkAgentPidsDir];
