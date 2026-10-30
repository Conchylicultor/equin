import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  EXIT_WHEN_TEXT,
  exitClean,
  flagRaise,
  MANDATE_PUSH_POLICY_TEXT,
  pushPolicy,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";

/** How each push-and-exit grant reads to the agent. */
export const pushAndExitCapabilities = [
  Mandate.Capability({
    cap: pushPolicy,
    describe: (policy) => `Pushing: ${MANDATE_PUSH_POLICY_TEXT[policy]}`,
  }),
  Mandate.Capability({
    cap: exitClean,
    describe: (when) => EXIT_WHEN_TEXT[when],
  }),
  Mandate.Capability({
    cap: flagRaise,
    describe: () =>
      "You may raise a flag for the user with `flag_raise` — caveats, partial outcomes, follow-ups, or a decision only they can make.",
  }),
];
