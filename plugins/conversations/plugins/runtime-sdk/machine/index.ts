import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Runtime } from "@plugins/conversations/server";
import { sdkAgentDaemon } from "./internal/agent-process";
import { agentProcessesServed } from "./internal/agent-processes";
import { sdkBundledCliServed } from "./internal/bundled-cli";
import { sdkEventsWatcher } from "./internal/consumer";
import { sdkRuntime } from "./internal/sdk-runtime";

export default {
  description:
    "The sdk runtime's desktop half: the `sdk` ConversationRuntime — one Agent SDK process per conversation (bin/agent.ts), started detached (a runtime-sdk.agent daemon instance, followed by its pid file, re-attached after a restart) so it outlives the backend, its paths under this backend's namespace, commanded over its Unix socket (turn, interrupt, answer, dismiss, shutdown; liveness is `hello`), with Stop as interrupt + a rewinding relaunch — and the consumer that tails each agent's events.jsonl (one kqueue watch, rotation-aware, from the cursor in conversations_ext_sdk_agent) into the conversation's status, the turn ledger and the question relay; the runtime-sdk.bundled-cli live value (the installed SDK's version and the CLI version it was built for); and the runtime-sdk.agent-processes live value (the agent processes running here and in every other namespace, from their pid files).",
  register: [Runtime.define(sdkRuntime), sdkEventsWatcher, sdkAgentDaemon],
  contributions: [
    ...sdkBundledCliServed.declare,
    ...agentProcessesServed.declare,
  ],
} satisfies MachinePluginDefinition;
