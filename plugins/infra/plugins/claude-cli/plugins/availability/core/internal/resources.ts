import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ClaudeCodeStatusSchema } from "./status";

/**
 * This backend's last answer to "is Claude Code installed and signed in?",
 * pushed whenever it changes. A schema-bounded scalar. No placeholder: until
 * the first check lands, `useLive` reports it pending. It probes the
 * computer's CLI, so only the desktop app answers it (`needsMachine`): a reader
 * under an in-browser server gets `unavailable`.
 */
export const claudeCodeStatus = liveValue("claude-code-status", {
  schema: ClaudeCodeStatusSchema,
  needsMachine: { feature: "Checking Claude Code" },
});

/**
 * Check again now — the user just installed or signed in from a terminal,
 * which nothing on this machine announces. Answers with the fresh status (also
 * pushed through {@link claudeCodeStatus}).
 */
export const recheckClaudeCode = defineEndpoint({
  route: "POST /api/claude-code/recheck",
  response: ClaudeCodeStatusSchema,
  // It re-runs the probe on the computer's CLI.
  needsMachine: { feature: "Checking Claude Code" },
});
