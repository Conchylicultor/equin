import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ClaudeCodeStatusSchema } from "./status";

/**
 * This backend's last answer to "is Claude Code signed in?",
 * pushed whenever it changes. A schema-bounded scalar. No placeholder: until
 * the first check lands, `useLive` reports it pending. It probes the
 * computer's login, so only the desktop app answers it (`needsMachine`): a reader
 * under an in-browser server gets `unavailable`.
 */
export const claudeCodeStatus = liveValue("claude-code-status", {
  schema: ClaudeCodeStatusSchema,
  needsMachine: { feature: "Checking Claude Code" },
});

/**
 * Check again now — the computer's login changed outside the app (a sign-in
 * from a terminal, a token that expired), which nothing on this machine
 * announces. Answers with the fresh status (also
 * pushed through {@link claudeCodeStatus}).
 */
export const recheckClaudeCode = defineEndpoint({
  route: "POST /api/claude-code/recheck",
  response: ClaudeCodeStatusSchema,
  // It re-runs the probe on the computer.
  needsMachine: { feature: "Checking Claude Code" },
});
