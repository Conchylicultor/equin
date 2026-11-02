import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import {
  claudeCliCallHorizonServed,
  claudeCliCallsByRecordServed,
  claudeCliCallsForServed,
  claudeCliCallsServed,
} from "./internal/resources";
import { writeRingHorizon } from "./internal/record-call";
import { _claudeCliCallHorizon, _claudeCliCalls } from "./internal/tables";
import { db } from "@plugins/database/server";

export { runClaudePrint, ClaudeCliError } from "./internal/run-claude-print";
export type { RunClaudePrintInput } from "./internal/run-claude-print";
export {
  runClaudeReadOnly,
  READ_ONLY_TOOLS,
} from "./internal/run-claude-read-only";
export type { RunClaudeReadOnlyInput } from "./internal/run-claude-read-only";
export { _claudeCliCalls } from "./internal/tables";
export { recordClaudeCliCall, writeRingHorizon } from "./internal/record-call";
export type { RecordCallInput } from "./internal/record-call";

export default {
  description:
    "One-shot Claude generations for short, latency-tolerant work (runClaudePrint), and runClaudeReadOnly — a turn that may only Read / Grep / Glob one directory and answers with a zod-schema'd structured value. Each is one Agent SDK turn (infra/claude-cli/sdk) on the active Claude account — the one new agents launch on — recorded in the call log.",
  contributions: [
    ...claudeCliCallsServed.declare,
    ...claudeCliCallsForServed.declare,
    ...claudeCliCallsByRecordServed.declare,
    ...claudeCliCallHorizonServed.declare,
    // Calls are looked up by `correlationId`, minted per-record in the consuming
    // domain table. Inherited rows can therefore answer a fork-local correlation
    // query with one of main's calls. The table is also trimmed to the global
    // most-recent 1000 rows on insert rather than by a per-worktree TTL, so a
    // fork carries main's backlog until it makes 1000 calls of its own.
    ExcludeFromFork({
      table: _claudeCliCalls,
      reason:
        "Host-local model-call log; inherited rows answer fork-local correlation lookups with main's calls, and nothing sweeps them per worktree.",
    }),
    // The ring horizon describes the log above; a fork starts with neither,
    // and `onReady` seeds it from the fork's own (empty) log.
    ExcludeFromFork({
      table: _claudeCliCallHorizon,
      reason:
        "Describes the host-local call log, which forks exclude: an inherited horizon would claim main's ring for the fork's.",
    }),
  ],
  // The log may have moved without its horizon (an older build kept none):
  // state it once the database is up, before any reader follows it.
  onReady: () => writeRingHorizon(db),
} satisfies ServerPluginDefinition;
