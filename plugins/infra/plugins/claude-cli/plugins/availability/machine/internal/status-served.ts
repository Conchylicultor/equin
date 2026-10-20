import { serveValue } from "@plugins/network/plugins/live/machine";
import { claudeCodeStatus } from "../../core";
import {
  currentClaudeCodeStatus,
  onClaudeCodeStatusChanged,
} from "../../server/internal/status";

// External, not DB-backed: the truth is a CLI on the host, which no change feed
// observes, so the server half's probe record tells this value when an answer
// differs from the last — for as long as some tab reads it (a fresh
// subscription loads the last answer, so nothing is missed in between).
// Pushed (the `liveValue` default): one small value, the same for every tab,
// read by the always-mounted health dot.
export const claudeCodeStatusServed = serveValue(claudeCodeStatus, {
  source: "external",
  changes: "notified",
  loader: () => currentClaudeCodeStatus(),
  whileSubscribed: (_params, notify) =>
    onClaudeCodeStatusChanged(() => notify()),
});
