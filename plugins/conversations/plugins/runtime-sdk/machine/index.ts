import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Runtime } from "@plugins/conversations/server";
import { adoptTmuxRows } from "./internal/adopt-tmux-rows";
import { sdkBundledCliServed } from "./internal/bundled-cli";
import { sdkEventsWatcher } from "./internal/consumer";
import { sdkRuntime } from "./internal/sdk-runtime";

export default {
  description:
    "The sdk runtime's desktop half: the `sdk` ConversationRuntime — one Agent SDK process per conversation (bin/agent.ts) in a tmux session it only supervises, commanded over its Unix socket (turn, interrupt, answer, dismiss, shutdown; liveness is `hello`), with Stop as interrupt + a rewinding relaunch — and the consumer that tails each agent's events.jsonl (one kqueue watch, rotation-aware, from the cursor in conversations_ext_sdk_agent) into the conversation's status, the turn ledger and the question relay; the runtime-sdk.bundled-cli live value (the installed SDK's version and the CLI version it was built for); and, at boot, the move of every conversation left on the retired tmux runtime onto sdk (its own session killed, the row hibernated — the next Send resumes it from its transcript).",
  register: [Runtime.define(sdkRuntime), sdkEventsWatcher],
  contributions: [...sdkBundledCliServed.declare],
  onReady: async () => {
    await adoptTmuxRows();
  },
} satisfies MachinePluginDefinition;
