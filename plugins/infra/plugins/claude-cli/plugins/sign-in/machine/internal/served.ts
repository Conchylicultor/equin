import { serveValue } from "@plugins/network/plugins/live/machine";
import { claudeSignInFlow } from "../../core";
import { currentSignInFlow, onSignInFlowChanged } from "./flow-state";

// External: the truth is a Claude Code child on the computer, which no change
// feed observes, so every step the run publishes notifies this value.
export const claudeSignInFlowServed = serveValue(claudeSignInFlow, {
  source: "external",
  changes: "notified",
  loader: () => currentSignInFlow(),
  whileSubscribed: (_params, notify) => onSignInFlowChanged(() => notify()),
});
