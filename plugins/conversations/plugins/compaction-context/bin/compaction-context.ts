#!/usr/bin/env bun
// The compaction hook: a Claude Code SessionStart hook (matcher `compact`) that
// runs right after the agent's context is compacted, asks the backend for what
// plugins had handed the agent and the summary dropped, and prints it as
// `additionalContext`. Every agent launch carries it (agent-launch's
// `agentLaunchHooks`; core/hook.ts builds the entry).
//
// Exit contract with the CLI:
//   - context → the SessionStart JSON on stdout, exit 0;
//   - nothing to restore → no output, exit 0;
//   - a refused request, or the backend unreachable for 40 s → stderr, exit 1
//     (a non-blocking hook error the CLI shows; the session goes on without).
import {
  backendBaseUrl,
  fetchCompactionContext,
  hookOutput,
} from "../shared/client";

function fail(message: string): never {
  process.stderr.write(`[compaction-context] ${message}\n`);
  process.exit(1);
}

const conversationId = process.env.SINGULARITY_CONVERSATION_ID;
const parentHost = process.env.SINGULARITY_PARENT_HOST;
if (!conversationId || !parentHost) {
  fail(
    "SINGULARITY_CONVERSATION_ID / SINGULARITY_PARENT_HOST are not set — not an app-launched agent",
  );
}

// The hook's stdin (session id, source) is not needed: the matcher already
// limits the hook to compactions, and the conversation id names the agent.
for await (const _ of process.stdin) void _;

try {
  const context = await fetchCompactionContext({
    baseUrl: backendBaseUrl(parentHost),
    conversationId,
  });
  const out = hookOutput(context);
  if (out) process.stdout.write(`${out}\n`);
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
