#!/usr/bin/env bun
// The stop gate: a Claude Code Stop hook that runs every time an app-launched
// agent is about to end its turn, asks the backend whether it may
// (conversations/stop-gate's endpoint: block iff a StopGate contribution blocks
// and no StopWaiver waives), and sends the agent back to work with the reason
// when it may not. Every agent launch carries it (agent-launch's
// `agentLaunchPolicy`; core/hook.ts builds the entry).
//
// Exit contract with the CLI — it FAILS OPEN: a gate is a nudge, never a trap.
//   - `stop_hook_active` (the CLI is already continuing for a block) → allow:
//     no output, exit 0, so one stop attempt is sent back at most once;
//   - block → `{"decision":"block","reason":…}` on stdout, exit 0;
//   - allow → no output, exit 0;
//   - not an app-launched agent, unreadable stdin, a refused request or the
//     backend unreachable for 15 s → stderr, exit 0 (the agent stops).
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import {
  backendBaseUrl,
  fetchStopGate,
  hookOutput,
  stopHookActive,
} from "../shared/client";

function failOpen(message: string): never {
  process.stderr.write(`[stop-gate] ${message} — letting the agent stop\n`);
  process.exit(0);
}

let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);

const conversationId = readEnv("CONVERSATION_ID");
// TEMPORARY: an agent launched before EQUIN_PARENT_URL existed carries only
// EQUIN_PARENT_HOST (a namespace), while this script is read from main's live
// checkout. Delete with the PARENT_HOST key (env-names) once no running agent
// has it.
const legacyParentHost = readEnv("PARENT_HOST");
const parentUrl =
  readEnv("PARENT_URL") ||
  (legacyParentHost ? namespaceUrl(asNamespace(legacyParentHost)) : undefined);
if (!conversationId || !parentUrl) {
  failOpen(
    `${envName("CONVERSATION_ID")} / ${envName("PARENT_URL")} are not set — not an app-launched agent`,
  );
}

try {
  if (stopHookActive(stdin)) process.exit(0);
  const answer = await fetchStopGate({
    baseUrl: backendBaseUrl(parentUrl),
    conversationId,
  });
  const out = hookOutput(answer);
  if (out) process.stdout.write(`${out}\n`);
  process.exit(0);
} catch (err) {
  failOpen(err instanceof Error ? err.message : String(err));
}
