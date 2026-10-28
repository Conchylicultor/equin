import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
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
    describe: () =>
      "When the user asks you to wrap up, you may close this conversation with `exit_clean` once your work landed and there is nothing they need to know.",
  }),
  Mandate.Capability({
    cap: flagRaise,
    describe: () =>
      "You may raise a flag for the user with `flag_raise` — caveats, partial outcomes, follow-ups, or a decision only they can make.",
  }),
];
