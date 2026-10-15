import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The prompt-submit mailbox: one JSON file per `UserPromptSubmit` hook run —
 * the CLI's own record of the prompt it just submitted — written by the hook
 * the ledger adds to every agent launch and consumed (read, matched, deleted)
 * by the backend that launched the agent. Laid out
 * `<namespace>/<conversationId>.<epoch>.<pid>.json`: the namespace is the
 * launching backend's (`$SINGULARITY_PARENT_HOST`), so each backend reads only
 * its own agents' files and a worktree fork holding a copy of main's
 * conversations never consumes main's.
 *
 * A file nobody consumed belongs to a backend that is gone; the TTL reclaims it.
 */
export const promptSubmitsDir = defineDataDir({
  kind: "state",
  name: "prompt-submits",
  owner: "conversations/turn-ledger",
  description:
    "Prompt-submit records written by each agent's UserPromptSubmit hook, one JSON file per submitted prompt, consumed by the backend that launched the agent to confirm its turn ledger",
  reclaim: { kind: "ttl", ttlDays: 7 },
});

export default [promptSubmitsDir];
