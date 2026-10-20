import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Runtime } from "@plugins/conversations/server";
import { sdkBundledCliServed } from "./internal/bundled-cli";
import { sdkEventsWatcher } from "./internal/consumer";
import { sdkRuntime } from "./internal/sdk-runtime";

export default {
  description:
    "The sdk runtime's desktop half: the `sdk` ConversationRuntime — one Agent SDK process per conversation (bin/agent.ts) in a tmux session it only supervises, commanded over its Unix socket (turn, interrupt, answer, dismiss, shutdown; liveness is `hello`), with Stop as interrupt + a rewinding relaunch — and the consumer that tails each agent's events.jsonl (one kqueue watch, rotation-aware, from the cursor in conversations_ext_sdk_agent) into the conversation's status, the turn ledger and the question relay; and the runtime-sdk.bundled-cli live value (the installed SDK's version and the CLI version it was built for).",
  register: [Runtime.define(sdkRuntime), sdkEventsWatcher],
  contributions: [...sdkBundledCliServed.declare],
} satisfies MachinePluginDefinition;
